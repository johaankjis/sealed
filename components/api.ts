import type { QueryJob } from "../contracts/job";
import type { CheckoutResponse } from "../contracts/payments";

/**
 * Thin same-origin client for the backend routes owned by
 * the orchestration / payments agents.
 *
 * Expected endpoints (see components/INTEGRATION.md):
 * - POST /api/jobs            { datasetId, question } -> QueryJob
 * - GET  /api/jobs/:id        -> QueryJob
 * - POST /api/checkout        { jobId } -> CheckoutResponse
 */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  if (typeof body === "string" && body.length > 0) return body;
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Is the backend running?");
  }
  const body = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(body, `Request failed (${res.status})`));
  }
  return body as T;
}

export function createJob(datasetId: string, question: string): Promise<QueryJob> {
  return request<QueryJob>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ datasetId, question }),
  });
}

export function getJob(jobId: string): Promise<QueryJob> {
  return request<QueryJob>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function createCheckout(jobId: string): Promise<CheckoutResponse> {
  return request<CheckoutResponse>("/api/checkout", {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}
