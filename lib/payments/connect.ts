import Stripe from "stripe";
import { PaymentError } from "./errors";

export const DEFAULT_PLATFORM_FEE_BPS = 1000; // 10% platform fee, 90% to dataset owner

export interface ConnectSplit {
  totalAmountCents: number;
  platformFeeCents: number;
  ownerPayoutCents: number;
  destinationAccountId: string;
}

export interface CreateConnectAccountRequest {
  email?: string;
  datasetOwnerId: string;
  country?: string;
}

export interface ConnectOnboardingLinkResponse {
  accountId: string;
  onboardingUrl: string;
  expiresAt: number;
}

/**
 * Validates a Stripe Connect account ID format (`acct_...`) and computes
 * the platform application fee vs. dataset owner payout split.
 */
export function calculateConnectSplit(
  amountCents: number,
  destinationAccountId: string,
  platformFeeBps: number = DEFAULT_PLATFORM_FEE_BPS
): ConnectSplit {
  const trimmedAccount = destinationAccountId.trim();
  if (!trimmedAccount || !trimmedAccount.startsWith("acct_")) {
    throw new PaymentError(
      "INVALID_CONNECT_CONFIG",
      `Invalid Stripe Connect destination account ID: "${destinationAccountId}". Expected format starting with "acct_".`
    );
  }

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new PaymentError(
      "INVALID_CHECKOUT_REQUEST",
      "amountCents must be a positive integer."
    );
  }

  if (
    !Number.isFinite(platformFeeBps) ||
    platformFeeBps < 0 ||
    platformFeeBps > 10000
  ) {
    throw new PaymentError(
      "INVALID_CONNECT_CONFIG",
      "platformFeeBps must be between 0 and 10000."
    );
  }

  const platformFeeCents = Math.floor((amountCents * platformFeeBps) / 10000);
  const ownerPayoutCents = amountCents - platformFeeCents;

  return {
    totalAmountCents: amountCents,
    platformFeeCents,
    ownerPayoutCents,
    destinationAccountId: trimmedAccount,
  };
}

/**
 * Builds `payment_intent_data` for a Stripe Checkout Session when routing funds
 * to a dataset owner's Stripe Connect account via destination charges.
 */
export function buildConnectPaymentIntentData(
  jobId: string,
  amountCents: number,
  ownerAccountId: string,
  platformFeeBps: number = DEFAULT_PLATFORM_FEE_BPS
): Stripe.Checkout.SessionCreateParams.PaymentIntentData {
  const split = calculateConnectSplit(
    amountCents,
    ownerAccountId,
    platformFeeBps
  );

  return {
    application_fee_amount: split.platformFeeCents,
    transfer_data: {
      destination: split.destinationAccountId,
    },
    metadata: {
      jobId,
      ownerAccountId: split.destinationAccountId,
      platformFeeCents: String(split.platformFeeCents),
      ownerPayoutCents: String(split.ownerPayoutCents),
    },
  };
}

/**
 * Creates a Stripe Connect Express account and an Account Link for onboarding
 * a dataset owner on the Sealed marketplace.
 */
export async function createConnectOnboardingLink(
  stripe: Stripe,
  request: CreateConnectAccountRequest,
  refreshUrl: string,
  returnUrl: string
): Promise<ConnectOnboardingLinkResponse> {
  if (!request.datasetOwnerId || !request.datasetOwnerId.trim()) {
    throw new PaymentError(
      "INVALID_CONNECT_CONFIG",
      "datasetOwnerId is required to create a Stripe Connect account."
    );
  }

  const account = await stripe.accounts.create({
    type: "express",
    country: request.country ?? "US",
    email: request.email,
    capabilities: {
      transfers: { requested: true },
    },
    metadata: {
      datasetOwnerId: request.datasetOwnerId.trim(),
    },
  });

  const accountLink = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  });

  return {
    accountId: account.id,
    onboardingUrl: accountLink.url,
    expiresAt: accountLink.expires_at,
  };
}
