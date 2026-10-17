# Sealed Payments Module (`lib/payments`)

Implements the `PaymentProvider` interface from [`contracts/payments.ts`](../../contracts/payments.ts), `POST /api/checkout`, `POST /api/webhooks/stripe`, verified Stripe webhook handling, idempotent paid-job execution claims, and Stripe Connect marketplace payouts.

## Environment Variables

Configure the following in the runtime environment (never commit `.env` files):

- `STRIPE_SECRET_KEY`: Stripe secret key (`sk_test_...` or `sk_live_...`)
- `STRIPE_WEBHOOK_SECRET`: Stripe webhook signing secret (`whsec_...`)
- `NEXT_PUBLIC_APP_URL` (or `APP_URL`): Base URL for Checkout redirect links (defaults to `http://localhost:3000`)

## Implemented Routes

### 1. `POST /api/checkout` ([`app/api/checkout/route.ts`](../../app/api/checkout/route.ts))
- Expects `{ jobId: string }`.
- Looks up the existing job in Claude's `JobStore` (`404` if not found).
- Resolves server-controlled pricing from the `DatasetCatalog` (`dataset.priceCents` in `"usd"`; buyer-supplied price/currency fields are ignored).
- Calls `startCheckout` from `@/lib/agent` to create the Stripe Checkout session and atomically transition the job from `"created"` to `"payment_pending"` with `stripeSessionId`.
- Returns `{ sessionId, checkoutUrl }`.

### 2. `POST /api/webhooks/stripe` ([`app/api/webhooks/stripe/route.ts`](../../app/api/webhooks/stripe/route.ts))
- Verifies:
  1. Cryptographic `stripe-signature` header via `stripe.webhooks.constructEvent`.
  2. Job association (`job` exists in `JobStore`, `job.id === session.jobId`, `job.stripeSessionId === session.id`, and `store.findByStripeSession(session.id)?.id === job.id`).
  3. Paid status (`session.payment_status === "paid"`, `session.status !== "expired"`, plus provider verification via `verifyCheckoutSessionDetails` / `verifyPayment`).
  4. Amount (`session.amount_total === dataset.priceCents`).
  5. Currency (`session.currency === "usd"`).
- Idempotently marks the job `"paid"` via `confirmPayment` from `@/lib/agent` (or `"payment_failed"` via `failPayment` on `checkout.session.expired` / `checkout.session.async_payment_failed`).

### 3. Job Store Coordination (`lib/agent`)
- `getPaymentRouteDeps()` in [`lib/payments/routes.ts`](./routes.ts) automatically reads `globalThis.__sealedAgent` when initialized by `lib/agent`, sharing the single `JobStore`, `DatasetCatalog`, and `PaymentProvider` instance without duplicating stores or modifying `lib/agent` files.
- Tests can inject custom dependencies via `setPaymentRouteDeps(...)` or `globalThis.__sealedAgent`.
