import type { JobStatus, QueryJob } from "../../contracts/job";

/**
 * Execution gate for the payment boundary.
 *
 * Security rule: no paid query may execute before payment is
 * verified, and no job may execute twice. The job state machine
 * (lib/agent) must call this before spending sandbox or model
 * budget on a job.
 *
 * Only the exact transition out of `paid` is allowed: `paid` is
 * only ever set by verified payment verification (Stripe webhook
 * on lib/payments' side), so it is the single trustworthy signal.
 */

export interface ExecutionGateDecision {
  allowed: boolean;
  reason?: string;
}

const STATUS_REJECTIONS: Record<JobStatus, string> = {
  created: "job has not entered the payment flow",
  payment_pending: "payment has not been verified yet",
  paid: "unreachable: paid jobs are handled above",
  running: "job has already been claimed for execution",
  validating: "job has already executed",
  completed: "job has already completed",
  rejected: "job was rejected",
  payment_failed: "payment failed for this job",
  execution_failed: "job execution already failed",
};

export function canExecuteJob(job: QueryJob): ExecutionGateDecision {
  if (job.status === "paid") {
    if (!job.stripeSessionId) {
      return {
        allowed: false,
        reason:
          "paid job is missing its verified Stripe session reference; " +
          "payment cannot be considered verified",
      };
    }
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: STATUS_REJECTIONS[job.status],
  };
}
