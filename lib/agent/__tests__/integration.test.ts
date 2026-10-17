import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryJob } from "../../../contracts/job";
import { POST as checkoutRoute } from "../../../app/api/checkout/route";
import { GET as getJobRoute } from "../../../app/api/jobs/[id]/route";
import { POST as createJobRoute } from "../../../app/api/jobs/route";
import { CreateOSRuntime, type CreateOSClient, type CreateOSSandbox } from "../../sandbox/createos";
import { AggregateOnlyOutputPolicy } from "../../security";
import { COFFEE_DATASET } from "../catalog";
import { ClaudeCodeGenerator } from "../codegen";
import { StaticDatasetCatalog } from "../datasets";
import { SnapshotAuthorizer } from "../executionAuth";
import { InMemoryJobStore } from "../jobStore";
import type { AgentEvent } from "../orchestrator";
import { catalogTableNameResolver, setAgentRuntime, verifyEgressBlocked } from "../server";
import { FakePayments } from "./fakes";

// End to end through the real API routes, ClaudeCodeGenerator, orchestrator,
// lib/sandbox CreateOSRuntime, and lib/security AggregateOnlyOutputPolicy.
// Simulated: the Anthropic HTTP call (canned tool_use), Stripe (FakePayments),
// and the CreateOS VM. Generated Python must never run on the host, so the
// fake VM checks that the runner, dataset, and generated code were uploaded,
// then computes what that code's SQL would return from the uploaded CSV.

const REVENUE_BY_CATEGORY = `rows = con.execute(
    "SELECT drink_category, ROUND(SUM(revenue), 2) AS revenue, COUNT(*) AS n "
    "FROM dataset GROUP BY drink_category HAVING COUNT(*) >= 10 ORDER BY revenue DESC"
).fetchall()
result = {
    "columns": ["drink_category", "revenue"],
    "rows": [{"drink_category": r[0], "revenue": r[1]} for r in rows],
    "groupSizes": [r[2] for r in rows],
}`;

// Per store, per day, per hour: groups far below the minimum size.
const TOO_GRANULAR = `rows = con.execute(
    "SELECT store || ' ' || CAST(sale_date AS VARCHAR) || ' ' || CAST(hour AS VARCHAR) AS slot, SUM(revenue), COUNT(*) "
    "FROM dataset GROUP BY 1"
).fetchall()
result = {"columns": ["slot", "revenue"], "rows": [{"slot": r[0], "revenue": r[1]} for r in rows], "groupSizes": [r[2] for r in rows]}`;

// Passes the static checks but reports no group sizes in `result`.
const NO_GROUP_SIZES = `rows = con.execute("SELECT drink_category, SUM(revenue), COUNT(*) FROM dataset GROUP BY 1").fetchall()
result = {"columns": ["drink_category", "revenue"], "rows": [{"drink_category": r[0], "revenue": r[1]} for r in rows]}
groupSizes = None`;

function parseCsv(text: string): Array<Record<string, string>> {
  const [header, ...lines] = text.trim().split("\n");
  const cols = header.split(",");
  return lines.map((line) => {
    const cells = line.match(/("[^"]*"|[^,]+)/g)!.map((c) => c.replace(/^"|"$/g, ""));
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

/** Stand-in for the SQL each canned script runs, evaluated in the fake VM. */
function simulateAnalysis(code: string, csv: string): string {
  const records = parseCsv(csv);
  const group = (key: (r: Record<string, string>) => string) => {
    const groups = new Map<string, { revenue: number; n: number }>();
    for (const r of records) {
      const g = groups.get(key(r)) ?? { revenue: 0, n: 0 };
      g.revenue += Number(r.revenue);
      g.n += 1;
      groups.set(key(r), g);
    }
    return [...groups.entries()];
  };
  if (code === REVENUE_BY_CATEGORY) {
    const rows = group((r) => r.drink_category).sort((a, b) => b[1].revenue - a[1].revenue);
    return JSON.stringify({
      columns: ["drink_category", "revenue"],
      rows: rows.map(([k, v]) => ({ drink_category: k, revenue: Math.round(v.revenue * 100) / 100 })),
      groupSizes: rows.map(([, v]) => v.n),
    });
  }
  if (code === TOO_GRANULAR) {
    const rows = group((r) => `${r.store} ${r.sale_date} ${r.hour}`).slice(0, 150);
    return JSON.stringify({
      columns: ["slot", "revenue"],
      rows: rows.map(([k, v]) => ({ slot: k, revenue: v.revenue })),
      groupSizes: rows.map(([, v]) => v.n),
    });
  }
  if (code === NO_GROUP_SIZES) {
    const rows = group((r) => r.drink_category);
    return JSON.stringify({
      columns: ["drink_category", "revenue"],
      rows: rows.map(([k, v]) => ({ drink_category: k, revenue: v.revenue })),
    });
  }
  throw new Error("unexpected analysis code");
}

type VMState = "running" | "paused" | "forking" | "destroyed";

// Mirrors the CreateOSSandbox surface lib/sandbox/createos.ts uses, including
// its state rules: fork() returns a clone still in `forking`, and commands
// only run once waitUntilRunning() has been awaited.
class FakeVM implements CreateOSSandbox {
  static created: FakeVM[] = [];
  /** Exit code the next analysis run reports (e.g. 137 for a timeout kill). */
  static analysisExitCode = 0;
  stored = new Map<string, string | ArrayBuffer>();
  state: VMState;
  ranAnalysis = false;
  files = {
    upload: async (path: string, data: string | ArrayBuffer) => {
      this.assertRunning();
      this.stored.set(path, data);
    },
  };

  constructor(readonly id: string, state: VMState = "running") {
    this.state = state;
    FakeVM.created.push(this);
  }

  get destroyed() {
    return this.state === "destroyed";
  }

  private assertRunning() {
    if (this.state !== "running") throw new Error(`VM ${this.id} is ${this.state}`);
  }

  async runCommand(cmd: string, args: string[]) {
    this.assertRunning();
    if (cmd === "python3" && args[1] === "-c") {
      // Egress probe: this VM has no outbound network.
      return { result: { stdout: "BLOCKED\n", stderr: "", exit_code: 0 } };
    }
    if (cmd === "timeout" && args.at(-1) === "/tmp/sealed-runner.py") {
      if (!args.includes("--signal=KILL")) throw new Error("runner must be time-bounded");
      const runner = this.stored.get("/tmp/sealed-runner.py");
      const code = this.stored.get("/tmp/sealed-analysis.py");
      const data = this.stored.get("/tmp/sealed-dataset");
      const meta = this.stored.get("/tmp/sealed-dataset.json");
      if (typeof runner !== "string" || !runner.includes("/tmp/sealed-dataset.json")) throw new Error("no runner");
      if (typeof code !== "string" || !(data instanceof ArrayBuffer) || typeof meta !== "string") {
        throw new Error("missing inputs");
      }
      // The runner creates the table named in the metadata; the generated
      // SQL targets the catalog's tableName, so the two must agree.
      const { tableName, format } = JSON.parse(meta) as { tableName: string; format: string };
      if (format !== "csv" || tableName !== COFFEE_DATASET.tableName || !code.includes(`FROM ${tableName}`)) {
        return { result: { stdout: "", stderr: "", exit_code: 1 } };
      }
      this.ranAnalysis = true;
      if (FakeVM.analysisExitCode !== 0) {
        return { result: { stdout: "", stderr: "", exit_code: FakeVM.analysisExitCode } };
      }
      const stdout = simulateAnalysis(code, new TextDecoder().decode(data));
      return { result: { stdout, stderr: "", exit_code: 0 } };
    }
    return { result: { stdout: "", stderr: "", exit_code: 127 } };
  }

  async pause() {
    this.assertRunning();
    this.state = "paused";
  }
  async waitUntilPaused() {}

  async fork() {
    if (this.state !== "paused") throw new Error("only paused snapshots can be forked");
    const child = new FakeVM(`${this.id}-child${FakeVM.created.length}`, "forking");
    for (const [k, v] of this.stored) child.stored.set(k, v);
    return child;
  }

  async waitUntilRunning() {
    if (this.state === "forking") this.state = "running";
    this.assertRunning();
  }

  async destroy() {
    this.state = "destroyed";
  }
  async waitUntilDestroyed() {}
}

const fakeClient: CreateOSClient = {
  async createSandbox() {
    return new FakeVM(`vm${FakeVM.created.length}`);
  },
};

function claudeReturning(code: string) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        calls.push(params);
        return {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "submit_analysis",
              input: { code, summary: "Revenue by drink category.", chartType: "bar" },
            },
          ],
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

function setup(code: string) {
  FakeVM.created = [];
  FakeVM.analysisExitCode = 0;
  const store = new InMemoryJobStore();
  const authorizer = new SnapshotAuthorizer(store);
  const payments = new FakePayments();
  const claude = claudeReturning(code);
  const events: AgentEvent[] = [];
  const datasets = new StaticDatasetCatalog([COFFEE_DATASET]);
  const sandbox = new CreateOSRuntime({
    client: fakeClient,
    shape: "s-1vcpu-1gb",
    rootfs: "sealed-duckdb:test",
    egress: ["pypi.org"],
    verifyIsolation: verifyEgressBlocked,
    authorizeExecution: authorizer.authorize,
    resolveTableName: catalogTableNameResolver(datasets),
    options: { timeoutMs: 30_000, maxRetries: 0 },
  });
  setAgentRuntime({
    store,
    deps: {
      store,
      datasets,
      payments,
      sandbox,
      policy: new AggregateOnlyOutputPolicy(),
      codegen: new ClaudeCodeGenerator({ client: claude.client, model: "test" }),
      snapshots: authorizer,
      minGroupSize: 10,
      options: { maxRetries: 1 },
      onEvent: (e) => events.push(e),
    },
  });
  return { store, payments, claude, events };
}

const json = (body: unknown) =>
  new Request("http://test/api", { method: "POST", body: JSON.stringify(body) });

async function getJob(id: string): Promise<QueryJob> {
  const res = await getJobRoute(new Request(`http://test/api/jobs/${id}`), { params: Promise.resolve({ id }) });
  return res.json();
}

async function submitAndPay(question: string, payments: FakePayments, pay = true) {
  const created = await createJobRoute(json({ datasetId: COFFEE_DATASET.id, question }));
  expect(created.status).toBe(201);
  const job = (await created.json()) as QueryJob;
  const checkout = await checkoutRoute(json({ jobId: job.id }));
  expect(checkout.status).toBe(200);
  payments.paid = pay;
  return job;
}

async function waitForTerminal(id: string): Promise<QueryJob> {
  let job!: QueryJob;
  await vi.waitFor(
    async () => {
      job = await getJob(id);
      expect(["completed", "rejected", "execution_failed"]).toContain(job.status);
    },
    { timeout: 3000, interval: 20 }
  );
  return job;
}

afterEach(() => setAgentRuntime(undefined));

describe("question -> generated Python -> sandbox -> validated result", () => {
  it("completes the coffee demo with a policy-approved aggregate", async () => {
    const { payments, claude, events } = setup(REVENUE_BY_CATEGORY);
    const job = await submitAndPay("Which drink categories earn the most revenue?", payments);

    const done = await waitForTerminal(job.id);
    expect(done.status).toBe("completed");
    expect(done.result?.chartType).toBe("bar");
    expect(done.result?.columns).toEqual(["drink_category", "revenue"]);
    expect(done.result?.rows[0].drink_category).toBe("latte");
    expect(done.result?.rows).toHaveLength(7);
    expect(done).not.toHaveProperty("stripeSessionId");

    // Claude saw the schema and the sandbox's table name, never the data path.
    const prompt = JSON.stringify(claude.calls[0].messages);
    expect(prompt).toContain("drink_category (VARCHAR)");
    expect(prompt).toContain("Table: dataset");
    expect(prompt).not.toContain("fixtures");

    // The real dataset bytes went into the VM; every VM was destroyed.
    const root = FakeVM.created[0];
    const uploaded = new Uint8Array(root.stored.get("/tmp/sealed-dataset") as ArrayBuffer);
    expect(Buffer.from(uploaded).equals(readFileSync(COFFEE_DATASET.path))).toBe(true);
    expect(FakeVM.created.every((vm) => vm.destroyed)).toBe(true);
    expect(FakeVM.created.some((vm) => vm.ranAnalysis)).toBe(true);
    expect(events.map((e) => e.type)).toContain("policy_approved");
  });

  it("never executes before payment is verified", async () => {
    const { payments, claude } = setup(REVENUE_BY_CATEGORY);
    const job = await submitAndPay("Which drink categories earn the most revenue?", payments, false);

    const polled = await getJob(job.id);
    expect(polled.status).toBe("payment_pending");
    expect(claude.calls).toHaveLength(0);
    expect(FakeVM.created).toHaveLength(0);
  });

  it("rejects a too-granular breakdown and returns no rows", async () => {
    const { payments } = setup(TOO_GRANULAR);
    const job = await submitAndPay("Revenue for every store, day, and hour", payments);

    const done = await waitForTerminal(job.id);
    expect(done.status).toBe("rejected");
    expect(done.errorCode).toBe("policy_rejected");
    expect(done.result).toBeUndefined();
    expect(FakeVM.created.every((vm) => vm.destroyed)).toBe(true);
  });

  it("fails closed when the sandbox result has no group sizes", async () => {
    const { payments } = setup(NO_GROUP_SIZES);
    const job = await submitAndPay("Revenue by drink category", payments);

    const done = await waitForTerminal(job.id);
    expect(done.status).toBe("rejected");
    expect(done.result).toBeUndefined();
  });

  it("reports execution_failed when the sandbox kills a runaway script", async () => {
    const { payments } = setup(REVENUE_BY_CATEGORY);
    FakeVM.analysisExitCode = 137;
    const job = await submitAndPay("Which drink categories earn the most revenue?", payments);

    const done = await waitForTerminal(job.id);
    expect(done.status).toBe("execution_failed");
    expect(done.result).toBeUndefined();
    expect(FakeVM.created.every((vm) => vm.destroyed)).toBe(true);
  });

  it("validates API input", async () => {
    setup(REVENUE_BY_CATEGORY);
    expect((await createJobRoute(json({ datasetId: "nope", question: "hello there" }))).status).toBe(404);
    expect((await createJobRoute(json({ datasetId: COFFEE_DATASET.id }))).status).toBe(400);
    expect((await checkoutRoute(json({ jobId: "missing" }))).status).toBe(404);
    expect((await getJob("missing")) as unknown).toEqual({ error: "Job not found" });
  });
});
