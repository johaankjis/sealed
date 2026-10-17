import type { PaymentProvider } from "@/contracts/payments";
import { PaymentExecutionGate } from "./idempotency";
import {
  StripePaymentProvider,
  type StripePaymentProviderOptions,
} from "./stripe-provider";

export type {
  CheckoutRequest,
  CheckoutResponse,
  PaymentProvider,
  PaymentVerification,
} from "@/contracts/payments";

export {
  buildConnectPaymentIntentData,
  type ConnectOnboardingLinkResponse,
  type ConnectSplit,
  type CreateConnectAccountRequest,
  calculateConnectSplit,
  createConnectOnboardingLink,
  DEFAULT_PLATFORM_FEE_BPS,
} from "./connect";

export { PaymentError, type PaymentErrorCode } from "./errors";

export {
  assertPaymentVerified,
  type JobExecutionClaimResult,
  PaymentExecutionGate,
  type WebhookDispatchResult,
} from "./idempotency";

export {
  MIN_USD_AMOUNT_CENTS,
  StripePaymentProvider,
  type StripePaymentProviderOptions,
} from "./stripe-provider";

export {
  parseStripeCheckoutEvent,
  type VerifiedWebhookEvent,
  type VerifyWebhookOptions,
  verifyStripeWebhook,
  type WebhookPaymentAction,
} from "./webhook";

/**
 * Factory for creating the configured `PaymentProvider` implementation.
 */
export function createPaymentProvider(
  options?: StripePaymentProviderOptions
): PaymentProvider {
  return new StripePaymentProvider(options);
}

/**
 * Process-wide default `PaymentExecutionGate` for coordinating verified webhooks
 * and atomic paid-job execution claims across API routes.
 */
export const paymentExecutionGate = new PaymentExecutionGate();
