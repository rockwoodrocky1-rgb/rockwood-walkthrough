import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { cloudRowSchema } from "../src/cloud";
import { createReportPdf } from "./report-pdf";
import { HttpError } from "./api";
import { sharedReportLink } from "./report-share";
import nodemailer from "nodemailer";
import { awsClientOptions } from "./aws-config";
import { sendSesReport, SES_REPORT_RECIPIENT } from "./aws-ses";

export const REPORT_RECIPIENT = SES_REPORT_RECIPIENT;
export const deliveryColumns =
  "id,workspace_id,walkthrough_id,report_id,revision,status,pdf_path,last_error,created_at,sent_at";
export function reportWorkerConfigured() {
  return (
    process.env.REPORT_DELIVERY_ENABLED === "true" &&
    ["SUPABASE_SECRET_KEY", "APP_URL"].every((k) => !!process.env[k]?.trim())
  );
}
export function deliveryConfigured() {
  return (
    reportWorkerConfigured() &&
    emailActivationCutoff() !== false &&
    providerConfigured(selectedProvider())
  );
}
function selectedProvider(): Envelope["provider"] {
  if (process.env.REPORT_EMAIL_PROVIDER === "ses") return "ses";
  return process.env.GMAIL_APP_PASSWORD?.trim() ? "gmail" : "resend";
}
function providerConfigured(provider: Envelope["provider"]) {
  // Explicitly disabling email overrides legacy credentials and frozen envelopes.
  if (process.env.REPORT_EMAIL_PROVIDER?.trim() === "disabled") return false;
  if (provider === "gmail") return !!process.env.GMAIL_APP_PASSWORD?.trim();
  if (provider === "resend")
    return (
      !!process.env.RESEND_API_KEY?.trim() &&
      !!process.env.REPORT_EMAIL_FROM?.trim()
    );
  if (
    process.env.REPORT_EMAIL_PROVIDER !== "ses" ||
    !process.env.REPORT_EMAIL_FROM?.trim()
  )
    return false;
  try {
    return !!awsClientOptions().region;
  } catch {
    return false;
  }
}
// A missing cutoff preserves existing installations. A malformed configured
// cutoff fails closed so a typo cannot release the old report backlog.
function emailActivationCutoff(): number | false | undefined {
  const configured = process.env.REPORT_EMAIL_NOT_BEFORE?.trim();
  if (!configured) return undefined;
  if (!z.iso.datetime({ offset: true }).safeParse(configured).success) return false;
  const timestamp = Date.parse(configured);
  return Number.isFinite(timestamp) ? timestamp : false;
}
function hasUncertainSend(provider: Envelope["provider"]) {
  return provider === "gmail" || provider === "ses";
}
const uncertainSendMessage =
  "Email delivery confirmation needs review. Check the inbox before resending.";
export function workerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key)
    throw new HttpError(
      503,
      "Report delivery needs the server connection to be configured.",
    );
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
    },
  });
}
export async function memberClient(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !authorization.startsWith("Bearer "))
    throw new HttpError(401, "Sign in to view this report.");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: authorization },
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
    },
  });
  const { data, error } = await client.auth.getUser(authorization.slice(7));
  if (
    error ||
    !data.user ||
    (!data.user.email_confirmed_at && !data.user.is_anonymous)
  )
    throw new HttpError(401, "Sign in again to view this report.");
  return { client, userId: data.user.id };
}
const envelopeSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  filename: z.string(),
  provider: z.enum(["gmail", "resend", "ses"]),
});
type Envelope = z.infer<typeof envelopeSchema>;
const jobSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  walkthrough_id: z.string(),
  report_id: z.string(),
  revision: z.number(),
  created_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  snapshot: cloudRowSchema,
  project_name: z.string(),
  is_sample_project: z.boolean(),
  attempts: z.number(),
  lease_token: z.uuid(),
  send_started_at: z.string().nullable(),
  email_envelope: envelopeSchema.nullable(),
  pdf_path: z.string().nullable(),
});
export function reportLink(
  appUrl: string,
  projectId: string,
  sessionId: string,
) {
  const url = new URL(appUrl);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error("APP_URL requires HTTPS.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("APP_URL must be a plain site origin.");
  url.pathname = "/";
  url.searchParams.set("report", sessionId);
  url.searchParams.set("project", projectId);
  return url.toString();
}
export function emailEnvelope(
  from: string,
  reportUrl: string,
  projectName: string,
  jobId: string,
  isTest: boolean,
  provider: Envelope["provider"] = "gmail",
): Envelope {
  const project = projectName.replace(/[\r\n]/g, " ").slice(0, 150);
  return {
    provider,
    from,
    to: [REPORT_RECIPIENT],
    subject: `${isTest ? "[TEST] " : ""}Rockwood walkthrough - ${project}`,
    text: `A new walkthrough report is ready for ${project}.\n\nThe attached PDF includes the report and photos as first created. Draft reports need review.\n\nOpen the saved report to evaluate original photos, audio, notes, and later edits:\n${reportUrl}\n\nThe link opens this report without signing in. Anyone with this link can view this visit; share it only with the intended reviewers.\n${isTest ? "\nThis report uses a fictional test project.\n" : ""}\nRockwood Development`,
    filename: `rockwood-report-${jobId}.pdf`,
  };
}
export async function sendReportEmail(
  envelope: Envelope,
  pdf: Uint8Array,
  jobId: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
) {
  const { filename, provider: _provider, ...email } = envelope;
  void _provider;
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `rockwood-report/${jobId}`,
    },
    body: JSON.stringify({
      ...email,
      attachments: [{ filename, content: Buffer.from(pdf).toString("base64") }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      "The email provider did not accept the report. Delivery will retry automatically.",
    );
  return z.object({ id: z.string().min(1) }).parse(await response.json()).id;
}
export async function sendGmailReport(
  envelope: Envelope,
  pdf: Uint8Array,
  jobId: string,
  password: string,
) {
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: REPORT_RECIPIENT, pass: password.replace(/\s/g, "") },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    const { filename, provider: _provider, ...message } = envelope;
    void _provider;
    const sent = await transport.sendMail({
      ...message,
      from: `Rockwood Development <${REPORT_RECIPIENT}>`,
      messageId: `<rockwood-report-${jobId}@gmail.com>`,
      attachments: [
        { filename, content: Buffer.from(pdf), contentType: "application/pdf" },
      ],
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!sent.accepted?.includes(REPORT_RECIPIENT))
      throw new Error("Gmail did not accept the report.");
    return sent.messageId as string;
  } finally {
    transport.close();
  }
}
export async function processDelivery(
  jobId?: string,
  injectedClient?: SupabaseClient,
) {
  if (!reportWorkerConfigured()) return { configured: false, processed: false };
  const client = injectedClient ?? workerClient();
  const claimed = await client.rpc("claim_report_delivery", {
    job_id: jobId ?? null,
  });
  if (claimed.error)
    throw new HttpError(503, "Report delivery queue is unavailable.");
  if (!claimed.data?.length) return { configured: true, processed: false };
  const job = jobSchema.parse(claimed.data[0]);
  async function patch(fields: Record<string, unknown>) {
    const { data, error } = await client
      .from("report_deliveries")
      .update(fields)
      .eq("id", job.id)
      .eq("lease_token", job.lease_token)
      .eq("status", "processing")
      .select("id")
      .maybeSingle();
    if (error || !data)
      throw new Error("Report delivery lease could not be saved.");
  }
  let nonIdempotentSendStarted = false;
  let phase = "read-report";
  try {
    if (
      job.send_started_at &&
      job.email_envelope &&
      hasUncertainSend(job.email_envelope.provider)
    ) {
      // Neither SMTP nor SES offers provider-side idempotency. A recovered
      // lease must not replay a message whose acceptance is uncertain.
      await patch({
        status: "needs_attention",
        last_error: uncertainSendMessage,
        lease_token: null,
        lease_until: null,
      });
      return { configured: true, processed: true };
    }
    const row = job.snapshot;
    if (
      row.workspace_id !== job.workspace_id ||
      row.id !== job.walkthrough_id ||
      row.payload.report?.id !== job.report_id
    )
      throw new Error("Report snapshot is invalid.");
    if (
      row.payload.language === "es" &&
      row.payload.report.outputLanguage !== "en"
    )
      throw new Error("The English report must be prepared before delivery.");
    // Do not send an archived visit that was waiting in the queue.
    const current = await client
      .from("walkthroughs")
      .select("archived_at")
      .eq("workspace_id", job.workspace_id)
      .eq("id", job.walkthrough_id)
      .single();
    if (current.error) throw new Error("Saved report is unavailable.");
    if (current.data.archived_at) {
      await patch({
        status: "cancelled",
        lease_token: null,
        lease_until: null,
      });
      return { configured: true, processed: true };
    }
    const path = `${job.workspace_id}/${job.id}.pdf`;
    const storage = client.storage.from("walkthrough-reports");
    let pdf: Uint8Array;
    if (job.pdf_path) {
      if (job.pdf_path !== path) throw new Error("Unexpected PDF location.");
      const stored = await storage.download(path);
      if (stored.error || !stored.data)
        throw new Error("Saved PDF could not be loaded.");
      pdf = new Uint8Array(await stored.data.arrayBuffer());
    } else {
      const photos: Uint8Array[] = [];
      phase = "read-photos";
      for (const photo of row.payload.photos) {
        if (
          !photo.model.path.startsWith(`${job.workspace_id}/`) ||
          photo.model.path.includes("..") ||
          photo.model.size > 1_000_000
        )
          throw new Error("Report photo is invalid.");
        const result = await client.storage
          .from("walkthrough-media")
          .download(photo.model.path);
        if (result.error || !result.data || result.data.size > 1_000_000)
          throw new Error("Report photo could not be loaded.");
        photos.push(new Uint8Array(await result.data.arrayBuffer()));
      }
      phase = "render-pdf";
      pdf = await createReportPdf({
        row,
        projectName: job.project_name,
        isSampleProject: job.is_sample_project,
        reportUrl: sharedReportLink(
          process.env.APP_URL!,
          row.workspace_id,
          row.id,
        ),
        photos,
      });
      if (pdf.length > 10_000_000)
        throw new Error("Report PDF exceeds the delivery size limit.");
      phase = "save-pdf";
      const uploaded = await storage.upload(path, pdf, {
        contentType: "application/pdf",
        upsert: false,
      });
      if (uploaded.error) {
        // A previous attempt can have uploaded before its database write timed out.
        if (
          String((uploaded.error as { statusCode?: string }).statusCode) !==
          "409"
        )
          throw new Error("Report PDF could not be saved.");
        const stored = await storage.download(path);
        if (stored.error || !stored.data)
          throw new Error("Saved PDF could not be loaded.");
        pdf = new Uint8Array(await stored.data.arrayBuffer());
      }
      phase = "save-pdf-status";
      await patch({ pdf_path: path });
    }
    const provider = job.email_envelope?.provider ?? selectedProvider();
    if (!deliveryConfigured() || !providerConfigured(provider)) {
      await patch({
        status: "queued",
        next_attempt_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        last_error:
          "PDF saved. Automatic email is awaiting sender authorization.",
        lease_token: null,
        lease_until: null,
      });
      return { configured: true, processed: false };
    }
    const cutoff = emailActivationCutoff();
    if (typeof cutoff === "number" && Date.parse(job.created_at) < cutoff) {
      // Activation is prospective. Preserve earlier reports/PDFs without
      // unexpectedly emailing private QA or user reports from the backlog.
      await patch({
        status: "needs_attention",
        last_error:
          "Report predates automatic email activation. Review before sending.",
        lease_token: null,
        lease_until: null,
      });
      return { configured: true, processed: false };
    }
    const envelope =
      job.email_envelope ??
      emailEnvelope(
        provider === "gmail"
          ? `Rockwood Development <${REPORT_RECIPIENT}>`
          : process.env.REPORT_EMAIL_FROM!,
        sharedReportLink(process.env.APP_URL!, row.workspace_id, row.id),
        job.project_name,
        job.id,
        job.is_sample_project,
        provider,
      );
    // Freeze the exact request across retries, including URL, sender and PDF.
    // Persist before any send so a timeout is always treated as uncertain.
    await patch({
      email_envelope: envelope,
      send_started_at: job.send_started_at ?? new Date().toISOString(),
    });
    nonIdempotentSendStarted = hasUncertainSend(envelope.provider);
    phase = "submit-email";
    const providerId =
      envelope.provider === "gmail"
        ? await sendGmailReport(
            envelope,
            pdf,
            job.id,
            process.env.GMAIL_APP_PASSWORD!,
          )
        : envelope.provider === "ses"
          ? await sendSesReport(envelope, pdf, job.id, awsClientOptions())
          : await sendReportEmail(
              envelope,
              pdf,
              job.id,
              process.env.RESEND_API_KEY!,
            );
    await patch({
      status: "sent",
      provider_id: providerId,
      sent_at: new Date().toISOString(),
      last_error: null,
      lease_token: null,
      lease_until: null,
    });
    return { configured: true, processed: true };
  } catch (error) {
    console.warn("Rockwood report workflow failed", {
      phase,
      type: error instanceof Error ? error.name : "Unknown",
    });
    // Do not reflect provider details, private report content or keys in UI/logs.
    await patch({
      status:
        nonIdempotentSendStarted || job.attempts >= 8
          ? "needs_attention"
          : "queued",
      last_error: nonIdempotentSendStarted
        ? uncertainSendMessage
        : job.attempts >= 8
          ? "Report delivery needs an administrator review."
          : "Delivery did not finish. It will retry automatically.",
      next_attempt_at: new Date(
        Date.now() + Math.min(60, 2 ** job.attempts) * 60_000,
      ).toISOString(),
      lease_token: null,
      lease_until: null,
    });
    return { configured: true, processed: false };
  }
}

export function deliveryError(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof HttpError
          ? error.message
          : "Report delivery is temporarily unavailable. The saved report is safe.",
    },
    {
      status: error instanceof HttpError ? error.status : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
