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
 * single-execution job claims within a single Node.js process so a paid query
 * is executed at most once and never before payment verification.
 *
 * Durability limitation: This class stores state in process memory (`Set`/`Map`).
 * It does NOT survive process restarts or coordinate across multiple server
 * instances; production deployments require durable storage (e.g., PostgreSQL
 * unique event log + atomic `UPDATE ... WHERE status = 'paid'` claim).
 */
export class PaymentExecutionGate {
  private readonly processedEventIds = new Set<string>();
  private readonly inFlightEventIds = new Set<string>();
  private readonly verifiedPayments = new Map<string, PaymentVerification>();
  private readonly failedPayments = new Map<string, PaymentVerification>();
  private readonly claimedJobIds = new Set<string>();
  private readonly inFlightJobIds = new Set<string>();

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
   * Checks whether a job is currently claimed (in-flight or completed) for sandbox execution.
   */
  isJobClaimed(jobId: string): boolean {
    return this.claimedJobIds.has(jobId.trim());
  }

  /**
   * Checks whether a webhook `eventId` has completed processing.
   */
  isEventProcessed(eventId: string): boolean {
    return this.processedEventIds.has(eventId.trim());
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
   * Releases a previously acquired job claim when downstream execution initiation
   * fails before completion, allowing a subsequent retry to claim the job.
   */
  releaseJobClaim(jobId: string): void {
    const normalizedJobId = jobId?.trim();
    if (!normalizedJobId) return;
    this.claimedJobIds.delete(normalizedJobId);
    this.inFlightJobIds.delete(normalizedJobId);
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
   *
   * Safe retry guarantee: `event.id` and `jobId` are held as in-flight locks while
   * awaiting `onPaidJobClaimed` / `onPaymentFailed` (preventing concurrent duplicate
   * execution), but are rolled back if the callback throws so retries are not suppressed.
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

    if (
      this.processedEventIds.has(event.eventId) ||
      this.inFlightEventIds.has(event.eventId)
    ) {
      return {
        event,
        duplicateEvent: true,
        claimedForExecution: false,
      };
    }

    if (event.action === "mark_paid" && event.verification) {
      const normalizedJobId = event.verification.jobId.trim();
      this.recordVerifiedPayment(event.verification);

      if (this.claimedJobIds.has(normalizedJobId)) {
        // If the job claim already finished on a prior event, mark this event processed.
        // If the job is still in-flight on another concurrent call, do not mark this
        // event processed yet so it can retry if the in-flight call fails.
        if (!this.inFlightJobIds.has(normalizedJobId)) {
          this.processedEventIds.add(event.eventId);
        }
        return {
          event,
          duplicateEvent: false,
          claimedForExecution: false,
        };
      }

      this.inFlightEventIds.add(event.eventId);
      this.inFlightJobIds.add(normalizedJobId);
      this.claimedJobIds.add(normalizedJobId);

      try {
        if (options.onPaidJobClaimed) {
          await options.onPaidJobClaimed(event.verification);
        }
        this.processedEventIds.add(event.eventId);
        return {
          event,
          duplicateEvent: false,
          claimedForExecution: true,
        };
      } catch (err) {
        this.claimedJobIds.delete(normalizedJobId);
        throw err;
      } finally {
        this.inFlightEventIds.delete(event.eventId);
        this.inFlightJobIds.delete(normalizedJobId);
      }
    }

    if (event.action === "mark_failed" && event.verification) {
      const normalizedJobId = event.verification.jobId.trim();
      const hadFailedBefore = this.failedPayments.has(normalizedJobId);
      this.inFlightEventIds.add(event.eventId);

      try {
        this.recordFailedPayment(event.verification);
        if (options.onPaymentFailed) {
          await options.onPaymentFailed(event.verification);
        }
        this.processedEventIds.add(event.eventId);
        return {
          event,
          duplicateEvent: false,
          claimedForExecution: false,
        };
      } catch (err) {
        if (!hadFailedBefore) {
          this.failedPayments.delete(normalizedJobId);
        }
        throw err;
      } finally {
        this.inFlightEventIds.delete(event.eventId);
      }
    }

    this.processedEventIds.add(event.eventId);
    return {
      event,
      duplicateEvent: false,
      claimedForExecution: false,
    };
  }
}
