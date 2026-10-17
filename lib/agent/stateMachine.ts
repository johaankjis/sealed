import type { JobStatus } from "../../contracts/job";

// Allowed job status transitions. Anything not listed here is rejected.
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  created: ["payment_pending"],
  payment_pending: ["paid", "payment_failed"],
  paid: ["running"],
  running: ["validating", "execution_failed"],
  validating: ["completed", "rejected", "running", "execution_failed"],
  completed: [],
  rejected: [],
  payment_failed: [],
  execution_failed: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus
  ) {
    super(`Invalid job transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}
