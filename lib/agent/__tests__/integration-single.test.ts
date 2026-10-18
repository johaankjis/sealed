import { afterEach, describe, expect, it, vi } from "vitest";
import { SHARED_SANDBOX_ID, type SingleSandboxConfig } from "../../sandbox/single";
import { AggregateOnlyOutputPolicy } from "../../security";
import { COFFEE_DATASET, SYNTHETIC_DATASET_REGISTRY } from "../catalog";
import { ClaudeCodeGenerator } from "../codegen";
import { StaticDatasetCatalog } from "../datasets";
import { SnapshotAuthorizer } from "../executionAuth";
import { InMemoryJobStore } from "../jobStore";
import type { AgentEvent } from "../orchestrator";
import {
  agentRetriesFor,
  ConfigError,
  createSingleSandboxRuntime,
  sandboxModeFromEnv,
  setAgentRuntime,
} from "../server";
import {
  claudeReturning,
  getJob,
  json,
  REVENUE_BY_CATEGORY,
  simulateAnalysis,
  submitAndPay,
  TOO_GRANULAR,
  waitForTerminal,
} from "./coffeeSim";
import { FakePayments } from "./fakes";
import { POST as createJobRoute } from "../../../app/api/jobs/route";

// Single-sandbox mode end to end: API routes -> Stripe-confirmed job (fake
// provider) -> Claude generation (canned tool_use) -> orchestrator ->
// SequentialSandboxRuntime -> lib/sandbox SingleSandboxRuntime -> fake shared
// VM -> group-size check -> AggregateOnlyOutputPolicy.
//
// The fake VM implements the remote protocol single.ts drives (probe, mkdir
// lease, uploads, supervisor, scoped cleanup). It never runs Python; the
// supervisor step computes the result with simulateAnalysis. It exposes only
// getSandbox attachment: there is no create, fork, pause or destroy.
//
// This file has its own module instance, so single.ts's process-wide lease is
// isolated from other suites. The quarantine test is last on purpose: a
// quarantined lease is never released.

const ENV = {
  SEALED_SANDBOX_MODE: "single-synthetic",
  SEALED_SHARED_SANDBOX_ID: SHARED_SANDBOX_ID,
  CREATEOS_SANDBOX_API_KEY: "test-key-not-real",
};
const LOCK = "/tmp/sealed-shared.lock";

class FakeSharedVM {
  files = new Map<string, string | ArrayBuffer>();
  dirs = new Set<string>();
  attachments = 0;
  supervisorRuns = 0;
  cleanups = 0;
  holders = 0;
  maxHolders = 0;
  supervisorExit = 0;
  supervisorThrows = false;

  readonly box = {
    id: SHARED_SANDBOX_ID,
    data: { status: "running", ingress_enabled: false, created_by: "75ea01ff-cb7f-4ed2-83c1-825a842c3673" },
    getEgress: async () => ({ egress: ["127.0.0.1:9"] }),
    files: {
      upload: async (path: string, data: string | ArrayBuffer) => {
        this.files.set(path, data);
      },
    },
    runCommand: async (cmd: string, args: string[]) => this.run(cmd, args),
  };

  readonly client: SingleSandboxConfig["client"] = {
    getSandbox: async (id) => {
      this.attachments++;
      if (id !== SHARED_SANDBOX_ID) throw new Error("not found");
      return this.box;
    },
  };

  private async run(cmd: string, args: string[]) {
    const ok = (stdout = "") => ({ result: { stdout, stderr: "", exit_code: 0 } });
    const fail = (exit_code = 1) => ({ result: { stdout: "", stderr: "", exit_code } });
    if (cmd !== "python3" || args[0] !== "-I" || args[1] !== "-c") return fail(127);
    const [code, ...rest] = args.slice(2);

    if (code.includes('print("BLOCKED")')) return ok("BLOCKED\n");
    if (code.includes(`os.mkdir('${LOCK}'`)) {
      if (this.dirs.has(LOCK)) return fail();
      this.dirs.add(LOCK);
      this.dirs.add(rest[0]);
      this.holders++;
      this.maxHolders = Math.max(this.maxHolders, this.holders);
      return ok();
    }
    if (code.includes("subprocess.Popen")) {
      this.supervisorRuns++;
      if (this.supervisorThrows) throw new Error("transport detail that must not leak");
      const dir = rest[0];
      const runner = this.files.get(`${dir}/sealed-runner.py`);
      const analysis = this.files.get(`${dir}/sealed-analysis.py`);
      const data = this.files.get(`${dir}/sealed-dataset`);
      const meta = this.files.get(`${dir}/sealed-dataset.json`);
      if (typeof runner !== "string" || !runner.includes(`${dir}/sealed-dataset.json`)) return fail();
      if (typeof analysis !== "string" || !(data instanceof ArrayBuffer) || typeof meta !== "string") return fail();
      if (JSON.parse(meta).tableName !== COFFEE_DATASET.tableName) return fail();
      if (this.supervisorExit !== 0) return fail(this.supervisorExit);
      return ok(simulateAnalysis(analysis, new TextDecoder().decode(data)));
    }
    if (code.includes("shutil.rmtree")) {
      this.cleanups++;
      const dir = rest[0];
      for (const key of [...this.files.keys()]) if (key.startsWith(`${dir}/`)) this.files.delete(key);
      this.dirs.delete(dir);
      this.dirs.delete(LOCK);
      this.holders--;
      return ok();
    }
    return fail();
  }
}

function setup(code: string) {
  const vm = new FakeSharedVM();
  const store = new InMemoryJobStore();
  const authorizer = new SnapshotAuthorizer(store);
  const payments = new FakePayments();
  const claude = claudeReturning(code);
  const events: AgentEvent[] = [];
  const datasets = new StaticDatasetCatalog([COFFEE_DATASET]);
  setAgentRuntime({
    store,
    deps: {
      store,
      datasets,
      payments,
      sandbox: createSingleSandboxRuntime(authorizer, ENV, vm.client),
      policy: new AggregateOnlyOutputPolicy(),
      codegen: new ClaudeCodeGenerator({ client: claude.client, model: "test" }),
      snapshots: authorizer,
      minGroupSize: 10,
      options: { maxRetries: agentRetriesFor("single-synthetic") },
      onEvent: (e) => events.push(e),
    },
  });
  return { vm, store, payments, claude, events };
}

afterEach(() => {
  setAgentRuntime(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sandbox mode selection", () => {
  it("defaults to snapshot-fork and requires an explicit opt-in", () => {
    expect(sandboxModeFromEnv({})).toBe("snapshot-fork");
    expect(sandboxModeFromEnv({ SEALED_SANDBOX_MODE: "snapshot-fork" })).toBe("snapshot-fork");
    expect(sandboxModeFromEnv({ SEALED_SANDBOX_MODE: "single-synthetic" })).toBe("single-synthetic");
    expect(() => sandboxModeFromEnv({ SEALED_SANDBOX_MODE: "single" })).toThrow(ConfigError);
    expect(agentRetriesFor("snapshot-fork")).toBe(2);
    expect(agentRetriesFor("single-synthetic")).toBe(0);
  });

  it("refuses single mode without the exact shared sandbox ID", () => {
    const vm = new FakeSharedVM();
    const authorizer = new SnapshotAuthorizer(new InMemoryJobStore());
    expect(() =>
      createSingleSandboxRuntime(authorizer, { ...ENV, SEALED_SHARED_SANDBOX_ID: "sb-other" }, vm.client)
    ).toThrow("SHARED_MODE_NOT_ENABLED");
    expect(() =>
      createSingleSandboxRuntime(authorizer, { ...ENV, SEALED_SANDBOX_MODE: "snapshot-fork" }, vm.client)
    ).toThrow("SHARED_MODE_NOT_ENABLED");
    expect(vm.attachments).toBe(0);
  });
});

describe("single-sandbox mode: question -> generated Python -> shared VM -> validated result", () => {
  it("completes a Stripe-confirmed coffee job and cleans up its temporary files", async () => {
    const { vm, payments, events } = setup(REVENUE_BY_CATEGORY);
    const job = await submitAndPay("Which drink categories earn the most revenue?", payments);

    const done = await waitForTerminal(job.id);
    expect(done.status).toBe("completed");
    expect(done.result?.columns).toEqual(["drink_category", "revenue"]);
    expect(done.result?.rows[0].drink_category).toBe("latte");
    expect(vm.supervisorRuns).toBe(1);
    expect(vm.cleanups).toBe(1);
    expect(vm.files.size).toBe(0);
    expect(vm.dirs.size).toBe(0);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["policy_approved", "sandbox_destroyed"]));
  });

  it("never attaches to the shared VM before payment is verified", async () => {
    const { vm, payments, claude } = setup(REVENUE_BY_CATEGORY);
    const job = await submitAndPay("Which drink categories earn the most revenue?", payments, false);
    expect((await getJob(job.id)).status).toBe("payment_pending");
    expect(vm.attachments).toBe(0);
    expect(claude.calls).toHaveLength(0);
  });

  it("runs concurrent paid jobs one at a time instead of failing them as busy", async () => {
    const { vm, payments } = setup(REVENUE_BY_CATEGORY);
    const a = await submitAndPay("Which drink categories earn the most revenue?", payments);
    const b = await submitAndPay("Revenue by drink category please", payments);

    const [doneA, doneB] = await Promise.all([waitForTerminal(a.id), waitForTerminal(b.id)]);
    expect([doneA.status, doneB.status]).toEqual(["completed", "completed"]);
    expect(vm.maxHolders).toBe(1);
    expect(vm.supervisorRuns).toBe(2);
    expect(vm.dirs.size).toBe(0);
  });

  it("maps a remote timeout to execution_failed, cleans up, and frees the VM for the next job", async () => {
    const { vm, payments } = setup(REVENUE_BY_CATEGORY);
    vm.supervisorExit = 124;
    const slow = await submitAndPay("Which drink categories earn the most revenue?", payments);
    const failed = await waitForTerminal(slow.id);
    expect(failed.status).toBe("execution_failed");
    expect(failed.errorCode).toBe("execution_failed");
    expect(failed.result).toBeUndefined();
    expect(vm.supervisorRuns).toBe(1); // maxRetries: 0, one execute per lifecycle
    expect(vm.dirs.size).toBe(0);

    vm.supervisorExit = 0;
    const next = await submitAndPay("Which drink categories earn the most revenue?", payments);
    expect((await waitForTerminal(next.id)).status).toBe("completed");
  });

  it("still applies the output policy: a too-granular result is rejected without rows", async () => {
    const { vm, payments } = setup(TOO_GRANULAR);
    const job = await submitAndPay("Revenue for every store, day, and hour", payments);
    const done = await waitForTerminal(job.id);
    expect(done.status).toBe("rejected");
    expect(done.result).toBeUndefined();
    expect(vm.dirs.size).toBe(0);
  });

  it("refuses fixture bytes that do not match the reviewed synthetic digest", async () => {
    const original = SYNTHETIC_DATASET_REGISTRY[COFFEE_DATASET.id];
    SYNTHETIC_DATASET_REGISTRY[COFFEE_DATASET.id] = { ...original, sha256: "0".repeat(64) };
    try {
      const { vm, payments } = setup(REVENUE_BY_CATEGORY);
      const job = await submitAndPay("Which drink categories earn the most revenue?", payments);
      const done = await waitForTerminal(job.id);
      expect(done.status).toBe("execution_failed");
      expect(done.errorCode).toBe("sandbox_unavailable");
      expect(vm.attachments).toBe(0);
    } finally {
      SYNTHETIC_DATASET_REGISTRY[COFFEE_DATASET.id] = original;
    }
  });

  it("reports why preparation failed: stage, adapter code and the failing provider call", async () => {
    const { vm, payments, events } = setup(REVENUE_BY_CATEGORY);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vm.box.data.status = "paused";
    const job = await submitAndPay("Which drink categories earn the most revenue?", payments);
    const done = await waitForTerminal(job.id);
    vm.box.data.status = "running";

    expect(done.status).toBe("execution_failed");
    expect(done.errorCode).toBe("sandbox_unavailable");
    expect(done).not.toHaveProperty("stage");
    expect(events).toContainEqual({
      type: "stage_failed", jobId: job.id, stage: "sandbox_prepare", code: "SHARED_ATTACHMENT_REJECTED",
    });
    const logged = info.mock.calls.filter((c) => c[0] === "[sealed] createos").map((c) => JSON.parse(c[1] as string));
    expect(logged).toContainEqual({ op: "attach", outcome: "ok", status: "paused", ingress: false });
    expect(JSON.stringify(info.mock.calls)).not.toContain(ENV.CREATEOS_SANDBOX_API_KEY);
    expect(vm.files.size).toBe(0);
  });

  it("refuses new jobs with 503 before checkout when single mode is misconfigured", async () => {
    setAgentRuntime(undefined);
    vi.stubEnv("SEALED_SANDBOX_MODE", "single-synthetic");
    vi.stubEnv("SEALED_SHARED_SANDBOX_ID", SHARED_SANDBOX_ID);
    vi.stubEnv("CREATEOS_SANDBOX_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await createJobRoute(json({ datasetId: COFFEE_DATASET.id, question: "Which drink categories earn the most?" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Service is not configured" });
    expect((globalThis as { __sealedAgent?: unknown }).__sealedAgent).toBeUndefined();
  });

  // Keep last: quarantine holds the process-wide lease for this module.
  it("quarantines on transport ambiguity and fails later jobs closed without hanging", async () => {
    const { vm, payments } = setup(REVENUE_BY_CATEGORY);
    vm.supervisorThrows = true;
    const first = await submitAndPay("Which drink categories earn the most revenue?", payments);
    const failed = await waitForTerminal(first.id);
    expect(failed.status).toBe("execution_failed");
    expect(JSON.stringify(failed)).not.toContain("transport detail");
    expect(vm.cleanups).toBe(0);
    expect(vm.dirs.has(LOCK)).toBe(true);

    vm.supervisorThrows = false;
    const second = await submitAndPay("Which drink categories earn the most revenue?", payments);
    const blocked = await waitForTerminal(second.id);
    expect(blocked.status).toBe("execution_failed");
    expect(blocked.errorCode).toBe("sandbox_unavailable");
    expect(vm.supervisorRuns).toBe(1);
  });
});
