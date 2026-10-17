import type { QueryJob } from "../../contracts/job";
import type { CheckoutResponse, PaymentProvider } from "../../contracts/payments";
import type { ApprovedResult, ExecutionResult, OutputPolicy } from "../../contracts/results";
import type { SandboxExecutionOptions, SandboxRuntime } from "../../contracts/sandbox";
import { canExecuteJob, validateQuestion } from "../security";
import { checkGeneratedCode } from "./codeCheck";
import type { CodeGenerator, GeneratedAnalysis } from "./codegen";
import type { DatasetCatalog } from "./datasets";
import type { SnapshotBindings } from "./executionAuth";
import { checkGroupSizeEvidence } from "./groupSizes";
import type { JobStore } from "./jobStore";

/** Buyer-safe error codes stored on QueryJob.errorCode. */
export type AgentErrorCode =
  | "dataset_not_found"
  | "sandbox_unavailable"
  | "generation_failed"
  | "execution_failed"
  | "policy_rejected"
  | "payment_not_verified";

/**
 * Sanitized lifecycle events for the security activity feed. Never contains
 * code output, data values, or error messages from the sandbox.
 */
export type AgentEvent =
  | { type: "payment_verified"; jobId: string }
  | { type: "execution_claimed"; jobId: string }
  | { type: "sandbox_prepared"; jobId: string }
  | { type: "attempt_started"; jobId: string; attempt: number }
  | { type: "code_blocked"; jobId: string; attempt: number; violations: string[] }
  | { type: "execution_error"; jobId: string; attempt: number }
  | { type: "policy_rejected"; jobId: string; attempt: number }
  | { type: "policy_approved"; jobId: string; attempt: number }
  | { type: "sandbox_destroyed"; jobId: string }
  | { type: "job_finished"; jobId: string; status: QueryJob["status"] };

export interface AgentDeps {
  store: JobStore;
  datasets: DatasetCatalog;
  payments: PaymentProvider;
  sandbox: SandboxRuntime;
  policy: OutputPolicy;
  codegen: CodeGenerator;
  /** Agent-level budget per attempt and generation retries (not sandbox retries). */
  options?: Partial<SandboxExecutionOptions>;
  /** Lets the sandbox map a snapshot back to its job (see SnapshotAuthorizer). */
  snapshots?: SnapshotBindings;
  /** Must match the OutputPolicy's minimum group size. */
  minGroupSize?: number;
  onEvent?: (event: AgentEvent) => void;
}

// The sandbox bounds each run itself (~35s plus fork/teardown). This outer
// timeout is a backstop and must stay longer, or destroy() would find the
// snapshot still busy.
const DEFAULT_OPTIONS: SandboxExecutionOptions = { timeoutMs: 180_000, maxRetries: 2 };
const DEFAULT_MIN_GROUP_SIZE = 10;
const MAX_QUESTION_LENGTH = 1000;
const MAX_FEEDBACK_LENGTH = 300;

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode | "invalid_request" | "invalid_state",
    message: string
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export async function createJob(
  deps: Pick<AgentDeps, "store" | "datasets">,
  input: { datasetId: string; question: string }
): Promise<QueryJob> {
  const checked = validateQuestion(input.question, { maxLength: MAX_QUESTION_LENGTH });
  if (!checked.ok || !checked.sanitized) {
    throw new AgentError("invalid_request", checked.reason ?? "Invalid question");
  }
  const question = checked.sanitized;
  if (!(await deps.datasets.get(input.datasetId))) {
    throw new AgentError("dataset_not_found", "Unknown dataset");
  }
  return deps.store.create({ datasetId: input.datasetId, question });
}

export async function startCheckout(
  deps: Pick<AgentDeps, "store" | "datasets" | "payments">,
  jobId: string
): Promise<CheckoutResponse> {
  const job = await deps.store.get(jobId);
  if (!job) throw new AgentError("invalid_request", "Unknown job");
  // One checkout per job: lib/payments maps a repeat request to 409.
  if (job.status !== "created") {
    throw new AgentError("invalid_state", "Job is not awaiting checkout");
  }
  const dataset = await deps.datasets.get(job.datasetId);
  if (!dataset) throw new AgentError("dataset_not_found", "Unknown dataset");

  // Price always comes from the trusted catalog, never from the buyer.
  const checkout = await deps.payments.createCheckout({
    jobId,
    amountCents: dataset.priceCents,
    currency: "usd",
  });

  const updated = await deps.store.transition(jobId, "created", "payment_pending", {
    stripeSessionId: checkout.sessionId,
  });
  if (!updated) throw new AgentError("invalid_state", "Job changed during checkout");
  return checkout;
}

async function isPaymentVerified(
  payments: PaymentProvider,
  job: QueryJob,
  sessionId: string
): Promise<boolean> {
  if (job.stripeSessionId !== sessionId) return false;
  const verification = await payments.verifyPayment(sessionId);
  return (
    verification.paid &&
    verification.jobId === job.id &&
    verification.stripeSessionId === sessionId
  );
}

/**
 * Call from the Stripe webhook handler after its signature check. Re-verifies
 * with the payment provider rather than trusting the webhook payload, then
 * moves the job to `paid`. Idempotent: repeat calls return the current job.
 */
export async function confirmPayment(
  deps: Pick<AgentDeps, "store" | "payments" | "onEvent">,
  stripeSessionId: string
): Promise<QueryJob | undefined> {
  const job = await deps.store.findByStripeSession(stripeSessionId);
  if (!job || job.status !== "payment_pending") return job;
  if (!(await isPaymentVerified(deps.payments, job, stripeSessionId))) return job;

  const updated = await deps.store.transition(job.id, "payment_pending", "paid");
  if (updated) deps.onEvent?.({ type: "payment_verified", jobId: job.id });
  return updated ?? (await deps.store.get(job.id));
}

/** Call when the provider reports a failed or expired checkout. */
export async function failPayment(
  deps: Pick<AgentDeps, "store">,
  stripeSessionId: string
): Promise<QueryJob | undefined> {
  const job = await deps.store.findByStripeSession(stripeSessionId);
  if (!job || job.status !== "payment_pending") return job;
  return (
    (await deps.store.transition(job.id, "payment_pending", "payment_failed", {
      errorCode: "payment_not_verified",
    })) ?? (await deps.store.get(job.id))
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Feedback goes back to Claude only, never to the buyer. Truncate so a noisy
// sandbox error cannot flood the prompt.
function feedback(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > MAX_FEEDBACK_LENGTH ? `${flat.slice(0, MAX_FEEDBACK_LENGTH)}…` : flat;
}

function isExecutionResult(value: unknown): value is ExecutionResult {
  const v = value as ExecutionResult | null;
  return !!v && Array.isArray(v.columns) && Array.isArray(v.rows);
}

/**
 * Runs a paid job end to end: atomically claims it, generates code with
 * Claude, executes it in the sandbox, and stores only a policy-approved
 * result. Safe to call more than once; only one caller wins the claim.
 */
export async function executeJob(deps: AgentDeps, jobId: string): Promise<QueryJob> {
  const { store, sandbox, policy, codegen, onEvent } = deps;
  const options = { ...DEFAULT_OPTIONS, ...deps.options };
  const emit = (event: AgentEvent) => onEvent?.(event);

  const existing = await store.get(jobId);
  if (!existing) throw new AgentError("invalid_request", "Unknown job");
  if (existing.status !== "paid") return existing;
  if (!canExecuteJob(existing).allowed) {
    throw new AgentError("payment_not_verified", "Payment could not be verified");
  }

  // Never run without a verified payment, even if the store says "paid".
  if (
    !existing.stripeSessionId ||
    !(await isPaymentVerified(deps.payments, existing, existing.stripeSessionId))
  ) {
    throw new AgentError("payment_not_verified", "Payment could not be verified");
  }

  const claimed = await store.transition(jobId, "paid", "running");
  if (!claimed) return (await store.get(jobId))!;
  emit({ type: "execution_claimed", jobId });

  const finish = async (
    from: "running" | "validating",
    to: "completed" | "rejected" | "execution_failed",
    patch: { result?: ApprovedResult; errorCode?: AgentErrorCode }
  ) => {
    const done = (await store.transition(jobId, from, to, patch))!;
    emit({ type: "job_finished", jobId, status: done.status });
    return done;
  };

  const dataset = await deps.datasets.get(claimed.datasetId);
  if (!dataset) return finish("running", "execution_failed", { errorCode: "dataset_not_found" });

  let snapshotId: string;
  try {
    snapshotId = await sandbox.prepareDataset(dataset.id, dataset.path);
    deps.snapshots?.bind(snapshotId, jobId);
    emit({ type: "sandbox_prepared", jobId });
  } catch {
    return finish("running", "execution_failed", { errorCode: "sandbox_unavailable" });
  }

  try {
    const failures: string[] = [];
    let lastError: AgentErrorCode = "generation_failed";

    for (let attempt = 1; attempt <= options.maxRetries + 1; attempt++) {
      emit({ type: "attempt_started", jobId, attempt });

      let analysis: GeneratedAnalysis;
      try {
        analysis = await codegen.generate({
          question: claimed.question,
          dataset,
          previousFailures: failures,
        });
      } catch {
        lastError = "generation_failed";
        failures.push("The previous response could not be parsed; call submit_analysis with valid input.");
        continue;
      }

      const check = checkGeneratedCode(analysis.code);
      if (!check.ok) {
        emit({ type: "code_blocked", jobId, attempt, violations: check.violations });
        lastError = "generation_failed";
        failures.push(`Code rejected before execution: ${check.violations.join("; ")}`);
        continue;
      }

      let execution: ExecutionResult;
      try {
        execution = await withTimeout(sandbox.execute(snapshotId, analysis.code), options.timeoutMs);
        if (!isExecutionResult(execution)) throw new Error("Sandbox returned malformed result");
      } catch (err) {
        emit({ type: "execution_error", jobId, attempt });
        lastError = "execution_failed";
        failures.push(`Execution failed: ${feedback(err instanceof Error ? err.message : String(err))}`);
        continue;
      }

      await store.transition(jobId, "running", "validating");
      const evidenceProblem = checkGroupSizeEvidence(execution, {
        minGroupSize: deps.minGroupSize ?? DEFAULT_MIN_GROUP_SIZE,
        datasetRowCount: dataset.rowCount,
      });
      let decision: Awaited<ReturnType<OutputPolicy["validate"]>>;
      try {
        // Fail closed without trusted group sizes; the policy is not consulted.
        decision = evidenceProblem
          ? { approved: false, reason: evidenceProblem }
          : await policy.validate(execution);
      } catch {
        // Fail closed: if the policy cannot decide, nothing is released.
        return finish("validating", "execution_failed", { errorCode: "execution_failed" });
      }

      if (decision.approved && decision.result) {
        emit({ type: "policy_approved", jobId, attempt });
        // Columns/rows come from the policy; presentation comes from the model,
        // which never sees the data.
        return finish("validating", "completed", {
          result: {
            ...decision.result,
            summary: analysis.summary,
            chartType: analysis.chartType,
          },
        });
      }

      emit({ type: "policy_rejected", jobId, attempt });
      lastError = "policy_rejected";
      failures.push(`Output policy rejected the result: ${feedback(decision.reason ?? "not approved")}`);

      if (attempt > options.maxRetries) {
        return finish("validating", "rejected", { errorCode: "policy_rejected" });
      }
      await store.transition(jobId, "validating", "running");
    }

    // A policy rejection on the final attempt returns above, so reaching here
    // means the last attempt failed before validation.
    return finish("running", "execution_failed", { errorCode: lastError });
  } finally {
    deps.snapshots?.unbind(snapshotId);
    try {
      await sandbox.destroy(snapshotId);
      emit({ type: "sandbox_destroyed", jobId });
    } catch {
      // Destroy failures must not change the job outcome; the sandbox layer
      // is responsible for reaping leaked sandboxes.
    }
  }
}
