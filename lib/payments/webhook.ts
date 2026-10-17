import Stripe from "stripe";
import type { PaymentVerification } from "@/contracts/payments";
import { PaymentError } from "./errors";

export type WebhookPaymentAction = "mark_paid" | "mark_failed" | "ignore";

export interface VerifiedWebhookEvent {
  eventId: string;
  eventType: string;
  action: WebhookPaymentAction;
  verification?: PaymentVerification;
}

export interface VerifyWebhookOptions {
  /**
   * Stripe webhook signing secret (`whsec_...`).
   * Defaults to `process.env.STRIPE_WEBHOOK_SECRET`.
   */
  webhookSecret?: string;
  /**
   * Optional Stripe SDK instance. If omitted, a local Stripe instance is used
   * purely for cryptographic HMAC signature verification (`webhooks.constructEvent`).
   */
  stripeClient?: Stripe;
}

const DEFAULT_WEBHOOK_STRIPE = new Stripe("sk_test_webhook_verifier_placeholder");

/**
 * Verifies the `stripe-signature` header against the raw request payload using
 * `stripe.webhooks.constructEvent` and parses Checkout Session lifecycle events
 * into a `VerifiedWebhookEvent`.
 *
 * Security rule: Never accepts unsigned or invalidly signed webhook payloads,
 * and only marks a job as paid when `session.payment_status === "paid"`.
 */
export function verifyStripeWebhook(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  options: VerifyWebhookOptions = {}
): VerifiedWebhookEvent {
  const webhookSecret =
    options.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret || !webhookSecret.trim()) {
    throw new PaymentError(
      "MISSING_STRIPE_CONFIG",
      "STRIPE_WEBHOOK_SECRET is required to verify Stripe webhooks."
    );
  }

  if (!signatureHeader || !signatureHeader.trim()) {
    throw new PaymentError(
      "INVALID_WEBHOOK_SIGNATURE",
      "Missing Stripe-Signature header on webhook request."
    );
  }

  if (
    (typeof rawBody === "string" && rawBody.length === 0) ||
    (Buffer.isBuffer(rawBody) && rawBody.byteLength === 0)
  ) {
    throw new PaymentError(
      "INVALID_WEBHOOK_SIGNATURE",
      "Webhook request body must not be empty."
    );
  }

  const stripe = options.stripeClient ?? DEFAULT_WEBHOOK_STRIPE;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      webhookSecret.trim()
    );
  } catch (error) {
    throw new PaymentError(
      "INVALID_WEBHOOK_SIGNATURE",
      "Stripe webhook signature verification failed.",
      error
    );
  }

  return parseStripeCheckoutEvent(event);
}

/**
 * Maps a verified `Stripe.Event` into a `VerifiedWebhookEvent` for the job orchestrator.
 */
export function parseStripeCheckoutEvent(
  event: Stripe.Event
): VerifiedWebhookEvent {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      const jobId = extractJobIdFromSession(session);
      const isPaid =
        session.payment_status === "paid" && session.status !== "expired";

      return {
        eventId: event.id,
        eventType: event.type,
        action: isPaid ? "mark_paid" : "ignore",
        verification: {
          jobId,
          paid: isPaid,
          stripeSessionId: session.id,
        },
      };
    }

    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const jobId = extractJobIdFromSession(session);

      return {
        eventId: event.id,
        eventType: event.type,
        action: "mark_failed",
        verification: {
          jobId,
          paid: false,
          stripeSessionId: session.id,
        },
      };
    }

    default:
      return {
        eventId: event.id,
        eventType: event.type,
        action: "ignore",
      };
  }
}

function extractJobIdFromSession(session: Stripe.Checkout.Session): string {
  const jobId =
    session.metadata?.jobId?.trim() || session.client_reference_id?.trim();

  if (!jobId) {
    throw new PaymentError(
      "MISSING_JOB_METADATA",
      `Stripe Checkout session ${session.id} is missing jobId in metadata and client_reference_id.`
    );
  }

  return jobId;
}
