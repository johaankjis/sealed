import { describe, expect, it } from "vitest";
import { confirmPayment, createJob, executeJob, failPayment, startCheckout } from "../orchestrator";
import { SnapshotAuthorizer } from "../executionAuth";
import type { QueryJob } from "../../../contracts/job";
import { StaticDatasetCatalog } from "../datasets";
import { dataset, execution, makeDeps } from "./fakes";

async function paidJob() {
  const ctx = makeDeps();
  const job = await createJob(ctx.deps, { datasetId: "retail", question: "Average order by region?" });
  const checkout = await startCheckout(ctx.deps, job.id);
  await confirmPayment(ctx.deps, checkout.sessionId);
  return { ...ctx, jobId: job.id, sessionId: checkout.sessionId };
}

describe("job creation and payment", () => {
  it("rejects unknown datasets and empty questions", async () => {
    const { deps } = makeDeps();
    await expect(createJob(deps, { datasetId: "nope", question: "x" })).rejects.toThrow("Unknown dataset");
    await expect(createJob(deps, { datasetId: "retail", question: "  " })).rejects.toThrow();
  });

  it("charges the dataset price and moves to payment_pending", async () => {
    const { deps } = makeDeps();
    const job = await createJob(deps, { datasetId: "retail", question: "q" });
    const checkout = await startCheckout(deps, job.id);
    const stored = await deps.store.get(job.id);
    expect(stored?.status).toBe("payment_pending");
    expect(stored?.stripeSessionId).toBe(checkout.sessionId);
    expect(deps.payments.createCalls[0]).toEqual({ jobId: job.id, amountCents: 500, currency: "usd" });
  });

  describe("checkout retry while payment_pending", () => {
    async function pendingJob() {
      const ctx = makeDeps();
      ctx.deps.payments.paid = false;
      const job = await createJob(ctx.deps, { datasetId: "retail", question: "q" });
      const checkout = await startCheckout(ctx.deps, job.id);
      return { ...ctx, job, checkout };
    }

    it("returns the same verified, unpaid session", async () => {
      const { deps, job, checkout } = await pendingJob();
      expect(await startCheckout(deps, job.id)).toEqual(checkout);
      expect(await startCheckout(deps, job.id)).toEqual(checkout);
      const stored = await deps.store.get(job.id);
      expect(stored?.status).toBe("payment_pending");
      expect(stored?.stripeSessionId).toBe(checkout.sessionId);
      expect(new Set(deps.payments.createCalls.map((c) => c.amountCents))).toEqual(new Set([500]));
    });

    it("refuses a session that is already paid and leaves the job for confirmPayment", async () => {
      const { deps, job } = await pendingJob();
      deps.payments.paid = true;
      await expect(startCheckout(deps, job.id)).rejects.toThrow("already paid");
      expect(deps.payments.createCalls).toHaveLength(1);
      expect((await deps.store.get(job.id))?.status).toBe("payment_pending");
    });

    it("refuses when the provider hands back a different session", async () => {
      const { deps, job, checkout } = await pendingJob();
      deps.payments.idempotent = false;
      await expect(startCheckout(deps, job.id)).rejects.toThrow("session mismatch");
      expect((await deps.store.get(job.id))?.stripeSessionId).toBe(checkout.sessionId);
    });

    it("refuses before requesting checkout when the stored session belongs to another job", async () => {
      const { deps, job } = await pendingJob();
      deps.payments.sessions.set(`cs_${job.id}`, "other-job");
      await expect(startCheckout(deps, job.id)).rejects.toThrow("session mismatch");
      expect(deps.payments.createCalls).toHaveLength(1);
    });

    it("refuses a pending job with no recorded session", async () => {
      const { deps } = makeDeps();
      const job = await createJob(deps, { datasetId: "retail", question: "q" });
      await deps.store.transition(job.id, "created", "payment_pending");
      await expect(startCheckout(deps, job.id)).rejects.toThrow("no checkout session");
      expect(deps.payments.createCalls).toHaveLength(0);
    });

    it("refuses if the job moves on while the retry is in flight", async () => {
      const { deps, job } = await pendingJob();
      const create = deps.payments.createCheckout.bind(deps.payments);
      deps.payments.createCheckout = async (request) => {
        const result = await create(request);
        await deps.store.transition(job.id, "payment_pending", "payment_failed");
        return result;
      };
      await expect(startCheckout(deps, job.id)).rejects.toThrow("Job changed during checkout");
    });
  });

  it.each([
    ["paid", ["payment_pending", "paid"]],
    ["running", ["payment_pending", "paid", "running"]],
    ["completed", ["payment_pending", "paid", "running", "validating", "completed"]],
    ["payment_failed", ["payment_pending", "payment_failed"]],
    ["execution_failed", ["payment_pending", "paid", "running", "execution_failed"]],
  ] as const)("refuses checkout for a %s job", async (_label, path) => {
    const { deps } = makeDeps();
    const job = await createJob(deps, { datasetId: "retail", question: "q" });
    let from: QueryJob["status"] = "created";
    for (const to of path) {
      await deps.store.transition(job.id, from, to, { stripeSessionId: `cs_${job.id}` });
      from = to;
    }
    await expect(startCheckout(deps, job.id)).rejects.toThrow("not awaiting checkout");
    expect(deps.payments.createCalls).toHaveLength(0);
  });

  it("only marks paid when the provider verifies payment", async () => {
    const { deps } = makeDeps();
    deps.payments.paid = false;
    const job = await createJob(deps, { datasetId: "retail", question: "q" });
    const { sessionId } = await startCheckout(deps, job.id);
    expect((await confirmPayment(deps, sessionId))?.status).toBe("payment_pending");
    deps.payments.paid = true;
    expect((await confirmPayment(deps, sessionId))?.status).toBe("paid");
    expect((await confirmPayment(deps, sessionId))?.status).toBe("paid");
  });

  it("marks failed checkouts", async () => {
    const { deps } = makeDeps();
    const job = await createJob(deps, { datasetId: "retail", question: "q" });
    const { sessionId } = await startCheckout(deps, job.id);
    expect((await failPayment(deps, sessionId))?.status).toBe("payment_failed");
  });
});

describe("executeJob", () => {
  it("refuses to run unpaid jobs", async () => {
    const { deps } = makeDeps();
    const job = await createJob(deps, { datasetId: "retail", question: "q" });
    await startCheckout(deps, job.id);
    const result = await executeJob(deps, job.id);
    expect(result.status).toBe("payment_pending");
    expect(deps.sandbox.prepared).toHaveLength(0);
  });

  it("re-verifies payment before execution", async () => {
    const { deps, jobId } = await paidJob();
    deps.payments.paid = false;
    await expect(executeJob(deps, jobId)).rejects.toThrow("Payment could not be verified");
    expect(deps.sandbox.prepared).toHaveLength(0);
  });

  it("completes with the policy-approved result and destroys the sandbox", async () => {
    const { deps, events, jobId } = await paidJob();
    const job = await executeJob(deps, jobId);
    expect(job.status).toBe("completed");
    expect(job.result).toEqual({
      summary: "Average order value by region.",
      chartType: "bar",
      columns: execution.columns,
      rows: execution.rows,
    });
    expect(deps.sandbox.destroyed).toEqual(deps.sandbox.prepared);
    expect(events.at(-1)).toEqual({ type: "sandbox_destroyed", jobId });
  });

  it("only one concurrent caller executes the job", async () => {
    const { deps, jobId } = await paidJob();
    const [a, b] = await Promise.all([executeJob(deps, jobId), executeJob(deps, jobId)]);
    expect(deps.sandbox.prepared).toHaveLength(1);
    expect([a.status, b.status]).toContain("completed");
  });

  it("blocks unsafe code before it reaches the sandbox and retries", async () => {
    const { deps, events, jobId } = await paidJob();
    deps.codegen.queue.push({ code: "import os\nos.system('curl x')", summary: "s", chartType: "none" });
    const job = await executeJob(deps, jobId);
    expect(job.status).toBe("completed");
    expect(deps.sandbox.executed).toHaveLength(1);
    expect(events.some((e) => e.type === "code_blocked")).toBe(true);
    expect(deps.codegen.requests[1].previousFailures[0]).toContain("import not allowed: os");
  });

  it("feeds execution errors back to the generator", async () => {
    const { deps, jobId } = await paidJob();
    let calls = 0;
    deps.sandbox.executeImpl = async () => {
      if (calls++ === 0) throw new Error("Binder Error: column foo not found");
      return execution;
    };
    const job = await executeJob(deps, jobId);
    expect(job.status).toBe("completed");
    expect(deps.codegen.requests[1].previousFailures[0]).toContain("column foo not found");
  });

  it("rejects when the policy keeps refusing and never stores rows", async () => {
    const { deps, jobId } = await paidJob();
    deps.policy.decisions = Array(3).fill({ approved: false, reason: "group too small" });
    const job = await executeJob(deps, jobId);
    expect(job.status).toBe("rejected");
    expect(job.errorCode).toBe("policy_rejected");
    expect(job.result).toBeUndefined();
    expect(deps.codegen.requests).toHaveLength(3);
    expect(deps.sandbox.destroyed).toHaveLength(1);
  });

  it("fails closed when the policy throws", async () => {
    const { deps, jobId } = await paidJob();
    deps.policy.validate = async () => {
      throw new Error("boom");
    };
    const job = await executeJob(deps, jobId);
    expect(job.status).toBe("execution_failed");
    expect(job.result).toBeUndefined();
  });

  it("times out slow executions and reports execution_failed", async () => {
    const { deps, jobId } = await paidJob();
    deps.options.timeoutMs = 10;
    deps.sandbox.executeImpl = () => new Promise(() => {});
    const job = await executeJob(deps, jobId);
    expect(job.status).toBe("execution_failed");
    expect(job.errorCode).toBe("execution_failed");
    expect(deps.sandbox.destroyed).toHaveLength(1);
  });

  it("reports generation_failed when the model never produces valid output", async () => {
    const { deps, jobId } = await paidJob();
    deps.codegen.queue = [new Error("bad"), new Error("bad"), new Error("bad")];
    const job = await executeJob(deps, jobId);
    expect(job.status).toBe("execution_failed");
    expect(job.errorCode).toBe("generation_failed");
    expect(deps.sandbox.executed).toHaveLength(0);
  });

  it("fails closed when group sizes are missing, without consulting the policy", async () => {
    const { deps, jobId } = await paidJob();
    deps.sandbox.executeImpl = async () => ({ columns: execution.columns, rows: execution.rows });
    let policyCalls = 0;
    const validate = deps.policy.validate.bind(deps.policy);
    deps.policy.validate = async (r) => {
      policyCalls++;
      return validate(r);
    };
    const job = await executeJob(deps, jobId);
    expect(job.status).toBe("rejected");
    expect(job.result).toBeUndefined();
    expect(policyCalls).toBe(0);
    expect(deps.codegen.requests[1].previousFailures[0]).toContain("missing groupSizes");
  });

  it("rejects every result for a dataset without a trusted row count", async () => {
    const { deps, jobId } = await paidJob();
    deps.datasets = new StaticDatasetCatalog([{ ...dataset, rowCount: undefined }]);
    const job = await executeJob(deps, jobId);
    expect(job.status).toBe("rejected");
    expect(job.result).toBeUndefined();
    expect(deps.codegen.requests[1].previousFailures[0]).toContain("no trusted row count");
  });

  it("rejects group sizes that exceed the dataset row count", async () => {
    const { deps, jobId } = await paidJob();
    deps.sandbox.executeImpl = async () => ({ ...execution, groupSizes: [900, 900] });
    const job = await executeJob(deps, jobId);
    expect(job.status).toBe("rejected");
    expect(deps.codegen.requests[1].previousFailures[0]).toContain("inconsistent with the dataset size");
  });

  it("binds the snapshot to the job only while it is running", async () => {
    const { deps, jobId } = await paidJob();
    const authorizer = new SnapshotAuthorizer(deps.store);
    const seen: boolean[] = [];
    deps.sandbox.executeImpl = async () => {
      seen.push(await authorizer.authorize(deps.sandbox.prepared[0]));
      return execution;
    };
    const job = await executeJob({ ...deps, snapshots: authorizer }, jobId);
    expect(job.status).toBe("completed");
    expect(seen).toEqual([true]);
    expect(await authorizer.authorize(deps.sandbox.prepared[0])).toBe(false);
    expect(await authorizer.authorize("unknown")).toBe(false);
  });

  it("refuses a job marked paid without a Stripe session", async () => {
    const { deps } = makeDeps();
    const job = await createJob(deps, { datasetId: "retail", question: "q" });
    await deps.store.transition(job.id, "created", "payment_pending");
    await deps.store.transition(job.id, "payment_pending", "paid");
    await expect(executeJob(deps, job.id)).rejects.toThrow("Payment could not be verified");
    expect(deps.sandbox.prepared).toHaveLength(0);
  });
});
