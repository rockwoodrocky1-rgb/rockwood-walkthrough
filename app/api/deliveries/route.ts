import { after } from "next/server";
import { z } from "zod";
import {
  deliveryColumns,
  deliveryConfigured,
  deliveryError,
  memberClient,
  processDelivery,
  reportWorkerConfigured,
} from "../../../server/delivery";
import { HttpError } from "../../../server/api";
export const runtime = "nodejs";
export const maxDuration = 180;
const query = z.object({
  workspace: z.uuid(),
  report: z.string().min(1).max(100),
});
async function context(request: Request) {
  const parsed = query.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) throw new HttpError(400, "Choose a saved report.");
  const { client, userId } = await memberClient(request);
  const membership = await client
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", parsed.data.workspace)
    .eq("user_id", userId)
    .maybeSingle();
  if (membership.error || !membership.data)
    throw new HttpError(403, "This report is not available to your account.");
  const job = await client
    .from("report_deliveries")
    .select(deliveryColumns)
    .eq("workspace_id", parsed.data.workspace)
    .eq("report_id", parsed.data.report)
    .maybeSingle();
  if (job.error)
    throw new HttpError(
      503,
      "Report email setup is not complete yet. Your report is saved.",
    );
  return { client, userId, role: membership.data.role, job: job.data };
}
export async function GET(request: Request) {
  try {
    const { client, job } = await context(request);
    let pdfUrl: string | null = null;
    if (job?.pdf_path) {
      const signed = await client.storage
        .from("walkthrough-reports")
        .createSignedUrl(job.pdf_path, 300, {
          download: `rockwood-report-${job.id}.pdf`,
        });
      if (!signed.error) pdfUrl = signed.data.signedUrl;
    }
    return Response.json(
      { job, configured: deliveryConfigured(), pdfUrl },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return deliveryError(error);
  }
}
export async function POST(request: Request) {
  try {
    const { client, userId, role, job } = await context(request);
    if (!job)
      throw new HttpError(
        404,
        "The report is still uploading. Try again shortly.",
      );
    const visit = await client
      .from("walkthroughs")
      .select("created_by")
      .eq("workspace_id", job.workspace_id)
      .eq("id", job.walkthrough_id)
      .maybeSingle();
    if (
      visit.error ||
      !visit.data ||
      (role !== "owner" &&
        !(role === "editor" && visit.data.created_by === userId))
    )
      throw new HttpError(
        403,
        "You can view this report but cannot manage its delivery.",
      );
    if (!reportWorkerConfigured())
      throw new HttpError(
        503,
        "The report PDF worker needs the server connection to be configured.",
      );
    after(async () => {
      await processDelivery(job.id).catch(() => {});
    });
    return Response.json(
      { queued: true },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return deliveryError(error);
  }
}
