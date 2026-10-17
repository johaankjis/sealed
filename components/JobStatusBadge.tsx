import type { JobStatus } from "../contracts/job";
import { statusLabel } from "./job-status";

const TONE: Record<JobStatus, string> = {
  created: "idle",
  payment_pending: "warn",
  paid: "info",
  running: "info",
  validating: "info",
  completed: "ok",
  rejected: "bad",
  payment_failed: "bad",
  execution_failed: "bad",
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`badge badge-${TONE[status]}`} role="status">
      <span className="badge-dot" aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}
