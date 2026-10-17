export type PaymentErrorCode =
  | "INVALID_CHECKOUT_REQUEST"
  | "MISSING_STRIPE_CONFIG"
  | "CHECKOUT_CREATION_FAILED"
  | "SESSION_RETRIEVAL_FAILED"
  | "MISSING_JOB_METADATA"
  | "INVALID_WEBHOOK_SIGNATURE"
  | "PAYMENT_NOT_VERIFIED"
  | "INVALID_CONNECT_CONFIG";

export class PaymentError extends Error {
  public readonly code: PaymentErrorCode;
  public readonly cause?: unknown;

  constructor(code: PaymentErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "PaymentError";
    this.code = code;
    this.cause = cause;
  }
}
