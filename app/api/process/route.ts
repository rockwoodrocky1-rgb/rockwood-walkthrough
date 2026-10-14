import { z } from "zod";
import { errorResponse, HttpError, liveEnabled, readLimited } from "../../../server/api";
import { memberClient } from "../../../server/delivery";
import { processingStatusColumns, processingStatusSchema } from "../../../shared/processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const inputSchema = z.object({ workspaceId: z.uuid(), walkthroughId: z.string().min(1).max(100), retry: z.boolean().default(false) });
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    if (process.env.AI_PROVIDER !== "aws" || !liveEnabled())
      throw new HttpError(503, "Automatic reports are not connected yet. Your visit is saved.");
    const origin = request.headers.get("origin");
    if (!origin || !(process.env.ALLOWED_ORIGINS ?? "").split(",").map(v => v.trim()).includes(origin))
      throw new HttpError(403, "This site cannot start report processing.");
    const { client } = await memberClient(request);
    const bytes = await readLimited(request);
    if (bytes.length > 4_000) throw new HttpError(413, "Processing request is too large.");
    const input = inputSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    // The database resolves and freezes the saved visit; no client-supplied
    // media path, snapshot, role or owner is trusted. Its RPC spends the quota.
    const { data, error } = await client.rpc("enqueue_report_processing", {
      workspace_id: input.workspaceId,
      walkthrough_id: input.walkthroughId,
      retry_failed: input.retry,
    });
    if (error) throw new HttpError(409, "The report could not be queued. Reopen the saved visit and retry; the daily processing limit may have been reached.");
    return Response.json({ id: z.uuid().parse(data) }, { status: 202, headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const { client } = await memberClient(request);
    const query = new URL(request.url).searchParams;
    const input = inputSchema.parse({ workspaceId: query.get("workspace"), walkthroughId: query.get("visit") });
    const { data, error } = await client.from("processing_jobs")
      .select(processingStatusColumns)
      .eq("workspace_id", input.workspaceId).eq("walkthrough_id", input.walkthroughId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new HttpError(503, "Could not check report progress. Your saved visit is safe.");
    return Response.json({ job: data ? processingStatusSchema.parse(data) : null }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}
