import type {
  PaymentProvider,
  PaymentVerification,
} from "@/contracts/payments";
import { PaymentError } from "./errors";
import {
  type VerifiedWebhookEvent,
  type VerifyWebhookOptions,
  verifyStripeWebhook,
} from "./webhook";

export interface JobExecutionClaimResult {
  claimed: boolean;
  jobId: string;
  stripeSessionId: string;
  reason?: "already_claimed";
}

export interface WebhookDispatchResult {
  event: VerifiedWebhookEvent;
  duplicateEvent: boolean;
  claimedForExecution: boolean;
}

/**
 * Enforces the security rule: "No execution of paid queries before verified payment."
 * Throws `PaymentError("PAYMENT_NOT_VERIFIED", ...)` unless `verification.paid === true`
 * and matches `expectedJobId` (if provided).
 */
export function assertPaymentVerified(
  verification: PaymentVerification | null | undefined,
  expectedJobId?: string
): asserts verification is PaymentVerification & { paid: true } {
  if (!verification || !verification.paid) {
    const jobLabel = expectedJobId ?? verification?.jobId ?? "unknown";
    throw new PaymentError(
      "PAYMENT_NOT_VERIFIED",
      `Refusing to execute job "${jobLabel}": payment has not been verified.`
    );
  }

  if (
    expectedJobId !== undefined &&
    verification.jobId.trim() !== expectedJobId.trim()
  ) {
    throw new PaymentError(
      "PAYMENT_NOT_VERIFIED",
      `Payment verification jobId "${verification.jobId}" does not match expected jobId "${expectedJobId}".`
    );
  }

  if (!verification.stripeSessionId || !verification.stripeSessionId.trim()) {
    throw new PaymentError(
      "PAYMENT_NOT_VERIFIED",
      `Payment verification for job "${verification.jobId}" is missing stripeSessionId.`
    );
  }
}

/**
 * Coordinates webhook deduplication, payment verification recording, and atomic
 * single-execution job claims so a paid query is executed at most once and never
 * before payment verification.
 */
export class PaymentExecutionGate {
  private readonly processedEventIds = new Set<string>();
  private readonly verifiedPayments = new Map<string, PaymentVerification>();
  private readonly failedPayments = new Map<string, PaymentVerification>();
  private readonly claimedJobIds = new Set<string>();

  /**
   * Records a verified payment result (`paid: true`) for a job.
   */
  recordVerifiedPayment(verification: PaymentVerification): void {
    assertPaymentVerified(verification);
    const jobId = verification.jobId.trim();
    this.verifiedPayments.set(jobId, {
      jobId,
      paid: true,
      stripeSessionId: verification.stripeSessionId.trim(),
    });
    this.failedPayments.delete(jobId);
  }

  /**
   * Records a failed or expired payment session for a job (unless already paid).
   */
  recordFailedPayment(verification: PaymentVerification): void {
    const jobId = verification.jobId.trim();
    if (this.verifiedPayments.has(jobId)) {
      return;
    }
    this.failedPayments.set(jobId, {
      jobId,
      paid: false,
      stripeSessionId: verification.stripeSessionId.trim(),
    });
  }

  /**
   * Checks whether a job has a verified payment recorded.
   */
  isJobPaid(jobId: string): boolean {
    return this.verifiedPayments.get(jobId.trim())?.paid === true;
  }

  /**
   * Checks whether a job has already been claimed for sandbox execution.
   */
  isJobClaimed(jobId: string): boolean {
    return this.claimedJobIds.has(jobId.trim());
  }

  /**
   * Retrieves the recorded `PaymentVerification` for a job, if any.
   */
  getPaymentStatus(jobId: string): PaymentVerification | undefined {
    const normalized = jobId.trim();
    return (
      this.verifiedPayments.get(normalized) ??
      this.failedPayments.get(normalized)
    );
  }

  /**
   * Atomically claims a paid job for execution.
   * - Throws `PaymentError("PAYMENT_NOT_VERIFIED")` if the job is not verified as paid.
   * - Returns `{ claimed: true }` on the first claim for `jobId`.
   * - Returns `{ claimed: false, reason: "already_claimed" }` on any subsequent call.
   */
  claimPaidJob(jobId: string): JobExecutionClaimResult {
    const normalizedJobId = jobId?.trim();
    const verification = this.verifiedPayments.get(normalizedJobId);
    assertPaymentVerified(verification, normalizedJobId);

    if (this.claimedJobIds.has(normalizedJobId)) {
      return {
        claimed: false,
        jobId: normalizedJobId,
        stripeSessionId: verification.stripeSessionId,
        reason: "already_claimed",
      };
    }

    this.claimedJobIds.add(normalizedJobId);
    return {
      claimed: true,
      jobId: normalizedJobId,
      stripeSessionId: verification.stripeSessionId,
    };
  }

  /**
   * Verifies payment directly via a `PaymentProvider` (`verifyPayment(sessionId)`),
   * enforces `expectedJobId`, and atomically claims the job for execution.
   */
  async verifyAndClaimJob(
    provider: PaymentProvider,
    sessionId: string,
    expectedJobId?: string
  ): Promise<JobExecutionClaimResult> {
    const verification = await provider.verifyPayment(sessionId);
    assertPaymentVerified(verification, expectedJobId);
    this.recordVerifiedPayment(verification);
    return this.claimPaidJob(verification.jobId);
  }

  /**
   * Verifies a signed Stripe webhook payload, deduplicates by `event.id`, updates
   * payment status, and—if the event marks the job as paid—atomically claims the
   * job for execution at most once.
   */
  async handleWebhook(
    rawBody: string | Buffer,
    signatureHeader: string | null | undefined,
    options: VerifyWebhookOptions & {
      onPaidJobClaimed?: (verification: PaymentVerification) => Promise<void> | void;
      onPaymentFailed?: (verification: PaymentVerification) => Promise<void> | void;
    } = {}
  ): Promise<WebhookDispatchResult> {
    const event = verifyStripeWebhook(rawBody, signatureHeader, options);

    if (this.processedEventIds.has(event.eventId)) {
      return {
        event,
        duplicateEvent: true,
        claimedForExecution: false,
      };
    }

    this.processedEventIds.add(event.eventId);

    if (event.action === "mark_paid" && event.verification) {
      this.recordVerifiedPayment(event.verification);
      const claim = this.claimPaidJob(event.verification.jobId);

      if (claim.claimed && options.onPaidJobClaimed) {
        await options.onPaidJobClaimed(event.verification);
      }

      return {
        event,
        duplicateEvent: false,
        claimedForExecution: claim.claimed,
      };
    }

    if (event.action === "mark_failed" && event.verification) {
      this.recordFailedPayment(event.verification);
      if (options.onPaymentFailed) {
        await options.onPaymentFailed(event.verification);
      }
    }

    return {
      event,
      duplicateEvent: false,
      claimedForExecution: false,
    };
  }
}
