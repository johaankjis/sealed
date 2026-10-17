import { AgentError, createJob } from "../../../lib/agent/orchestrator";
import { errorResponse, readJsonObject } from "../../../lib/agent/http";
import { getAgentRuntime, toBuyerJob } from "../../../lib/agent/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs { datasetId, question } -> 201 QueryJob (status "created").
// Creating a job never executes anything; execution requires verified payment.
export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    if (typeof body.datasetId !== "string" || typeof body.question !== "string") {
      throw new AgentError("invalid_request", "datasetId and question are required strings");
    }
    const job = await createJob(getAgentRuntime().deps, {
      datasetId: body.datasetId,
      question: body.question,
    });
    return Response.json(toBuyerJob(job), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
