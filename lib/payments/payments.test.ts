import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  assertPaymentVerified,
  calculateConnectSplit,
  createConnectOnboardingLink,
  createPaymentProvider,
  PaymentError,
  PaymentExecutionGate,
  StripePaymentProvider,
  verifyStripeWebhook,
} from "./index";

const TEST_WEBHOOK_SECRET = "whsec_test_sealed_secret_key_123456";
const realStripe = new Stripe("sk_test_sealed_unit_test_key");

function createSignedWebhookPayload(
  eventPayload: Record<string, unknown>,
  secret: string = TEST_WEBHOOK_SECRET
): { payload: string; signature: string } {
  const payload = JSON.stringify(eventPayload);
  const signature = realStripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  return { payload, signature };
}

function createMockStripeClient(overrides?: {
  createSession?: ReturnType<typeof vi.fn>;
  retrieveSession?: ReturnType<typeof vi.fn>;
  createAccount?: ReturnType<typeof vi.fn>;
  createAccountLink?: ReturnType<typeof vi.fn>;
}): Stripe {
  return {
    checkout: {
      sessions: {
        create:
          overrides?.createSession ??
          vi.fn().mockResolvedValue({
            id: "cs_test_123",
            url: "https://checkout.stripe.com/c/pay/cs_test_123",
          }),
        retrieve:
          overrides?.retrieveSession ??
          vi.fn().mockResolvedValue({
            id: "cs_test_123",
            status: "complete",
            payment_status: "paid",
            client_reference_id: "job_abc",
            metadata: { jobId: "job_abc" },
          }),
      },
    },
    accounts: {
      create:
        overrides?.createAccount ??
        vi.fn().mockResolvedValue({
          id: "acct_123456789",
        }),
    },
    accountLinks: {
      create:
        overrides?.createAccountLink ??
        vi.fn().mockResolvedValue({
          url: "https://connect.stripe.com/setup/e/acct_123456789/abc",
          expires_at: 1792270000,
        }),
    },
    webhooks: realStripe.webhooks,
  } as unknown as Stripe;
}

describe("StripePaymentProvider", () => {
  it("creates a standard Stripe Checkout session with idempotency key and metadata", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: "cs_test_standard_001",
      url: "https://checkout.stripe.com/c/pay/cs_test_standard_001",
    });
    const stripeClient = createMockStripeClient({ createSession });

    const provider = createPaymentProvider({
      stripeClient,
      appBaseUrl: "https://sealed.example.com/",
    });

    const response = await provider.createCheckout({
      jobId: "job_42",
      amountCents: 2500,
      currency: "usd",
    });

    expect(response).toEqual({
      sessionId: "cs_test_standard_001",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_standard_001",
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    const [params, requestOptions] = createSession.mock.calls[0];
    expect(params.mode).toBe("payment");
    expect(params.client_reference_id).toBe("job_42");
    expect(params.metadata).toEqual({ jobId: "job_42" });
    expect(params.line_items[0].price_data.unit_amount).toBe(2500);
    expect(params.line_items[0].price_data.currency).toBe("usd");
    expect(params.success_url).toBe(
      "https://sealed.example.com/jobs/job_42?payment=success&session_id={CHECKOUT_SESSION_ID}"
    );
    expect(params.cancel_url).toBe(
      "https://sealed.example.com/jobs/job_42?payment=cancelled"
    );
    expect(requestOptions).toEqual({
      idempotencyKey: "sealed_checkout_job_42",
    });
  });

  it("configures Stripe Connect destination transfer and platform fee when ownerAccountId is provided", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: "cs_test_connect_001",
      url: "https://checkout.stripe.com/c/pay/cs_test_connect_001",
    });
    const stripeClient = createMockStripeClient({ createSession });

    const provider = new StripePaymentProvider({
      stripeClient,
      platformFeeBps: 1500, // 15%
    });

    await provider.createCheckout({
      jobId: "job_connect_99",
      amountCents: 10000,
      currency: "usd",
      ownerAccountId: "acct_owner_xyz",
    });

    const [params] = createSession.mock.calls[0];
    expect(params.metadata).toEqual({
      jobId: "job_connect_99",
      ownerAccountId: "acct_owner_xyz",
    });
    expect(params.payment_intent_data).toEqual({
      application_fee_amount: 1500,
      transfer_data: {
        destination: "acct_owner_xyz",
      },
      metadata: {
        jobId: "job_connect_99",
        ownerAccountId: "acct_owner_xyz",
        platformFeeCents: "1500",
        ownerPayoutCents: "8500",
      },
    });
  });

  it("rejects invalid checkout requests before calling Stripe", async () => {
    const createSession = vi.fn();
    const provider = new StripePaymentProvider({
      stripeClient: createMockStripeClient({ createSession }),
    });

    await expect(
      provider.createCheckout({
        jobId: "   ",
        amountCents: 500,
        currency: "usd",
      })
    ).rejects.toMatchObject({ code: "INVALID_CHECKOUT_REQUEST" });

    await expect(
      provider.createCheckout({
        jobId: "job_1",
        amountCents: 25, // below 50c minimum
        currency: "usd",
      })
    ).rejects.toMatchObject({ code: "INVALID_CHECKOUT_REQUEST" });

    await expect(
      provider.createCheckout({
        jobId: "job_1",
        amountCents: 500,
        currency: "usd",
        ownerAccountId: "invalid_account_id",
      })
    ).rejects.toMatchObject({ code: "INVALID_CONNECT_CONFIG" });

    expect(createSession).not.toHaveBeenCalled();
  });

  it("verifies paid vs unpaid and expired sessions accurately", async () => {
    const retrieveSession = vi
      .fn()
      .mockResolvedValueOnce({
        id: "cs_paid_1",
        status: "complete",
        payment_status: "paid",
        metadata: { jobId: "job_paid_1" },
      })
      .mockResolvedValueOnce({
        id: "cs_unpaid_2",
        status: "open",
        payment_status: "unpaid",
        client_reference_id: "job_unpaid_2",
        metadata: {},
      })
      .mockResolvedValueOnce({
        id: "cs_expired_3",
        status: "expired",
        payment_status: "paid",
        metadata: { jobId: "job_expired_3" },
      });

    const provider = new StripePaymentProvider({
      stripeClient: createMockStripeClient({ retrieveSession }),
    });

    await expect(provider.verifyPayment("cs_paid_1")).resolves.toEqual({
      jobId: "job_paid_1",
      paid: true,
      stripeSessionId: "cs_paid_1",
    });

    await expect(provider.verifyPayment("cs_unpaid_2")).resolves.toEqual({
      jobId: "job_unpaid_2",
      paid: false,
      stripeSessionId: "cs_unpaid_2",
    });

    await expect(provider.verifyPayment("cs_expired_3")).resolves.toEqual({
      jobId: "job_expired_3",
      paid: false,
      stripeSessionId: "cs_expired_3",
    });
  });
});

describe("Webhook Signature Verification & Event Parsing", () => {
  it("cryptographically verifies valid Stripe webhook signatures and marks paid sessions", () => {
    const { payload, signature } = createSignedWebhookPayload({
      id: "evt_paid_001",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_webhook_001",
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          metadata: { jobId: "job_webhook_001" },
        },
      },
    });

    const verified = verifyStripeWebhook(payload, signature, {
      webhookSecret: TEST_WEBHOOK_SECRET,
    });

    expect(verified).toEqual({
      eventId: "evt_paid_001",
      eventType: "checkout.session.completed",
      action: "mark_paid",
      verification: {
        jobId: "job_webhook_001",
        paid: true,
        stripeSessionId: "cs_test_webhook_001",
      },
    });
  });

  it("rejects tampered payloads or invalid webhook signatures", () => {
    const { payload, signature } = createSignedWebhookPayload({
      id: "evt_tamper_001",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_001",
          status: "complete",
          payment_status: "paid",
          metadata: { jobId: "job_001" },
        },
      },
    });

    const tamperedPayload = payload.replace("job_001", "job_hijacked");

    expect(() =>
      verifyStripeWebhook(tamperedPayload, signature, {
        webhookSecret: TEST_WEBHOOK_SECRET,
      })
    ).toThrowError(PaymentError);

    expect(() =>
      verifyStripeWebhook(payload, null, {
        webhookSecret: TEST_WEBHOOK_SECRET,
      })
    ).toThrowError(/Missing Stripe-Signature/);
  });

  it("does not mark checkout.session.completed as paid when payment_status is unpaid", () => {
    const { payload, signature } = createSignedWebhookPayload({
      id: "evt_unpaid_async_001",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_async_001",
          object: "checkout.session",
          status: "complete",
          payment_status: "unpaid",
          metadata: { jobId: "job_async_001" },
        },
      },
    });

    const verified = verifyStripeWebhook(payload, signature, {
      webhookSecret: TEST_WEBHOOK_SECRET,
    });

    expect(verified.action).toBe("ignore");
    expect(verified.verification?.paid).toBe(false);
  });

  it("marks expired or failed async payment sessions as mark_failed", () => {
    const { payload, signature } = createSignedWebhookPayload({
      id: "evt_failed_001",
      object: "event",
      type: "checkout.session.async_payment_failed",
      data: {
        object: {
          id: "cs_test_failed_001",
          object: "checkout.session",
          status: "complete",
          payment_status: "unpaid",
          metadata: { jobId: "job_failed_001" },
        },
      },
    });

    const verified = verifyStripeWebhook(payload, signature, {
      webhookSecret: TEST_WEBHOOK_SECRET,
    });

    expect(verified).toEqual({
      eventId: "evt_failed_001",
      eventType: "checkout.session.async_payment_failed",
      action: "mark_failed",
      verification: {
        jobId: "job_failed_001",
        paid: false,
        stripeSessionId: "cs_test_failed_001",
      },
    });
  });
});

describe("PaymentExecutionGate (Idempotency & Pre-Execution Security Boundary)", () => {
  it("prevents job claim and execution before verified payment", () => {
    const gate = new PaymentExecutionGate();

    expect(() => gate.claimPaidJob("job_unpaid")).toThrowError(
      /payment has not been verified/
    );

    expect(() =>
      assertPaymentVerified(
        { jobId: "job_unpaid", paid: false, stripeSessionId: "cs_123" },
        "job_unpaid"
      )
    ).toThrowError(PaymentError);

    expect(() =>
      assertPaymentVerified(
        { jobId: "job_other", paid: true, stripeSessionId: "cs_123" },
        "job_expected"
      )
    ).toThrowError(/does not match expected jobId/);
  });

  it("atomically claims a paid job exactly once across duplicate webhooks and direct verification", async () => {
    const gate = new PaymentExecutionGate();
    const onPaidJobClaimed = vi.fn();

    const { payload, signature } = createSignedWebhookPayload({
      id: "evt_idempotent_100",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_idempotent_100",
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          metadata: { jobId: "job_idempotent_100" },
        },
      },
    });

    const firstDelivery = await gate.handleWebhook(payload, signature, {
      webhookSecret: TEST_WEBHOOK_SECRET,
      onPaidJobClaimed,
    });

    expect(firstDelivery.duplicateEvent).toBe(false);
    expect(firstDelivery.claimedForExecution).toBe(true);
    expect(onPaidJobClaimed).toHaveBeenCalledTimes(1);

    // Duplicate delivery of the exact same Stripe webhook event
    const secondDelivery = await gate.handleWebhook(payload, signature, {
      webhookSecret: TEST_WEBHOOK_SECRET,
      onPaidJobClaimed,
    });

    expect(secondDelivery.duplicateEvent).toBe(true);
    expect(secondDelivery.claimedForExecution).toBe(false);
    expect(onPaidJobClaimed).toHaveBeenCalledTimes(1);

    // Separate webhook event for the same jobId (e.g., retry or secondary event)
    const secondEvent = createSignedWebhookPayload({
      id: "evt_idempotent_101",
      object: "event",
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: "cs_idempotent_100",
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          metadata: { jobId: "job_idempotent_100" },
        },
      },
    });

    const thirdDelivery = await gate.handleWebhook(
      secondEvent.payload,
      secondEvent.signature,
      {
        webhookSecret: TEST_WEBHOOK_SECRET,
        onPaidJobClaimed,
      }
    );

    expect(thirdDelivery.duplicateEvent).toBe(false);
    expect(thirdDelivery.claimedForExecution).toBe(false);
    expect(onPaidJobClaimed).toHaveBeenCalledTimes(1);

    // Subsequent manual claim also returns already_claimed
    expect(gate.claimPaidJob("job_idempotent_100")).toEqual({
      claimed: false,
      jobId: "job_idempotent_100",
      stripeSessionId: "cs_idempotent_100",
      reason: "already_claimed",
    });
  });
});

describe("Stripe Connect Onboarding & Split Helpers", () => {
  it("calculates platform fee and owner payout accurately", () => {
    const split = calculateConnectSplit(2500, "acct_dataset_owner_1", 1000);
    expect(split).toEqual({
      totalAmountCents: 2500,
      platformFeeCents: 250,
      ownerPayoutCents: 2250,
      destinationAccountId: "acct_dataset_owner_1",
    });
  });

  it("creates a Stripe Connect Express account and onboarding link", async () => {
    const createAccount = vi.fn().mockResolvedValue({ id: "acct_express_99" });
    const createAccountLink = vi.fn().mockResolvedValue({
      url: "https://connect.stripe.com/setup/e/acct_express_99/xyz",
      expires_at: 1792270000,
    });
    const stripeClient = createMockStripeClient({
      createAccount,
      createAccountLink,
    });

    const link = await createConnectOnboardingLink(
      stripeClient,
      {
        datasetOwnerId: "owner_42",
        email: "owner@example.com",
      },
      "https://sealed.example.com/connect/refresh",
      "https://sealed.example.com/connect/return"
    );

    expect(link).toEqual({
      accountId: "acct_express_99",
      onboardingUrl: "https://connect.stripe.com/setup/e/acct_express_99/xyz",
      expiresAt: 1792270000,
    });
    expect(createAccount).toHaveBeenCalledWith({
      type: "express",
      country: "US",
      email: "owner@example.com",
      capabilities: { transfers: { requested: true } },
      metadata: { datasetOwnerId: "owner_42" },
    });
  });
});
