import type Stripe from "stripe";
import { DEMO_DATASETS } from "../../components/datasets";
import type { QueryJob } from "../../contracts/job";
import type { PaymentProvider, PaymentVerification } from "../../contracts/payments";
import {
  type AgentDeps,
  AgentError,
  type AgentEvent,
  confirmPayment,
  type DatasetCatalog,
  type DatasetDescriptor,
  executeJob,
  failPayment,
  InMemoryJobStore,
  type JobStore,
  StaticDatasetCatalog,
  startCheckout,
} from "../agent";
import { PaymentError } from "./errors";
import { PaymentExecutionGate } from "./idempotency";
import {
  MIN_USD_AMOUNT_CENTS,
  StripePaymentProvider,
} from "./stripe-provider";
import { verifyStripeWebhookDetailed } from "./webhook";

export interface PaymentRouteDeps {
  store: JobStore;
  datasets: DatasetCatalog;
  payments: PaymentProvider;
  webhookSecret?: string;
  stripeClient?: Stripe;
  onEvent?: (event: AgentEvent) => void;
  onPaidJobConfirmed?: (job: QueryJob) => Promise<void> | void;
}

interface GlobalAgentRuntimeShape {
  deps: Partial<AgentDeps> & {
    store: JobStore;
    datasets: DatasetCatalog;
    payments: PaymentProvider;
  };
  store: JobStore;
}

const globalRef = globalThis as typeof globalThis & {
  __sealedAgent?: GlobalAgentRuntimeShape;
  __sealedPaymentRouteDeps?: PaymentRouteDeps;
  __sealedDefaultPaymentRouteDeps?: PaymentRouteDeps;
  __sealedWebhookGate?: PaymentExecutionGate;
  __sealedProcessedWebhookEvents?: Set<string>;
};

function buildDefaultDatasetCatalog(): DatasetCatalog {
  const descriptors: DatasetDescriptor[] = DEMO_DATASETS.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    path: `lib/agent/fixtures/${item.id}.csv`,
    tableName: "dataset",
    columns: [],
    priceCents: item.priceCents,
  }));
  return new StaticDatasetCatalog(descriptors);
}

function buildLazyPaymentProvider(): PaymentProvider {
  let provider: PaymentProvider | undefined;
  const getProvider = () => (provider ??= new StripePaymentProvider());
  return {
    createCheckout: (req) => getProvider().createCheckout(req),
    verifyPayment: (sessionId) => getProvider().verifyPayment(sessionId),
  };
}

function getProcessedWebhookEvents(): Set<string> {
  return (globalRef.__sealedProcessedWebhookEvents ??= new Set<string>());
}

function getWebhookGate(): PaymentExecutionGate {
  return (globalRef.__sealedWebhookGate ??= new PaymentExecutionGate());
}

/**
 * Resolves the shared `JobStore`, `DatasetCatalog`, and `PaymentProvider`
 * from Claude's `globalThis.__sealedAgent` runtime when present, or test-injected
 * overrides set via `setPaymentRouteDeps`.
 */
export function getPaymentRouteDeps(): PaymentRouteDeps {
  if (globalRef.__sealedPaymentRouteDeps) {
    return globalRef.__sealedPaymentRouteDeps;
  }

  const agentRuntime = globalRef.__sealedAgent;
  if (agentRuntime?.deps) {
    const { store, datasets, payments, onEvent, sandbox, policy, codegen } =
      agentRuntime.deps;
    return {
      store,
      datasets,
      payments,
      onEvent,
      onPaidJobConfirmed:
        sandbox && policy && codegen
          ? async (job) => {
              await executeJob(agentRuntime.deps as AgentDeps, job.id).catch(
                (err: unknown) => {
                  const code =
                    (err as { code?: string })?.code ??
                    (err as Error)?.name ??
                    "unknown";
                  console.error(
                    "[sealed] background job execution failed",
                    job.id,
                    code
                  );
                }
              );
            }
          : undefined,
    };
  }

  return (globalRef.__sealedDefaultPaymentRouteDeps ??= {
    store: new InMemoryJobStore(),
    datasets: buildDefaultDatasetCatalog(),
    payments: buildLazyPaymentProvider(),
  });
}

/**
 * Test hook to configure or reset dependencies for `/api/checkout` and
 * `/api/webhooks/stripe` routes. Also clears processed webhook event state when reset.
 */
export function setPaymentRouteDeps(deps: PaymentRouteDeps | undefined): void {
  globalRef.__sealedPaymentRouteDeps = deps;
  if (deps === undefined) {
    globalRef.__sealedProcessedWebhookEvents?.clear();
    globalRef.__sealedWebhookGate = new PaymentExecutionGate();
  }
}

async function parseJsonObject(
  request: Request
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new AgentError("invalid_request", "Request body must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentError(
      "invalid_request",
      "Request body must be a JSON object"
    );
  }

  return parsed as Record<string, unknown>;
}

function mapCheckoutErrorToResponse(err: unknown): Response {
  if (err instanceof AgentError) {
    switch (err.code) {
      case "invalid_request":
        return Response.json({ error: err.message }, { status: 400 });
      case "dataset_not_found":
        return Response.json({ error: "Unknown dataset" }, { status: 404 });
      case "invalid_state":
        return Response.json(
          { error: "Job is not in a state that allows checkout" },
          { status: 409 }
        );
      default:
        return Response.json(
          { error: "Request could not be completed" },
          { status: 422 }
        );
    }
  }

  if (err instanceof PaymentError) {
    if (err.code === "INVALID_CHECKOUT_REQUEST") {
      return Response.json({ error: err.message }, { status: 400 });
    }
    if (err.code === "MISSING_STRIPE_CONFIG") {
      return Response.json(
        { error: "Payment service is not configured" },
        { status: 503 }
      );
    }
    return Response.json({ error: "Payment service error" }, { status: 502 });
  }

  if ((err as { name?: string })?.name === "ConfigError") {
    return Response.json(
      { error: "Service is not configured" },
      { status: 503 }
    );
  }

  return Response.json({ error: "Internal server error" }, { status: 500 });
}

/**
 * Handles `POST /api/checkout`:
 * - Requires an existing server-side job (`store.get(jobId)`).
 * - Resolves pricing exclusively from the server-side `DatasetCatalog` (`dataset.priceCents` in `"usd"`),
 *   never from buyer request input.
 * - Creates a Stripe Checkout session and transitions the job to `"payment_pending"`.
 */
export async function handleCheckoutPost(
  request: Request,
  depsOverride?: PaymentRouteDeps
): Promise<Response> {
  try {
    const body = await parseJsonObject(request);
    if (typeof body.jobId !== "string" || !body.jobId.trim()) {
      throw new AgentError("invalid_request", "jobId is required");
    }

    const jobId = body.jobId.trim();
    const deps = depsOverride ?? getPaymentRouteDeps();

    const job = await deps.store.get(jobId);
    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    const dataset = await deps.datasets.get(job.datasetId);
    if (!dataset) {
      return Response.json({ error: "Unknown dataset" }, { status: 404 });
    }

    if (
      !Number.isInteger(dataset.priceCents) ||
      dataset.priceCents < MIN_USD_AMOUNT_CENTS
    ) {
      throw new PaymentError(
        "INVALID_CHECKOUT_REQUEST",
        `Dataset "${dataset.id}" has invalid server priceCents (${String(dataset.priceCents)}).`
      );
    }

    const checkout = await startCheckout(
      {
        store: deps.store,
        datasets: deps.datasets,
        payments: deps.payments,
      },
      jobId
    );

    return Response.json(checkout, { status: 200 });
  } catch (err) {
    return mapCheckoutErrorToResponse(err);
  }
}

/**
 * Handles `POST /api/webhooks/stripe`:
 * Verifies:
 * 1. Cryptographic Stripe webhook signature (`stripe-signature` header + `STRIPE_WEBHOOK_SECRET`).
 * 2. Job association (`job` exists in `JobStore`, `job.id === session.jobId`, `job.stripeSessionId === session.id`,
 *    and `store.findByStripeSession(session.id)?.id === job.id`).
 * 3. Paid status (`session.payment_status === "paid"`, `session.status !== "expired"`, plus provider verification).
 * 4. Amount (`session.amount_total === dataset.priceCents`).
 * 5. Currency (`session.currency === "usd"`).
 * Then idempotently transitions the job to `"paid"` in Claude's `JobStore`.
 */
export async function handleStripeWebhookPost(
  request: Request,
  depsOverride?: PaymentRouteDeps
): Promise<Response> {
  const deps = depsOverride ?? getPaymentRouteDeps();
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  let event: ReturnType<typeof verifyStripeWebhookDetailed>;
  try {
    event = verifyStripeWebhookDetailed(rawBody, signature, {
      webhookSecret: deps.webhookSecret,
      stripeClient: deps.stripeClient,
    });
  } catch (err) {
    if (err instanceof PaymentError) {
      if (err.code === "MISSING_STRIPE_CONFIG") {
        return Response.json(
          { error: "Webhook secret is not configured" },
          { status: 503 }
        );
      }
      return Response.json({ error: err.message }, { status: 400 });
    }
    return Response.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  const isCompletionEvent =
    event.eventType === "checkout.session.completed" ||
    event.eventType === "checkout.session.async_payment_succeeded";
  const isFailureEvent =
    event.eventType === "checkout.session.expired" ||
    event.eventType === "checkout.session.async_payment_failed";

  if (!isCompletionEvent && !isFailureEvent) {
    return Response.json(
      { received: true, action: "ignore", eventType: event.eventType },
      { status: 200 }
    );
  }

  const session = event.session;
  if (!session) {
    return Response.json(
      { error: "Webhook event is missing Checkout Session details" },
      { status: 400 }
    );
  }

  // Verify job association against Claude's JobStore
  const [jobById, jobBySession] = await Promise.all([
    deps.store.get(session.jobId),
    deps.store.findByStripeSession(session.sessionId),
  ]);

  if (!jobById) {
    return Response.json(
      { error: `Unknown job "${session.jobId}" referenced by webhook` },
      { status: 400 }
    );
  }

  if (
    !jobById.stripeSessionId ||
    jobById.stripeSessionId !== session.sessionId ||
    !jobBySession ||
    jobBySession.id !== jobById.id
  ) {
    return Response.json(
      {
        error: `Stripe session "${session.sessionId}" is not associated with job "${jobById.id}"`,
      },
      { status: 400 }
    );
  }

  const processedEvents = getProcessedWebhookEvents();

  if (isFailureEvent) {
    if (processedEvents.has(event.eventId)) {
      return Response.json(
        {
          received: true,
          duplicate: true,
          jobId: jobById.id,
          status: jobById.status,
        },
        { status: 200 }
      );
    }

    const updated = await failPayment(
      { store: deps.store },
      session.sessionId
    );
    processedEvents.add(event.eventId);
    getWebhookGate().recordFailedPayment({
      jobId: jobById.id,
      paid: false,
      stripeSessionId: session.sessionId,
    });

    return Response.json(
      {
        received: true,
        duplicate: false,
        jobId: jobById.id,
        status: updated?.status ?? jobById.status,
      },
      { status: 200 }
    );
  }

  // Completion event: verify paid status, amount, and currency before marking paid
  if (
    session.paymentStatus !== "paid" ||
    session.sessionStatus === "expired" ||
    !event.verification?.paid
  ) {
    return Response.json(
      { error: "Checkout session payment_status is not paid" },
      { status: 400 }
    );
  }

  const dataset = await deps.datasets.get(jobById.datasetId);
  if (!dataset) {
    return Response.json(
      { error: `Unknown dataset "${jobById.datasetId}" for job "${jobById.id}"` },
      { status: 400 }
    );
  }

  if (session.currency !== "usd") {
    return Response.json(
      {
        error: `Invalid payment currency "${String(session.currency)}": expected "usd"`,
      },
      { status: 400 }
    );
  }

  if (
    typeof session.amountTotal !== "number" ||
    session.amountTotal !== dataset.priceCents
  ) {
    return Response.json(
      {
        error: `Payment amount mismatch for job "${jobById.id}": expected ${dataset.priceCents} cents, received ${String(session.amountTotal)} cents`,
      },
      { status: 400 }
    );
  }

  // Deduplicate repeated webhook deliveries by eventId or already-paid job status
  if (processedEvents.has(event.eventId)) {
    return Response.json(
      {
        received: true,
        duplicate: true,
        jobId: jobById.id,
        status: jobById.status,
      },
      { status: 200 }
    );
  }

  if (
    jobById.status === "paid" ||
    jobById.status === "running" ||
    jobById.status === "validating" ||
    jobById.status === "completed"
  ) {
    processedEvents.add(event.eventId);
    return Response.json(
      {
        received: true,
        duplicate: true,
        jobId: jobById.id,
        status: jobById.status,
      },
      { status: 200 }
    );
  }

  if (jobById.status !== "payment_pending") {
    return Response.json(
      {
        error: `Job "${jobById.id}" cannot be marked paid from status "${jobById.status}"`,
      },
      { status: 409 }
    );
  }

  // Re-verify with the configured PaymentProvider
  let providerVerification: PaymentVerification;
  try {
    if (deps.payments instanceof StripePaymentProvider) {
      const detailed = await deps.payments.verifyCheckoutSessionDetails(
        session.sessionId
      );
      if (detailed.currency !== null && detailed.currency !== "usd") {
        return Response.json(
          {
            error: `Retrieved Stripe session currency "${detailed.currency}" does not match expected "usd"`,
          },
          { status: 400 }
        );
      }
      if (
        detailed.amountTotal !== null &&
        detailed.amountTotal !== dataset.priceCents
      ) {
        return Response.json(
          {
            error: `Retrieved Stripe session amount (${detailed.amountTotal}) does not match expected ${dataset.priceCents} cents`,
          },
          { status: 400 }
        );
      }
      providerVerification = {
        jobId: detailed.jobId,
        paid: detailed.paid,
        stripeSessionId: detailed.stripeSessionId,
      };
    } else {
      providerVerification = await deps.payments.verifyPayment(
        session.sessionId
      );
    }
  } catch (err) {
    if (err instanceof PaymentError && err.code === "MISSING_STRIPE_CONFIG") {
      return Response.json(
        { error: "Payment service is not configured" },
        { status: 503 }
      );
    }
    return Response.json(
      { error: "Failed to verify payment session with provider" },
      { status: 502 }
    );
  }

  if (
    !providerVerification.paid ||
    providerVerification.jobId !== jobById.id ||
    providerVerification.stripeSessionId !== session.sessionId
  ) {
    return Response.json(
      { error: "Payment verification with provider failed" },
      { status: 400 }
    );
  }

  const preVerifiedProvider: PaymentProvider = {
    createCheckout: (req) => deps.payments.createCheckout(req),
    verifyPayment: async () => providerVerification,
  };

  const updated = await confirmPayment(
    {
      store: deps.store,
      payments: preVerifiedProvider,
      onEvent: deps.onEvent,
    },
    session.sessionId
  );

  processedEvents.add(event.eventId);

  const gate = getWebhookGate();
  gate.recordVerifiedPayment(providerVerification);
  const claim = gate.claimPaidJob(jobById.id);

  if (claim.claimed && updated?.status === "paid" && deps.onPaidJobConfirmed) {
    void Promise.resolve(deps.onPaidJobConfirmed(updated));
  }

  return Response.json(
    {
      received: true,
      duplicate: !claim.claimed,
      jobId: jobById.id,
      status: updated?.status ?? "paid",
    },
    { status: 200 }
  );
}
