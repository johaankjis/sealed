import type { JobStore } from "./jobStore";

export interface SnapshotBindings {
  bind(snapshotId: string, jobId: string): void;
  unbind(snapshotId: string): void;
}

/**
 * Supplies `authorizeExecution` for lib/sandbox's CreateOSRuntime. The
 * orchestrator binds a snapshot to its job after prepareDataset; the sandbox
 * calls `authorize` before every fork.
 *
 * A job only reaches `running` through executeJob, which re-verifies payment
 * with Stripe and atomically claims `paid -> running`. So "bound job is
 * running and has a Stripe session" means payment was verified and this
 * execution belongs to the claimed lifecycle. Retries within that lifecycle
 * are allowed; anything else is refused.
 */
export class SnapshotAuthorizer implements SnapshotBindings {
  private bindings = new Map<string, string>();

  constructor(private store: JobStore) {}

  bind(snapshotId: string, jobId: string) {
    this.bindings.set(snapshotId, jobId);
  }

  unbind(snapshotId: string) {
    this.bindings.delete(snapshotId);
  }

  authorize = async (snapshotId: string): Promise<boolean> => {
    const jobId = this.bindings.get(snapshotId);
    if (!jobId) return false;
    const job = await this.store.get(jobId);
    return job?.status === "running" && !!job.stripeSessionId;
  };
}
