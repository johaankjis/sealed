import Stripe from "stripe";
import type {
  CheckoutRequest,
  CheckoutResponse,
  PaymentProvider,
  PaymentVerification,
} from "@/contracts/payments";
import {
  buildConnectPaymentIntentData,
  DEFAULT_PLATFORM_FEE_BPS,
} from "./connect";
import { PaymentError } from "./errors";

export const MIN_USD_AMOUNT_CENTS = 50;

export interface DetailedPaymentVerification extends PaymentVerification {
  amountTotal: number | null;
  currency: string | null;
}

export interface StripePaymentProviderOptions {
  /**
   * Stripe secret API key (`sk_test_...` or `sk_live_...`).
   * Defaults to `process.env.STRIPE_SECRET_KEY`.
   */
  secretKey?: string;
  /**
   * Base application URL used to construct Checkout `success_url` and `cancel_url`.
   * Defaults to `process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "http://localhost:3000"`.
   */
  appBaseUrl?: string;
  /**
   * Platform fee in basis points when routing to a Stripe Connect `ownerAccountId`.
   * Defaults to 1000 (10%).
   */
  platformFeeBps?: number;
  /**
   * Optional pre-configured Stripe SDK instance (useful for dependency injection and testing).
   */
  stripeClient?: Stripe;
}

interface CachedCheckoutEntry {
  fingerprint: string;
  response: CheckoutResponse;
}

export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe;
  private readonly appBaseUrl: string;
  private readonly platformFeeBps: number;
  private readonly checkoutCache = new Map<string, CachedCheckoutEntry>();

  constructor(options: StripePaymentProviderOptions = {}) {
    if (options.stripeClient) {
      this.stripe = options.stripeClient;
    } else {
      const secretKey = options.secretKey ?? process.env.STRIPE_SECRET_KEY;
      if (!secretKey || !secretKey.trim()) {
        throw new PaymentError(
          "MISSING_STRIPE_CONFIG",
          "STRIPE_SECRET_KEY is required to initialize StripePaymentProvider."
        );
      }
      this.stripe = new Stripe(secretKey.trim());
    }

    const rawBaseUrl =
      options.appBaseUrl ??
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.APP_URL ??
      "http://localhost:3000";

    this.appBaseUrl = rawBaseUrl.replace(/\/+$/, "");
    this.platformFeeBps = options.platformFeeBps ?? DEFAULT_PLATFORM_FEE_BPS;
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResponse> {
    const jobId = request.jobId?.trim();
    if (!jobId) {
      throw new PaymentError(
        "INVALID_CHECKOUT_REQUEST",
        "CheckoutRequest.jobId must be a non-empty string."
      );
    }

    if (
      !Number.isInteger(request.amountCents) ||
      request.amountCents < MIN_USD_AMOUNT_CENTS
    ) {
      throw new PaymentError(
        "INVALID_CHECKOUT_REQUEST",
        `CheckoutRequest.amountCents must be an integer >= ${MIN_USD_AMOUNT_CENTS} cents.`
      );
    }

    if (request.currency !== "usd") {
      throw new PaymentError(
        "INVALID_CHECKOUT_REQUEST",
        `Unsupported currency "${String(request.currency)}". Only "usd" is supported.`
      );
    }

    const normalizedOwner = request.ownerAccountId?.trim() ?? "";
    const fingerprint = `${request.amountCents}:${request.currency}:${normalizedOwner}`;
    const existing = this.checkoutCache.get(jobId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new PaymentError(
          "INVALID_CHECKOUT_REQUEST",
          `Checkout parameters for job ${jobId} do not match the existing checkout session.`
        );
      }
      return { ...existing.response };
    }

    const encodedJobId = encodeURIComponent(jobId);
    const metadata: Record<string, string> = { jobId };

    let paymentIntentData:
      | Stripe.Checkout.SessionCreateParams.PaymentIntentData
      | undefined;

    if (request.ownerAccountId !== undefined) {
      paymentIntentData = buildConnectPaymentIntentData(
        jobId,
        request.amountCents,
        request.ownerAccountId,
        this.platformFeeBps
      );
      metadata.ownerAccountId = normalizedOwner;
    } else {
      paymentIntentData = {
        metadata: { jobId },
      };
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.create(
        {
          mode: "payment",
          client_reference_id: jobId,
          metadata,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: request.currency,
                unit_amount: request.amountCents,
                product_data: {
                  name: "Sealed Private Dataset Insight Query",
                  description: `Isolated sandbox query execution for job ${jobId}`,
                },
              },
            },
          ],
          payment_intent_data: paymentIntentData,
          success_url: `${this.appBaseUrl}/jobs/${encodedJobId}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${this.appBaseUrl}/jobs/${encodedJobId}?payment=cancelled`,
        },
        {
          idempotencyKey: `sealed_checkout_${jobId}`,
        }
      );
    } catch (error) {
      if (error instanceof PaymentError) {
        throw error;
      }
      throw new PaymentError(
        "CHECKOUT_CREATION_FAILED",
        `Failed to create Stripe Checkout session for job ${jobId}.`,
        error
      );
    }

    if (!session.id || !session.url) {
      throw new PaymentError(
        "CHECKOUT_CREATION_FAILED",
        `Stripe Checkout session created for job ${jobId} did not return a valid session URL.`
      );
    }

    const response: CheckoutResponse = {
      sessionId: session.id,
      checkoutUrl: session.url,
    };
    this.checkoutCache.set(jobId, { fingerprint, response });
    return { ...response };
  }

  async verifyPayment(sessionId: string): Promise<PaymentVerification> {
    const detailed = await this.verifyCheckoutSessionDetails(sessionId);
    return {
      jobId: detailed.jobId,
      paid: detailed.paid,
      stripeSessionId: detailed.stripeSessionId,
    };
  }

  async verifyCheckoutSessionDetails(
    sessionId: string
  ): Promise<DetailedPaymentVerification> {
    const trimmedSessionId = sessionId?.trim();
    if (!trimmedSessionId) {
      throw new PaymentError(
        "INVALID_CHECKOUT_REQUEST",
        "sessionId must be a non-empty string."
      );
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.retrieve(trimmedSessionId);
    } catch (error) {
      throw new PaymentError(
        "SESSION_RETRIEVAL_FAILED",
        `Failed to retrieve Stripe Checkout session ${trimmedSessionId}.`,
        error
      );
    }

    const metadataJobId = session.metadata?.jobId?.trim();
    const clientRefJobId = session.client_reference_id?.trim();

    if (metadataJobId && clientRefJobId && metadataJobId !== clientRefJobId) {
      throw new PaymentError(
        "PAYMENT_NOT_VERIFIED",
        `Stripe Checkout session ${session.id} has mismatched metadata.jobId ("${metadataJobId}") and client_reference_id ("${clientRefJobId}").`
      );
    }

    const jobId = metadataJobId || clientRefJobId;

    if (!jobId) {
      throw new PaymentError(
        "MISSING_JOB_METADATA",
        `Stripe Checkout session ${session.id} is missing jobId metadata.`
      );
    }

    const currency =
      typeof session.currency === "string"
        ? session.currency.trim().toLowerCase()
        : null;
    const amountTotal =
      typeof session.amount_total === "number" ? session.amount_total : null;

    const currencyValid = currency === null || currency === "usd";
    const paid =
      session.payment_status === "paid" &&
      session.status !== "expired" &&
      currencyValid;

    return {
      jobId,
      paid,
      stripeSessionId: session.id,
      amountTotal,
      currency,
    };
  }
}
