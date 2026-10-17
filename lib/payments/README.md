# Sealed Payments Module (`lib/payments`)

Implements the `PaymentProvider` interface from [`contracts/payments.ts`](../../contracts/payments.ts), verified Stripe webhook handling, idempotent paid-job execution claims, and Stripe Connect marketplace payouts.

## Environment Variables

Configure the following in the runtime environment (never commit `.env` files):

- `STRIPE_SECRET_KEY`: Stripe secret key (`sk_test_...` or `sk_live_...`)
- `STRIPE_WEBHOOK_SECRET`: Stripe webhook signing secret (`whsec_...`)
- `NEXT_PUBLIC_APP_URL` (or `APP_URL`): Base URL for Checkout redirect links (defaults to `http://localhost:3000`)

## Integration Guide

### 1. Creating a Checkout Session (`lib/agent` / Checkout API Route)

```ts
import { createPaymentProvider } from "@/lib/payments";

const payments = createPaymentProvider();

const checkout = await payments.createCheckout({
  jobId: job.id,
  amountCents: 500, // $5.00 USD
  currency: "usd",
  ownerAccountId: dataset.stripeConnectAccountId, // optional (`acct_...`)
});

// Persist `checkout.sessionId` on `job.stripeSessionId`, transition job status
// to "payment_pending", and redirect buyer to `checkout.checkoutUrl`.
```

### 2. Verifying Stripe Webhooks & Atomically Claiming Paid Jobs (`app/api/webhooks/stripe/route.ts`)

```ts
import { paymentExecutionGate, PaymentError } from "@/lib/payments";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  try {
    const result = await paymentExecutionGate.handleWebhook(rawBody, signature, {
      onPaidJobClaimed: async (verification) => {
        // Executed at most once per paid jobId:
        // Transition job to "paid" -> "running" and trigger orchestrator
        await runPaidQueryJob(verification.jobId, verification.stripeSessionId);
      },
      onPaymentFailed: async (verification) => {
        // Transition job to "payment_failed"
        await markJobPaymentFailed(verification.jobId);
      },
    });

    return Response.json({
      received: true,
      duplicate: result.duplicateEvent,
      claimed: result.claimedForExecution,
    });
  } catch (err) {
    if (err instanceof PaymentError && err.code === "INVALID_WEBHOOK_SIGNATURE") {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
```

### 3. Direct Session Verification & Pre-Execution Security Guard (`lib/agent`)

Before starting any CreateOS sandbox execution, enforce payment verification:

```ts
import {
  assertPaymentVerified,
  createPaymentProvider,
  paymentExecutionGate,
} from "@/lib/payments";

const payments = createPaymentProvider();

// Option A: Verify against Stripe API and atomically claim in one step
const claim = await paymentExecutionGate.verifyAndClaimJob(
  payments,
  sessionId,
  job.id
);
if (!claim.claimed) {
  // Job was already claimed by webhook or concurrent request
  return;
}

// Option B: Guard before sandbox execution with an existing PaymentVerification
const verification = await payments.verifyPayment(sessionId);
assertPaymentVerified(verification, job.id);
```
