import { createClient } from "@nodeops-createos/sandbox";
import type { QueryJob } from "../../contracts/job";
import type { PaymentProvider, PaymentVerification } from "../../contracts/payments";
import type { SandboxRuntime } from "../../contracts/sandbox";
import { createPaymentProvider } from "../payments";
import { CreateOSRuntime, type CreateOSSandbox } from "../sandbox/createos";
import { AggregateOnlyOutputPolicy, DEFAULT_OUTPUT_POLICY_OPTIONS } from "../security";
import { DEMO_CATALOG } from "./catalog";
import { ClaudeCodeGenerator, type CodeGenerator } from "./codegen";
import { StaticDatasetCatalog } from "./datasets";
import { SnapshotAuthorizer } from "./executionAuth";
import { InMemoryJobStore, type JobStore } from "./jobStore";
import { confirmPayment, executeJob, failPayment, type AgentDeps } from "./orchestrator";

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

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigError(name);
  return value;
}

/** Defers construction until first use so routes that don't need a service still work. */
function lazy<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

const PROBE_HOST = process.env.SEALED_EGRESS_PROBE_HOST ?? "1.1.1.1";
const PROBE_SCRIPT = [
  "import socket",
  "try:",
  `    socket.create_connection((${JSON.stringify(PROBE_HOST)}, 443), timeout=5).close()`,
  "    print('OPEN')",
  "except OSError:",
  "    print('BLOCKED')",
].join("\n");

/**
 * Empirical egress check run inside each sandbox before data or code is
 * uploaded: a connection to a host outside the allowlist must fail. This is
 * evidence for one destination, not a proof of zero egress.
 */
export async function verifyEgressBlocked(sandbox: CreateOSSandbox): Promise<void> {
  const { result } = await sandbox.runCommand("python3", ["-I", "-c", PROBE_SCRIPT], {
    timeoutMs: 20_000,
    retry: false,
  });
  if (result.exit_code !== 0 || result.stdout.trim() !== "BLOCKED") {
    throw new Error("Sandbox egress probe was not blocked");
  }
}

export function createSandboxRuntime(authorizer: SnapshotAuthorizer): SandboxRuntime {
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
    options: { timeoutMs: 30_000, maxRetries: 0 },
  });
}

export interface AgentRuntime {
  deps: AgentDeps;
  store: JobStore;
}

function buildRuntime(): AgentRuntime {
  const store = new InMemoryJobStore();
  const authorizer = new SnapshotAuthorizer(store);

  const payments = lazy(() => createPaymentProvider());
  const sandbox = lazy(() => createSandboxRuntime(authorizer));
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
    datasets: new StaticDatasetCatalog(DEMO_CATALOG),
    payments: lazyPayments,
    sandbox: lazySandbox,
    policy: new AggregateOnlyOutputPolicy(),
    codegen: lazyCodegen,
    snapshots: authorizer,
    minGroupSize: DEFAULT_OUTPUT_POLICY_OPTIONS.minGroupSize,
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
