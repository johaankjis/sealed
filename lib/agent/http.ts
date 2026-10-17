import { PaymentError } from "../payments";
import { AgentError } from "./orchestrator";
import { ConfigError } from "./server";

// Maps backend errors to buyer-safe HTTP responses. Never echoes provider or
// sandbox messages.
export function errorResponse(err: unknown): Response {
  if (err instanceof AgentError) {
    switch (err.code) {
      case "invalid_request":
        return Response.json({ error: err.message }, { status: 400 });
      case "dataset_not_found":
        return Response.json({ error: "Unknown dataset" }, { status: 404 });
      case "invalid_state":
        return Response.json({ error: "Job is not in a state that allows this action" }, { status: 409 });
      default:
        return Response.json({ error: "Request could not be completed" }, { status: 422 });
    }
  }
  if (err instanceof ConfigError || (err instanceof PaymentError && err.code === "MISSING_STRIPE_CONFIG")) {
    console.error("[sealed] configuration error", err instanceof ConfigError ? err.variable : err.code);
    return Response.json({ error: "Service is not configured" }, { status: 503 });
  }
  if (err instanceof PaymentError) {
    console.error("[sealed] payment error", err.code);
    return Response.json({ error: "Payment service error" }, { status: 502 });
  }
  console.error("[sealed] unexpected error", (err as Error)?.name ?? "unknown");
  return Response.json({ error: "Internal error" }, { status: 500 });
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AgentError("invalid_request", "Body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AgentError("invalid_request", "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
