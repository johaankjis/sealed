import { randomUUID } from "node:crypto";
import type { JobStatus, QueryJob } from "../../contracts/job";
import { canTransition, InvalidTransitionError } from "./stateMachine";

export type JobPatch = Partial<
  Pick<QueryJob, "stripeSessionId" | "result" | "errorCode">
>;

/**
 * Persistence for query jobs. `transition` must be atomic: it only succeeds
 * when the job is currently in `from`, so two concurrent callers can never
 * both claim the same paid job. A Postgres implementation should use
 * `UPDATE ... WHERE id = $1 AND status = $2 RETURNING *`.
 */
export interface JobStore {
  create(input: { datasetId: string; question: string }): Promise<QueryJob>;
  get(id: string): Promise<QueryJob | undefined>;
  findByStripeSession(sessionId: string): Promise<QueryJob | undefined>;
  /** Returns the updated job, or undefined if the job was not in `from`. */
  transition(
    id: string,
    from: JobStatus,
    to: JobStatus,
    patch?: JobPatch
  ): Promise<QueryJob | undefined>;
}

/** In-memory store for the MVP and tests. Single-process only. */
export class InMemoryJobStore implements JobStore {
  private jobs = new Map<string, QueryJob>();

  async create(input: { datasetId: string; question: string }) {
    const job: QueryJob = {
      id: randomUUID(),
      datasetId: input.datasetId,
      question: input.question,
      status: "created",
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  async get(id: string) {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  async findByStripeSession(sessionId: string) {
    for (const job of this.jobs.values()) {
      if (job.stripeSessionId === sessionId) return { ...job };
    }
    return undefined;
  }

  async transition(
    id: string,
    from: JobStatus,
    to: JobStatus,
    patch: JobPatch = {}
  ) {
    if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
    // Check-and-set runs synchronously, so it is atomic within one process.
    const job = this.jobs.get(id);
    if (!job || job.status !== from) return undefined;
    const updated: QueryJob = { ...job, ...patch, status: to };
    this.jobs.set(id, updated);
    return { ...updated };
  }
}
