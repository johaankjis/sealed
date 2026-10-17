import type { JobStatus } from "../contracts/job";

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "rejected",
  "payment_failed",
  "execution_failed",
]);

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

const LABELS: Record<JobStatus, string> = {
  created: "Created",
  payment_pending: "Awaiting payment",
  paid: "Paid",
  running: "Analyzing",
  validating: "Validating result",
  completed: "Completed",
  rejected: "Rejected by safety check",
  payment_failed: "Payment failed",
  execution_failed: "Analysis failed",
};

export function statusLabel(status: JobStatus): string {
  return LABELS[status] ?? status;
}

/** Ordered lifecycle steps shown as a tracker on the job page. */
export const LIFECYCLE_STEPS: ReadonlyArray<{
  key: string;
  label: string;
  activeOn: ReadonlyArray<JobStatus>;
}> = [
  { key: "question", label: "Question asked", activeOn: ["created", "payment_pending", "paid", "running", "validating", "completed"] },
  { key: "payment", label: "Payment confirmed", activeOn: ["paid", "running", "validating", "completed"] },
  { key: "analysis", label: "Sandbox analysis", activeOn: ["running", "validating", "completed"] },
  { key: "review", label: "Safety validation", activeOn: ["validating", "completed"] },
  { key: "result", label: "Result delivered", activeOn: ["completed"] },
];

export const FAILED_GUIDANCE: Partial<Record<JobStatus, string>> = {
  rejected:
    "The safety check rejected this result — usually because the question would expose individual records or identifiers. Try a broader, aggregate question.",
  payment_failed:
    "Payment did not go through. No analysis was run and nothing was charged for compute. You can retry payment from your job link.",
  execution_failed:
    "The analysis run failed inside the sandbox. No partial or unvalidated output is shown. Please try again or rephrase the question.",
};

export function failedStepIndex(status: JobStatus): number {
  if (status === "payment_failed" || status === "payment_pending") return 1;
  if (status === "rejected" || status === "execution_failed") return 3;
  return -1;
}
