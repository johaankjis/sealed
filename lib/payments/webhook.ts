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

export interface WebhookSessionDetails {
  sessionId: string;
  jobId: string;
  clientReferenceId: string | null;
  metadataJobId: string | null;
  paymentStatus: Stripe.Checkout.Session.PaymentStatus | null;
  sessionStatus: Stripe.Checkout.Session.Status | null;
  amountTotal: number | null;
  currency: string | null;
}

export interface DetailedVerifiedWebhookEvent extends VerifiedWebhookEvent {
  session?: WebhookSessionDetails;
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

function constructStripeEvent(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  options: VerifyWebhookOptions = {}
): Stripe.Event {
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

  try {
    return stripe.webhooks.constructEvent(
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
}

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
  const event = constructStripeEvent(rawBody, signatureHeader, options);
  return parseStripeCheckoutEvent(event);
}

/**
 * Verifies the `stripe-signature` header and returns both the `VerifiedWebhookEvent`
 * and full `WebhookSessionDetails` (including `amountTotal`, `currency`, `paymentStatus`,
 * and job association fields) for route-level validation.
 */
export function verifyStripeWebhookDetailed(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  options: VerifyWebhookOptions = {}
): DetailedVerifiedWebhookEvent {
  const event = constructStripeEvent(rawBody, signatureHeader, options);
  return parseStripeCheckoutEventDetailed(event);
}

/**
 * Maps a verified `Stripe.Event` into a `VerifiedWebhookEvent` for the job orchestrator.
 */
export function parseStripeCheckoutEvent(
  event: Stripe.Event
): VerifiedWebhookEvent {
  const { session: _session, ...verified } = parseStripeCheckoutEventDetailed(event);
  return verified;
}

/**
 * Maps a verified `Stripe.Event` into a `DetailedVerifiedWebhookEvent` including
 * session amount, currency, status, and job association metadata.
 */
export function parseStripeCheckoutEventDetailed(
  event: Stripe.Event
): DetailedVerifiedWebhookEvent {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      const details = extractSessionDetails(session);
      const isPaid =
        session.payment_status === "paid" && session.status !== "expired";

      return {
        eventId: event.id,
        eventType: event.type,
        action: isPaid ? "mark_paid" : "ignore",
        verification: {
          jobId: details.jobId,
          paid: isPaid,
          stripeSessionId: details.sessionId,
        },
        session: details,
      };
    }

    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const details = extractSessionDetails(session);

      return {
        eventId: event.id,
        eventType: event.type,
        action: "mark_failed",
        verification: {
          jobId: details.jobId,
          paid: false,
          stripeSessionId: details.sessionId,
        },
        session: details,
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

function extractSessionDetails(
  session: Stripe.Checkout.Session
): WebhookSessionDetails {
  if (!session || typeof session.id !== "string" || !session.id.trim()) {
    throw new PaymentError(
      "MISSING_JOB_METADATA",
      "Stripe Checkout session is missing a valid session id."
    );
  }

  const metadataJobId = session.metadata?.jobId?.trim() || null;
  const clientReferenceId = session.client_reference_id?.trim() || null;

  if (
    metadataJobId &&
    clientReferenceId &&
    metadataJobId !== clientReferenceId
  ) {
    throw new PaymentError(
      "PAYMENT_NOT_VERIFIED",
      `Stripe Checkout session ${session.id} has mismatched metadata.jobId ("${metadataJobId}") and client_reference_id ("${clientReferenceId}").`
    );
  }

  const jobId = metadataJobId || clientReferenceId;

  if (!jobId) {
    throw new PaymentError(
      "MISSING_JOB_METADATA",
      `Stripe Checkout session ${session.id} is missing jobId in metadata and client_reference_id.`
    );
  }

  return {
    sessionId: session.id.trim(),
    jobId,
    clientReferenceId,
    metadataJobId,
    paymentStatus: session.payment_status ?? null,
    sessionStatus: session.status ?? null,
    amountTotal:
      typeof session.amount_total === "number" ? session.amount_total : null,
    currency:
      typeof session.currency === "string"
        ? session.currency.trim().toLowerCase()
        : null,
  };
}
