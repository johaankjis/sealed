import { errorResponse } from "../../../../lib/agent/http";
import { getAgentRuntime, reconcilePayment, toBuyerJob } from "../../../../lib/agent/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/jobs/:id -> QueryJob. While payment is pending, this checks Stripe
// using the server-stored session ID (no buyer input) so the polling UI
// advances even without a webhook.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const runtime = getAgentRuntime();
    const job = await runtime.store.get(id);
    if (!job) return Response.json({ error: "Job not found" }, { status: 404 });

    let current = job;
    try {
      current = await reconcilePayment(job, runtime);
    } catch {
      // Stripe unavailable or unconfigured: report the stored state.
    }
    return Response.json(toBuyerJob(current));
  } catch (err) {
    return errorResponse(err);
  }
}
