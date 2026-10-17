import { describe, expect, it } from "vitest";

import { canExecuteJob } from "../execution-gate";
import type { QueryJob } from "../../../contracts/job";

function job(status: QueryJob["status"], stripeSessionId?: string): QueryJob {
  return {
    id: "job_1",
    datasetId: "ds_1",
    question: "Total sales by month?",
    status,
    stripeSessionId,
  };
}

describe("canExecuteJob", () => {
  it("allows execution for a paid job with a verified session reference", () => {
    const decision = canExecuteJob(job("paid", "cs_test_123"));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("rejects a paid job with no Stripe session reference", () => {
    const decision = canExecuteJob(job("paid"));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Stripe session reference");
  });

  it("rejects execution before payment is verified", () => {
    for (const status of ["created", "payment_pending"] as const) {
      const decision = canExecuteJob(job(status, "cs_test_123"));
      expect(decision.allowed, status).toBe(false);
      expect(decision.reason, status).toBeTruthy();
    }
  });

  it("rejects re-execution of already-executed jobs", () => {
    for (const status of [
      "running",
      "validating",
      "completed",
      "rejected",
      "payment_failed",
      "execution_failed",
    ] as const) {
      const decision = canExecuteJob(job(status, "cs_test_123"));
      expect(decision.allowed, status).toBe(false);
    }
  });
});
