import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as checkoutPost } from "../../app/api/checkout/route";
import { POST as stripeWebhookPost } from "../../app/api/webhooks/stripe/route";
import {
  type AgentEvent,
  createJob,
  type DatasetDescriptor,
  InMemoryJobStore,
  StaticDatasetCatalog,
} from "../agent";
import {
  setPaymentRouteDeps,
  StripePaymentProvider,
} from "./index";

const TEST_WEBHOOK_SECRET = "whsec_test_route_secret_987654321";
const signerStripe = new Stripe("sk_test_offline_route_signer");

const COFFEE_DATASET: DatasetDescriptor = {
  id: "downtown-coffee-sales",
  name: "Downtown Coffee Sales",
  description: "Anonymized POS coffee transactions",
  path: "/data/downtown-coffee-sales.csv",
  tableName: "dataset",
  columns: [
    { name: "drink_category", type: "VARCHAR" },
    { name: "revenue", type: "DOUBLE" },
  ],
  priceCents: 900,
};

function signWebhookEvent(
  eventPayload: Record<string, unknown>,
  secret: string = TEST_WEBHOOK_SECRET
): { payload: string; signature: string } {
  const payload = JSON.stringify(eventPayload);
  const signature = signerStripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  return { payload, signature };
}

function makeWebhookRequest(payload: string, signature?: string | null): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature) {
    headers.set("stripe-signature", signature);
  }
  return new Request("http://localhost:3000/api/webhooks/stripe", {
    method: "POST",
    headers,
    body: payload,
  });
}

function makeCheckoutRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function setupTestContext(overrides?: {
  retrieveSession?: ReturnType<typeof vi.fn>;
  createSession?: ReturnType<typeof vi.fn>;
}) {
  const store = new InMemoryJobStore();
  const datasets = new StaticDatasetCatalog([COFFEE_DATASET]);
  const events: AgentEvent[] = [];
  const onPaidJobConfirmed = vi.fn();

  const createSession =
    overrides?.createSession ??
    vi.fn().mockImplementation(async (params: Stripe.Checkout.SessionCreateParams) => ({
      id: `cs_test_${params.client_reference_id}`,
      url: `https://checkout.stripe.com/c/pay/cs_test_${params.client_reference_id}`,
    }));

  const retrieveSession =
    overrides?.retrieveSession ??
    vi.fn().mockImplementation(async (sessionId: string) => {
      const jobId = sessionId.replace(/^cs_test_/, "");
      return {
        id: sessionId,
        status: "complete",
        payment_status: "paid",
        amount_total: COFFEE_DATASET.priceCents,
        currency: "usd",
        client_reference_id: jobId,
        metadata: { jobId },
      };
    });

  const mockStripeClient = {
    checkout: {
      sessions: {
        create: createSession,
        retrieve: retrieveSession,
      },
    },
    webhooks: signerStripe.webhooks,
  } as unknown as Stripe;

  const payments = new StripePaymentProvider({
    stripeClient: mockStripeClient,
    appBaseUrl: "http://localhost:3000",
  });

  setPaymentRouteDeps({
    store,
    datasets,
    payments,
    webhookSecret: TEST_WEBHOOK_SECRET,
    stripeClient: mockStripeClient,
    onEvent: (e) => events.push(e),
    onPaidJobConfirmed,
  });

  return {
    store,
    datasets,
    payments,
    events,
    createSession,
    retrieveSession,
    onPaidJobConfirmed,
  };
}

afterEach(() => {
  setPaymentRouteDeps(undefined);
  const globalRef = globalThis as typeof globalThis & {
    __sealedAgent?: unknown;
  };
  delete globalRef.__sealedAgent;
});

describe("POST /api/checkout", () => {
  it("creates checkout for an existing server-side job using server-controlled dataset pricing", async () => {
    const { store, datasets, createSession } = setupTestContext();
    const job = await createJob(
      { store, datasets },
      {
        datasetId: COFFEE_DATASET.id,
        question: "What are the top drink categories by revenue?",
      }
    );

    // Even if a client attempts to inject a lower price or different currency,
    // the server must ignore it and use COFFEE_DATASET.priceCents (900) and "usd".
    const response = await checkoutPost(
      makeCheckoutRequest({
        jobId: job.id,
        amountCents: 50,
        priceCents: 1,
        currency: "eur",
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      sessionId: `cs_test_${job.id}`,
      checkoutUrl: `https://checkout.stripe.com/c/pay/cs_test_${job.id}`,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    const [stripeParams] = createSession.mock.calls[0];
    expect(stripeParams.line_items[0].price_data.unit_amount).toBe(900);
    expect(stripeParams.line_items[0].price_data.currency).toBe("usd");
    expect(stripeParams.client_reference_id).toBe(job.id);
    expect(stripeParams.metadata).toEqual({ jobId: job.id });

    const updatedJob = await store.get(job.id);
    expect(updatedJob?.status).toBe("payment_pending");
    expect(updatedJob?.stripeSessionId).toBe(`cs_test_${job.id}`);
  });

  it("returns 404 when referencing a non-existent jobId", async () => {
    const { createSession } = setupTestContext();

    const response = await checkoutPost(
      makeCheckoutRequest({ jobId: "job_does_not_exist" })
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Job not found" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON or missing jobId", async () => {
    setupTestContext();

    const badJson = await checkoutPost(makeCheckoutRequest("{invalid-json"));
    expect(badJson.status).toBe(400);

    const missingJobId = await checkoutPost(makeCheckoutRequest({}));
    expect(missingJobId.status).toBe(400);
  });

  it("returns 409 when job is not in created status", async () => {
    const { store, datasets } = setupTestContext();
    const job = await createJob(
      { store, datasets },
      { datasetId: COFFEE_DATASET.id, question: "Top categories?" }
    );

    const first = await checkoutPost(makeCheckoutRequest({ jobId: job.id }));
    expect(first.status).toBe(200);

    const second = await checkoutPost(makeCheckoutRequest({ jobId: job.id }));
    expect(second.status).toBe(409);
  });

  it("automatically coordinates with Claude's globalThis.__sealedAgent runtime when present", async () => {
    const store = new InMemoryJobStore();
    const datasets = new StaticDatasetCatalog([COFFEE_DATASET]);
    const createSession = vi.fn().mockResolvedValue({
      id: "cs_shared_runtime_1",
      url: "https://checkout.stripe.com/c/pay/cs_shared_runtime_1",
    });
    const payments = new StripePaymentProvider({
      stripeClient: {
        checkout: { sessions: { create: createSession, retrieve: vi.fn() } },
        webhooks: signerStripe.webhooks,
      } as unknown as Stripe,
    });

    setPaymentRouteDeps(undefined);
    const globalRef = globalThis as typeof globalThis & {
      __sealedAgent?: unknown;
    };
    globalRef.__sealedAgent = {
      store,
      deps: { store, datasets, payments },
    };

    const job = await createJob(
      { store, datasets },
      { datasetId: COFFEE_DATASET.id, question: "Shared store test?" }
    );

    const res = await checkoutPost(makeCheckoutRequest({ jobId: job.id }));
    expect(res.status).toBe(200);
    expect((await store.get(job.id))?.stripeSessionId).toBe(
      "cs_shared_runtime_1"
    );
  });
});

describe("POST /api/webhooks/stripe", () => {
  async function createPendingJob(ctx: ReturnType<typeof setupTestContext>) {
    const job = await createJob(
      { store: ctx.store, datasets: ctx.datasets },
      { datasetId: COFFEE_DATASET.id, question: "Revenue by weekday?" }
    );
    const res = await checkoutPost(makeCheckoutRequest({ jobId: job.id }));
    const checkout = (await res.json()) as { sessionId: string };
    return { job, sessionId: checkout.sessionId };
  }

  it("verifies signature, paid status, amount, currency, and job association before idempotently marking job paid", async () => {
    const ctx = setupTestContext();
    const { job, sessionId } = await createPendingJob(ctx);

    const { payload, signature } = signWebhookEvent({
      id: "evt_valid_paid_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          amount_total: COFFEE_DATASET.priceCents,
          currency: "usd",
          client_reference_id: job.id,
          metadata: { jobId: job.id },
        },
      },
    });

    const firstRes = await stripeWebhookPost(
      makeWebhookRequest(payload, signature)
    );
    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({
      received: true,
      duplicate: false,
      jobId: job.id,
      status: "paid",
    });

    const updatedJob = await ctx.store.get(job.id);
    expect(updatedJob?.status).toBe("paid");
    expect(ctx.events).toContainEqual({
      type: "payment_verified",
      jobId: job.id,
    });
    expect(ctx.onPaidJobConfirmed).toHaveBeenCalledTimes(1);

    // Duplicate delivery of the same webhook event must be idempotent
    const duplicateRes = await stripeWebhookPost(
      makeWebhookRequest(payload, signature)
    );
    expect(duplicateRes.status).toBe(200);
    expect(await duplicateRes.json()).toEqual({
      received: true,
      duplicate: true,
      jobId: job.id,
      status: "paid",
    });
    expect(ctx.onPaidJobConfirmed).toHaveBeenCalledTimes(1);

    // Second distinct webhook event (e.g. async_payment_succeeded) for the same job
    // must also be idempotent and not re-transition or re-run the job
    const secondEvent = signWebhookEvent({
      id: "evt_valid_paid_2",
      object: "event",
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: sessionId,
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          amount_total: COFFEE_DATASET.priceCents,
          currency: "usd",
          client_reference_id: job.id,
          metadata: { jobId: job.id },
        },
      },
    });

    const secondRes = await stripeWebhookPost(
      makeWebhookRequest(secondEvent.payload, secondEvent.signature)
    );
    expect(secondRes.status).toBe(200);
    expect(await secondRes.json()).toEqual({
      received: true,
      duplicate: true,
      jobId: job.id,
      status: "paid",
    });
    expect(ctx.onPaidJobConfirmed).toHaveBeenCalledTimes(1);
  });

  it("rejects missing or invalid webhook signatures and keeps job in payment_pending", async () => {
    const ctx = setupTestContext();
    const { job, sessionId } = await createPendingJob(ctx);

    const { payload, signature } = signWebhookEvent({
      id: "evt_sig_test_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          amount_total: COFFEE_DATASET.priceCents,
          currency: "usd",
          client_reference_id: job.id,
          metadata: { jobId: job.id },
        },
      },
    });

    const missingSigRes = await stripeWebhookPost(
      makeWebhookRequest(payload, null)
    );
    expect(missingSigRes.status).toBe(400);

    const tamperedPayload = payload.replace('"paid"', '"paid_tampered"');
    const badSigRes = await stripeWebhookPost(
      makeWebhookRequest(tamperedPayload, signature)
    );
    expect(badSigRes.status).toBe(400);

    expect((await ctx.store.get(job.id))?.status).toBe("payment_pending");
  });

  it("rejects unpaid or expired checkout.session.completed webhooks without marking job paid", async () => {
    const ctx = setupTestContext();
    const { job, sessionId } = await createPendingJob(ctx);

    const unpaidWebhook = signWebhookEvent({
      id: "evt_unpaid_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          object: "checkout.session",
          status: "open",
          payment_status: "unpaid",
          amount_total: COFFEE_DATASET.priceCents,
          currency: "usd",
          client_reference_id: job.id,
          metadata: { jobId: job.id },
        },
      },
    });

    const res = await stripeWebhookPost(
      makeWebhookRequest(unpaidWebhook.payload, unpaidWebhook.signature)
    );
    expect(res.status).toBe(400);
    expect((await ctx.store.get(job.id))?.status).toBe("payment_pending");
  });

  it("rejects webhooks when amount_total does not match the server-controlled dataset price", async () => {
    const ctx = setupTestContext();
    const { job, sessionId } = await createPendingJob(ctx);

    const wrongAmountWebhook = signWebhookEvent({
      id: "evt_wrong_amount_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          amount_total: 100, // expected 900
          currency: "usd",
          client_reference_id: job.id,
          metadata: { jobId: job.id },
        },
      },
    });

    const res = await stripeWebhookPost(
      makeWebhookRequest(wrongAmountWebhook.payload, wrongAmountWebhook.signature)
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/amount mismatch/i);
    expect((await ctx.store.get(job.id))?.status).toBe("payment_pending");
  });

  it("rejects webhooks when currency is not usd", async () => {
    const ctx = setupTestContext();
    const { job, sessionId } = await createPendingJob(ctx);

    const wrongCurrencyWebhook = signWebhookEvent({
      id: "evt_wrong_currency_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          amount_total: COFFEE_DATASET.priceCents,
          currency: "eur",
          client_reference_id: job.id,
          metadata: { jobId: job.id },
        },
      },
    });

    const res = await stripeWebhookPost(
      makeWebhookRequest(
        wrongCurrencyWebhook.payload,
        wrongCurrencyWebhook.signature
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/currency/i);
    expect((await ctx.store.get(job.id))?.status).toBe("payment_pending");
  });

  it("rejects webhooks with mismatched job association or session hijacking", async () => {
    const ctx = setupTestContext();
    const first = await createPendingJob(ctx);
    const second = await createPendingJob(ctx);

    // Attempt to use first job's sessionId to mark second job paid
    const hijackedWebhook = signWebhookEvent({
      id: "evt_hijack_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: first.sessionId,
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          amount_total: COFFEE_DATASET.priceCents,
          currency: "usd",
          client_reference_id: second.job.id,
          metadata: { jobId: second.job.id },
        },
      },
    });

    const res = await stripeWebhookPost(
      makeWebhookRequest(hijackedWebhook.payload, hijackedWebhook.signature)
    );
    expect(res.status).toBe(400);
    expect((await ctx.store.get(first.job.id))?.status).toBe("payment_pending");
    expect((await ctx.store.get(second.job.id))?.status).toBe("payment_pending");

    // Conflicting metadata.jobId vs client_reference_id in the same session
    const conflictingIdsWebhook = signWebhookEvent({
      id: "evt_conflict_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: first.sessionId,
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          amount_total: COFFEE_DATASET.priceCents,
          currency: "usd",
          client_reference_id: first.job.id,
          metadata: { jobId: second.job.id },
        },
      },
    });

    const conflictRes = await stripeWebhookPost(
      makeWebhookRequest(
        conflictingIdsWebhook.payload,
        conflictingIdsWebhook.signature
      )
    );
    expect(conflictRes.status).toBe(400);
    expect((await ctx.store.get(first.job.id))?.status).toBe("payment_pending");
  });

  it("transitions job to payment_failed on checkout.session.expired", async () => {
    const ctx = setupTestContext();
    const { job, sessionId } = await createPendingJob(ctx);

    const expiredWebhook = signWebhookEvent({
      id: "evt_expired_1",
      object: "event",
      type: "checkout.session.expired",
      data: {
        object: {
          id: sessionId,
          object: "checkout.session",
          status: "expired",
          payment_status: "unpaid",
          amount_total: COFFEE_DATASET.priceCents,
          currency: "usd",
          client_reference_id: job.id,
          metadata: { jobId: job.id },
        },
      },
    });

    const res = await stripeWebhookPost(
      makeWebhookRequest(expiredWebhook.payload, expiredWebhook.signature)
    );
    expect(res.status).toBe(200);
    expect((await ctx.store.get(job.id))?.status).toBe("payment_failed");
  });
});
