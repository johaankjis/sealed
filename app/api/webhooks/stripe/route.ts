import { handleStripeWebhookPost } from "../../../../lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleStripeWebhookPost(request);
}
