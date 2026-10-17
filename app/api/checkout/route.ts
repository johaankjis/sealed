import { AgentError, startCheckout } from "../../../lib/agent/orchestrator";
import { errorResponse, readJsonObject } from "../../../lib/agent/http";
import { getAgentRuntime } from "../../../lib/agent/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/checkout { jobId } -> CheckoutResponse. The price comes from the
// server catalog; the buyer only names the job.
export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    if (typeof body.jobId !== "string") {
      throw new AgentError("invalid_request", "jobId is required");
    }
    const runtime = getAgentRuntime();
    if (!(await runtime.store.get(body.jobId))) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }
    const checkout = await startCheckout(runtime.deps, body.jobId);
    return Response.json(checkout);
  } catch (err) {
    return errorResponse(err);
  }
}
