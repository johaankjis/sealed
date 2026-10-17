import type { ApprovedResult } from "./results";

export type JobStatus =
  | "created"
  | "payment_pending"
  | "paid"
  | "running"
  | "validating"
  | "completed"
  | "rejected"
  | "payment_failed"
  | "execution_failed";

export interface QueryJob {
  id: string;
  datasetId: string;
  question: string;
  status: JobStatus;
  stripeSessionId?: string;
  result?: ApprovedResult;
  errorCode?: string;
}
