import { z } from "zod";
import { workerClient } from "../../../server/delivery";
import { validShareToken } from "../../../server/report-share";
import { cloudRowSchema } from "../../../src/cloud";
const query = z.object({
  workspace: z.uuid(),
  visit: z.string().min(1).max(100),
  token: z.string().length(64),
});
export const runtime = "nodejs";
export async function GET(request: Request) {
  const parsed = query.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  };
  if (
    !parsed.success ||
    !validShareToken(
      parsed.data.workspace,
      parsed.data.visit,
      parsed.data.token,
    )
  )
    return Response.json(
      { error: "This report link is invalid or no longer available." },
      { status: 404, headers },
    );
  try {
    const { workspace, visit } = parsed.data;
    const client = workerClient();
    const saved = await client
      .from("walkthroughs")
      .select("*")
      .eq("workspace_id", workspace)
      .eq("id", visit)
      .is("archived_at", null)
      .single();
    if (saved.error) throw new Error("unavailable");
    const row = cloudRowSchema.parse(saved.data);
    if (!row.payload.report) throw new Error("unavailable");
    const project = await client
      .from("projects")
      .select("id,name,type,stage,areas,image,number")
      .eq("workspace_id", workspace)
      .eq("id", row.project_id)
      .single();
    if (project.error) throw new Error("unavailable");
    async function media(path: string) {
      if (
        !path.startsWith(`${workspace}/${row.created_by}/`) ||
        path.includes("..")
      )
        throw new Error("invalid path");
      const signed = await client.storage
        .from("walkthrough-media")
        .createSignedUrl(path, 300);
      if (signed.error) throw new Error("unavailable");
      return signed.data.signedUrl;
    }
    const photos = await Promise.all(
      row.payload.photos.map(async (p) => ({
        ...p,
        url: await media(p.original.path),
      })),
    );
    const delivery = await client
      .from("report_deliveries")
      .select("pdf_path")
      .eq("workspace_id", workspace)
      .eq("walkthrough_id", visit)
      .eq("report_id", row.payload.report.id)
      .maybeSingle();
    let pdfUrl: string | null = null;
    if (
      delivery.data?.pdf_path?.startsWith(`${workspace}/`) &&
      !delivery.data.pdf_path.includes("..")
    ) {
      const signed = await client.storage
        .from("walkthrough-reports")
        .createSignedUrl(delivery.data.pdf_path, 300, { download: true });
      if (!signed.error) pdfUrl = signed.data.signedUrl;
    }
    // Never return server credentials, other visitors, or outbox envelopes.
    return Response.json(
      {
        row: { ...row, payload: { ...row.payload, photos } },
        project: project.data,
        audioUrl: row.payload.audio
          ? await media(row.payload.audio.path)
          : null,
        pdfUrl,
      },
      { headers },
    );
  } catch {
    return Response.json(
      { error: "This report link is invalid or no longer available." },
      { status: 404, headers },
    );
  }
}
