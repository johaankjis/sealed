import { createClient } from "@nodeops-createos/sandbox";
import type { QueryJob } from "../../contracts/job";
import type { PaymentProvider, PaymentVerification } from "../../contracts/payments";
import type { SandboxRuntime } from "../../contracts/sandbox";
import { createPaymentProvider } from "../payments";
import { CreateOSRuntime } from "../sandbox/createos";
import { singleSandboxFromEnv, type SingleSandboxConfig } from "../sandbox/single";
import { AggregateOnlyOutputPolicy, DEFAULT_OUTPUT_POLICY_OPTIONS } from "../security";
import { DEMO_CATALOG, SYNTHETIC_DATASET_REGISTRY } from "./catalog";
import { PROBE_HOST, verifyEgressBlocked } from "./egress";
import { ClaudeCodeGenerator, type CodeGenerator } from "./codegen";
import { StaticDatasetCatalog, type DatasetCatalog } from "./datasets";
import { SnapshotAuthorizer } from "./executionAuth";
import { InMemoryJobStore, type JobStore } from "./jobStore";
import { SequentialSandboxRuntime } from "./sequentialSandbox";
import { confirmPayment, executeJob, failPayment, type AgentDeps } from "./orchestrator";

export { verifyEgressBlocked } from "./egress";

// Server-only composition root. Every API route and the Stripe webhook go
// through getAgentRuntime() so the app has exactly one JobStore.
// Requires a long-lived Node process (`next start`): jobs run in the
// background and CreateOS snapshot handles live in memory.

export class ConfigError extends Error {
  constructor(readonly variable: string) {
    super(`Missing required environment variable ${variable}`);
    this.name = "ConfigError";
  }
}

function requireEnv(name: string, env: Record<string, string | undefined> = process.env): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(name);
  return value;
}

/** Defers construction until first use so routes that don't need a service still work. */
function lazy<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

/** Table names come from the trusted catalog so the runner and the generated SQL agree. */
export function catalogTableNameResolver(catalog: DatasetCatalog) {
  return async (datasetId: string): Promise<string> => {
    const dataset = await catalog.get(datasetId);
    if (!dataset) throw new Error("Unknown dataset");
    return dataset.tableName;
  };
}

export function createSandboxRuntime(
  authorizer: SnapshotAuthorizer,
  catalog: DatasetCatalog
): SandboxRuntime {
  const egress = requireEnv("SEALED_CREATEOS_EGRESS")
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  if (egress.some((rule) => rule.includes(PROBE_HOST))) {
    throw new ConfigError("SEALED_EGRESS_PROBE_HOST (must not be allowlisted)");
  }
  const client = createClient({ apiKey: requireEnv("CREATEOS_SANDBOX_API_KEY"), retry: false });
  return new CreateOSRuntime({
    client,
    shape: requireEnv("SEALED_CREATEOS_SHAPE"),
    rootfs: requireEnv("SEALED_CREATEOS_ROOTFS"),
    egress,
    verifyIsolation: verifyEgressBlocked,
    authorizeExecution: authorizer.authorize,
    resolveTableName: catalogTableNameResolver(catalog),
    options: { timeoutMs: 30_000, maxRetries: 0 },
  });
}

/**
 * `snapshot-fork` (default): a fresh CreateOS VM per job with forks per attempt.
 * `single-synthetic`: Codex's cooperative shared-VM mode. Synthetic demo data
 * only, NOT isolation for hostile code or private customer data.
 * Unknown values fail closed instead of falling back.
 */
export type SandboxMode = "snapshot-fork" | "single-synthetic";

export function sandboxModeFromEnv(env: Record<string, string | undefined> = process.env): SandboxMode {
  const mode = env.SEALED_SANDBOX_MODE?.trim();
  if (!mode || mode === "snapshot-fork") return "snapshot-fork";
  if (mode === "single-synthetic") return mode;
  throw new ConfigError("SEALED_SANDBOX_MODE (expected snapshot-fork or single-synthetic)");
}

/**
 * Single-sandbox wiring. Each job gets a fresh SingleSandboxRuntime, queued so
 * only one lifecycle holds the shared VM at a time. The dataset allowlist is
 * the reviewed synthetic registry; payment authorization is the same
 * SnapshotAuthorizer the snapshot mode uses.
 */
export function createSingleSandboxRuntime(
  authorizer: SnapshotAuthorizer,
  env: Record<string, string | undefined> = process.env,
  client: SingleSandboxConfig["client"] = createClient({
    apiKey: requireEnv("CREATEOS_SANDBOX_API_KEY", env),
    retry: false,
  })
): SandboxRuntime {
  const config: SingleSandboxConfig = {
    client,
    syntheticDatasets: SYNTHETIC_DATASET_REGISTRY,
    authorizeExecution: authorizer.authorize,
    timeoutMs: 30_000,
  };
  // Validates the opt-in and the exact shared sandbox ID up front.
  singleSandboxFromEnv(config, env as NodeJS.ProcessEnv);
  console.warn(
    "[sealed] single-synthetic sandbox mode: cooperative shared VM, synthetic data only; " +
      "not isolation for hostile code or customer data"
  );
  return new SequentialSandboxRuntime(() => singleSandboxFromEnv(config, env as NodeJS.ProcessEnv));
}

/** Per-mode generation retries: each single-sandbox lifecycle allows one execute. */
export function agentRetriesFor(mode: SandboxMode): number {
  return mode === "single-synthetic" ? 0 : 2;
}

export interface AgentRuntime {
  deps: AgentDeps;
  store: JobStore;
}

function buildRuntime(): AgentRuntime {
  const store = new InMemoryJobStore();
  const authorizer = new SnapshotAuthorizer(store);
  const datasets = new StaticDatasetCatalog(DEMO_CATALOG);
  const mode = sandboxModeFromEnv();

  const payments = lazy(() => createPaymentProvider());
  const sandbox = lazy(() =>
    mode === "single-synthetic"
      ? createSingleSandboxRuntime(authorizer)
      : createSandboxRuntime(authorizer, datasets)
  );
  const codegen = lazy(() => new ClaudeCodeGenerator());

  const lazyPayments: PaymentProvider = {
    createCheckout: (request) => payments().createCheckout(request),
    verifyPayment: (sessionId) => payments().verifyPayment(sessionId),
  };
  const lazySandbox: SandboxRuntime = {
    prepareDataset: (id, path) => sandbox().prepareDataset(id, path),
    execute: (snapshotId, code) => sandbox().execute(snapshotId, code),
    destroy: (snapshotId) => sandbox().destroy(snapshotId),
  };
  const lazyCodegen: CodeGenerator = { generate: (request) => codegen().generate(request) };

  const deps: AgentDeps = {
    store,
    datasets,
    payments: lazyPayments,
    sandbox: lazySandbox,
    policy: new AggregateOnlyOutputPolicy(),
    codegen: lazyCodegen,
    snapshots: authorizer,
    minGroupSize: DEFAULT_OUTPUT_POLICY_OPTIONS.minGroupSize,
    options: { maxRetries: agentRetriesFor(mode) },
    onEvent: (event) => console.info("[sealed]", JSON.stringify(event)),
  };
  return { deps, store };
}

// Survives Next.js dev hot reloads.
const globalRef = globalThis as typeof globalThis & { __sealedAgent?: AgentRuntime };

export function getAgentRuntime(): AgentRuntime {
  return (globalRef.__sealedAgent ??= buildRuntime());
}

/** Test hook: replace the process-wide runtime. */
export function setAgentRuntime(runtime: AgentRuntime | undefined) {
  globalRef.__sealedAgent = runtime;
}

const running = new Set<string>();

/**
 * Runs a job in the background. executeJob itself re-verifies payment and
 * atomically claims the job, so calling this for an unpaid or already-claimed
 * job is a no-op.
 */
export function startExecution(jobId: string, runtime = getAgentRuntime()): Promise<void> {
  if (running.has(jobId)) return Promise.resolve();
  running.add(jobId);
  return executeJob(runtime.deps, jobId)
    .then(() => undefined)
    .catch((err: unknown) => {
      // Log only the error class/code; messages may carry provider details.
      const code = (err as { code?: string })?.code ?? (err as Error)?.name ?? "unknown";
      console.error("[sealed] job execution error", jobId, code);
    })
    .finally(() => running.delete(jobId));
}

const RECONCILE_INTERVAL_MS = 5_000;
const lastReconcile = new Map<string, number>();

/**
 * Called on buyer polls. If the job is awaiting payment, asks Stripe (using
 * the session ID stored server-side, never one from the request) whether it
 * has been paid, and starts execution if so. Throttled per job.
 */
export async function reconcilePayment(job: QueryJob, runtime = getAgentRuntime()): Promise<QueryJob> {
  if (job.status !== "payment_pending" || !job.stripeSessionId) return job;
  const now = Date.now();
  if (now - (lastReconcile.get(job.id) ?? 0) < RECONCILE_INTERVAL_MS) return job;
  lastReconcile.set(job.id, now);

  const updated = (await confirmPayment(runtime.deps, job.stripeSessionId)) ?? job;
  if (updated.status === "paid") void startExecution(updated.id, runtime);
  return updated;
}

/**
 * For the Stripe webhook route's `onPaidJobClaimed`, after signature checks.
 * The session must match the one recorded for the job; confirmPayment then
 * re-verifies with Stripe before anything runs.
 */
export async function handleVerifiedPayment(
  verification: PaymentVerification,
  runtime = getAgentRuntime()
): Promise<void> {
  const job = await runtime.store.get(verification.jobId);
  if (!job || job.stripeSessionId !== verification.stripeSessionId) return;
  const updated = await confirmPayment(runtime.deps, verification.stripeSessionId);
  if (updated?.status === "paid") await startExecution(updated.id, runtime);
}

/** For the Stripe webhook route's `onPaymentFailed`. */
export async function handleFailedPayment(
  verification: PaymentVerification,
  runtime = getAgentRuntime()
): Promise<void> {
  const job = await runtime.store.get(verification.jobId);
  if (!job || job.stripeSessionId !== verification.stripeSessionId) return;
  await failPayment(runtime.deps, verification.stripeSessionId);
}

/** The only job shape buyers see: no Stripe session or internal fields. */
export function toBuyerJob(job: QueryJob): QueryJob {
  return {
    id: job.id,
    datasetId: job.datasetId,
    question: job.question,
    status: job.status,
    ...(job.result ? { result: job.result } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
  };
}
