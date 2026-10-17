export interface CheckoutRequest {
  jobId: string;
  amountCents: number;
  currency: "usd";
  ownerAccountId?: string;
}

export interface CheckoutResponse {
  sessionId: string;
  checkoutUrl: string;
}

export interface PaymentVerification {
  jobId: string;
  paid: boolean;
  stripeSessionId: string;
}

export interface PaymentProvider {
  createCheckout(
    request: CheckoutRequest
  ): Promise<CheckoutResponse>;

  verifyPayment(
    sessionId: string
  ): Promise<PaymentVerification>;
}
