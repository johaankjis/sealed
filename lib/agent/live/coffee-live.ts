/**
 * Manual, billable live smoke test: one genuine Claude-generated analysis of
 * the synthetic coffee dataset, run in CreateOS through the real orchestrator,
 * lib/sandbox runtime, group-size check, and lib/security output policy.
 *
 *   node --experimental-transform-types lib/agent/live/coffee-live.ts --run [--cli-auth]
 *   node --experimental-transform-types lib/agent/live/coffee-live.ts --run [--cli-auth] --cleanup sl-<8 hex>
 *
 * Safety (see lib/agent/live/README.md):
 * - Does nothing without --run. Synthetic bundled fixture only.
 * - rootfs must be a ready template owned by the account (DuckDB baked in);
 *   nothing is installed at runtime and egress stays restricted.
 * - Payment: a single in-process synthetic session, approved only here. This
 *   file is not imported by any route; the web app always verifies via Stripe.
 * - Cleanup destroys only sandboxes this run created (tracked IDs, its random
 *   name prefix, or forks of those) and never one that existed beforehand.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// The app's sources use extensionless relative imports (bundler resolution).
// Plain Node needs them mapped to .ts files.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!/^(\.{1,2}\/|file:)/.test(specifier) || /\.[cm]?[jt]s$/.test(specifier)) throw err;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // try the next candidate
        }
      }
      throw err;
    }
  },
});

const USAGE = `Usage: node --experimental-transform-types lib/agent/live/coffee-live.ts --run [--cli-auth] [--cleanup sl-<8 hex>]
Required env: ANTHROPIC_API_KEY, SEALED_CREATEOS_ROOTFS (ready template), SEALED_CREATEOS_EGRESS,
              CREATEOS_SANDBOX_API_KEY (unless --cli-auth)
Optional env: SEALED_CREATEOS_SHAPE, SEALED_LIVE_QUESTION, SEALED_LIVE_TIMEOUT_MS, SEALED_LIVE_REPORT,
              SEALED_CLAUDE_MODEL, SEALED_EGRESS_PROBE_HOST`;

const support = await import("./support");
const argv = process.argv.slice(2);
const cleanupIndex = argv.indexOf("--cleanup");
const cleanupPrefix = cleanupIndex === -1 ? undefined : argv[cleanupIndex + 1];

let config: ReturnType<typeof support.parseLiveConfig> | undefined;
try {
  if (cleanupPrefix !== undefined) {
    // Cleanup-only mode needs CreateOS auth but none of the analysis settings.
    if (!argv.includes("--run")) throw new support.LiveUsageError("Refusing to start without --run.");
    if (!/^sl-[0-9a-f]{8}$/.test(cleanupPrefix)) {
      throw new support.LiveUsageError("--cleanup expects a run prefix like sl-1a2b3c4d");
    }
    if (!argv.includes("--cli-auth") && !process.env.CREATEOS_SANDBOX_API_KEY?.trim()) {
      throw new support.LiveUsageError("CREATEOS_SANDBOX_API_KEY is required (or pass --cli-auth)");
    }
  } else {
    config = support.parseLiveConfig(argv, process.env);
  }
} catch (err) {
  if (!(err instanceof support.LiveUsageError)) throw err;
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

const { createClient } = await import("@nodeops-createos/sandbox");
const authHeaders = argv.includes("--cli-auth")
  ? {
      // Existing CreateOS CLI login (refresh first with `createos whoami`).
      "X-Access-Token": JSON.parse(readFileSync(join(homedir(), ".createos/.oauth"), "utf8")).access_token,
    }
  : undefined;
const client = createClient({
  ...(authHeaders ? { authHeaders } : { apiKey: process.env.CREATEOS_SANDBOX_API_KEY!.trim() }),
  retry: false,
  timeoutMs: 60_000,
});

const events: Array<{ at: string; event: string; detail: unknown }> = [];
function record(event: string, detail: unknown = {}) {
  const entry = { at: new Date().toISOString(), event, detail };
  events.push(entry);
  console.log(JSON.stringify(entry));
}

const WAIT = { timeoutMs: 120_000 };
type Destroyable = Pick<import("./support").SdkSandbox, "refresh" | "status" | "destroy" | "waitUntilDestroyed">;

/** Destroys exactly the planned IDs; returns false if any could not be confirmed destroyed. */
async function destroyAll(ids: string[], handles: Map<string, Destroyable>) {
  let ok = true;
  for (const id of ids) {
    const box = handles.get(id);
    if (!box) {
      record("cleanup_unresolved", { id });
      ok = false;
      continue;
    }
    try {
      await box.refresh();
      if (box.status !== "destroyed") {
        if (box.status !== "destroying") await box.destroy();
        await box.waitUntilDestroyed(WAIT);
      }
      record("final_status", { id, status: box.status });
    } catch (err) {
      record("cleanup_failed", { id, kind: (err as Error)?.name });
      ok = false;
    }
  }
  return ok;
}

if (cleanupPrefix !== undefined) {
  // Recovery for an interrupted run: only that run's prefix and its forks.
  const listing = await client.listSandboxes();
  const roots = listing.filter((box) => box.name?.startsWith(`${cleanupPrefix}-`)).map((box) => box.id);
  const ids = support.planCleanup({ preexisting: new Set(), created: roots, listing, prefix: cleanupPrefix });
  record("cleanup_plan", { prefix: cleanupPrefix, ids });
  const ok = await destroyAll(ids, new Map<string, Destroyable>(listing.map((box) => [box.id, box])));
  process.exit(ok ? 0 : 1);
}

const cfg = config!;
const [{ COFFEE_DATASET }, { generateCoffeeCsv }, { ClaudeCodeGenerator }, { StaticDatasetCatalog },
  { SnapshotAuthorizer }, { verifyEgressBlocked }, { InMemoryJobStore }, orchestrator,
  { CreateOSRuntime }, security] = await Promise.all([
  import("../catalog"), import("../demo/coffee"), import("../codegen"), import("../datasets"),
  import("../executionAuth"), import("../egress"), import("../jobStore"), import("../orchestrator"),
  import("../../sandbox/createos"), import("../../security"),
]);

const runId = randomBytes(4).toString("hex");
const prefix = `sl-${runId}`;
record("run_started", {
  prefix, rootfs: cfg.rootfs, shape: cfg.shape, egress: cfg.egress,
  timeoutMs: cfg.timeoutMs, question: cfg.question, auth: cfg.auth.kind,
});

// --- Read-only preflight; nothing is created if any check fails. ---
if (readFileSync(COFFEE_DATASET.path, "utf8") !== generateCoffeeCsv()) {
  record("preflight_failed", { reason: "fixture does not match the synthetic generator" });
  process.exit(1);
}
const templates = await client.templates.list();
const template = templates.find((t) => t.id === cfg.rootfs || t.name === cfg.rootfs);
if (!template || template.status !== "ready") {
  record("preflight_failed", {
    reason: "SEALED_CREATEOS_ROOTFS must name a ready template you built (DuckDB preinstalled)",
    found: template ? template.status : "missing",
  });
  process.exit(1);
}
const baseline = await client.listSandboxes();
const preexisting = new Set(baseline.map((box) => box.id));
record("preflight_passed", { template: template.name, preexistingSandboxes: preexisting.size });

// --- Wiring: real orchestrator, runtime, and policy; synthetic payment only. ---
const store = new InMemoryJobStore();
const datasets = new StaticDatasetCatalog([COFFEE_DATASET]);
const authorizer = new SnapshotAuthorizer(store);
const payments = new support.SyntheticRunPayments(`live_synthetic_${runId}`);
const tracking = new support.TrackingClient(client, prefix, record);
const runtime = new CreateOSRuntime({
  client: tracking,
  shape: cfg.shape,
  rootfs: cfg.rootfs,
  egress: cfg.egress,
  // Runs on the snapshot VM and on every fork before any data or code upload.
  verifyIsolation: async (box) => {
    await support.assertEgressMatches(tracking.created.get(box.id), cfg.egress);
    record("egress_config_verified", { id: box.id, egress: cfg.egress });
    await verifyEgressBlocked(box);
    record("egress_probe_blocked", { id: box.id });
  },
  authorizeExecution: authorizer.authorize,
  resolveTableName: async (id) => (await datasets.get(id))!.tableName,
  options: { timeoutMs: cfg.timeoutMs, maxRetries: 0 },
});
const claude = new ClaudeCodeGenerator();
const deps: Parameters<typeof orchestrator.executeJob>[0] = {
  store,
  datasets,
  payments,
  sandbox: runtime,
  policy: new security.AggregateOnlyOutputPolicy(),
  codegen: {
    async generate(request) {
      const analysis = await claude.generate(request);
      // Claude's output is code written from the schema only; safe to log.
      record("claude_generated", analysis);
      return analysis;
    },
  },
  snapshots: authorizer,
  minGroupSize: security.DEFAULT_OUTPUT_POLICY_OPTIONS.minGroupSize,
  // One attempt; outer deadline covers VM readiness, probe, run and cleanup.
  options: { maxRetries: 0, timeoutMs: cfg.timeoutMs + 150_000 },
  onEvent: (event) => record("agent_event", event),
};

let cleaned: Promise<boolean> | undefined;
function cleanup(): Promise<boolean> {
  return (cleaned ??= (async () => {
    let ok = true;
    try {
      await runtime.dispose();
    } catch {
      record("runtime_dispose_failed");
      ok = false;
    }
    let listing: Awaited<ReturnType<typeof client.listSandboxes>> = [];
    try {
      listing = await client.listSandboxes();
    } catch {
      record("cleanup_listing_failed");
      ok = false;
    }
    const ids = support.planCleanup({ preexisting, created: tracking.created.keys(), listing, prefix });
    record("cleanup_plan", { ids });
    const handles = new Map<string, Destroyable>(listing.map((box) => [box.id, box]));
    // Prefer the handles this run holds over freshly listed copies.
    for (const [id, box] of tracking.created) handles.set(id, box);
    return (await destroyAll(ids, handles)) && ok;
  })());
}

function writeReport() {
  if (cfg.reportPath) writeFileSync(cfg.reportPath, JSON.stringify(events, null, 2) + "\n");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    record("interrupted", { signal, recoverWith: `--run --cleanup ${prefix}` });
    void cleanup().finally(() => {
      writeReport();
      process.exit(130);
    });
  });
}

let exitCode = 1;
try {
  const job = await orchestrator.createJob(deps, { datasetId: COFFEE_DATASET.id, question: cfg.question });
  payments.bind(job.id);
  await store.transition(job.id, "created", "payment_pending", { stripeSessionId: payments.sessionId });
  const paid = await orchestrator.confirmPayment(deps, payments.sessionId);
  if (paid?.status !== "paid") throw new Error("synthetic payment was not confirmed");

  const done = await orchestrator.executeJob(deps, job.id);
  // Only a policy-approved result is ever reported; nothing else from the sandbox is.
  record("job_finished", {
    status: done.status,
    errorCode: done.errorCode,
    ...(done.status === "completed" && done.result ? { approvedResult: done.result } : {}),
  });
  if (done.status === "completed") exitCode = 0;
} catch (err) {
  record("run_failed", { kind: (err as Error)?.name, code: (err as { code?: string })?.code });
} finally {
  if (!(await cleanup())) {
    record("cleanup_incomplete", { recoverWith: `--run --cleanup ${prefix}` });
    exitCode = 1;
  }
  writeReport();
}
process.exit(exitCode);
