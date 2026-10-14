import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import nodemailer from "nodemailer";
import {
  deliveryConfigured,
  emailEnvelope,
  reportLink,
  sendReportEmail,
  processDelivery,
  REPORT_RECIPIENT,
} from "../server/delivery";
import { sendSesReport } from "../server/aws-ses";
import { createReportPdf, wrapText } from "../server/report-pdf";
import { GET as cron } from "../app/api/cron/report-deliveries/route";
import type { CloudRow } from "../src/cloud";
vi.mock("../server/aws-ses", async (original) => ({
  ...(await original<typeof import("../server/aws-ses")>()),
  sendSesReport: vi.fn(),
}));
beforeEach(() => {
  vi.stubEnv("REPORT_EMAIL_PROVIDER", "");
  vi.stubEnv("REPORT_EMAIL_NOT_BEFORE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(sendSesReport).mockReset();
});
describe("report delivery", () => {
  it("requires explicit server activation and Gmail credentials", () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-key");
    vi.stubEnv("APP_URL", "https://example.com");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("GMAIL_APP_PASSWORD", "test-password");
    vi.stubEnv("REPORT_DELIVERY_ENABLED", "false");
    expect(deliveryConfigured()).toBe(false);
    vi.stubEnv("REPORT_DELIVERY_ENABLED", "true");
    expect(deliveryConfigured()).toBe(true);
  });
  it("builds encoded stable links and rejects unsafe hosts", () => {
    const link = reportLink("https://example.com", "coral-gables", "id/&?one");
    expect(new URL(link).searchParams.get("report")).toBe("id/&?one");
    expect(() => reportLink("http://example.com", "p", "s")).toThrow();
    expect(() =>
      reportLink("https://user:pass@example.com", "p", "s"),
    ).toThrow();
  });
  it("fixes the recipient, labels fictional projects, attaches PDF and reuses the idempotency key", async () => {
    const envelope = emailEnvelope(
      "Rockwood <test@example.com>",
      "https://example.com/?report=1",
      "Kitchen\nCc: other@example.com",
      "job-1",
      true,
      "resend",
    );
    const requests: RequestInit[] = [];
    const fake = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(init!);
      return Response.json({ id: "email-1" });
    });
    for (let i = 0; i < 2; i++)
      await sendReportEmail(
        envelope,
        new Uint8Array([37, 80, 68, 70]),
        "job-1",
        "key",
        fake as typeof fetch,
      );
    expect(requests[0].body).toBe(requests[1].body);
    const message = JSON.parse(requests[0].body as string);
    expect(message.to).toEqual([REPORT_RECIPIENT]);
    expect(message.subject).toMatch(/^\[TEST\]/);
    expect(message.subject).not.toContain("\n");
    expect(message.provider).toBeUndefined();
    expect(message.attachments[0].content).toBe("JVBERg==");
    expect(new Headers(requests[0].headers).get("Idempotency-Key")).toBe(
      "rockwood-report/job-1",
    );
  });
  it("does not treat a provider rejection as sent", async () => {
    await expect(
      sendReportEmail(
        emailEnvelope(
          "test@example.com",
          "https://example.com",
          "Project",
          "j",
          false,
        ),
        new Uint8Array(),
        "j",
        "k",
        vi.fn(async () => new Response("no", { status: 429 })) as typeof fetch,
      ),
    ).rejects.toThrow("did not accept");
  });
  it("rejects unauthenticated scheduled requests even with missing server secrets", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(
      (
        await cron(
          new Request("https://example.com/api/cron/report-deliveries"),
        )
      ).status,
    ).toBe(401);
    vi.stubEnv("CRON_SECRET", "real-secret");
    expect(
      (
        await cron(
          new Request("https://example.com/api/cron/report-deliveries", {
            headers: { Authorization: "Bearer wrong-value" },
          }),
        )
      ).status,
    ).toBe(401);
  });
  it("wraps long unbroken text without crossing page margins", async () => {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica);
    for (const line of wrapText("a".repeat(500), font, 10, 180))
      expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(180);
  });
  it("generates a paginated branded PDF with every supplied photo and a report link", async () => {
    const row: CloudRow = {
      id: "pdf-test",
      workspace_id: "00000000-0000-4000-8000-000000000001",
      created_by: "00000000-0000-4000-8000-000000000002",
      project_id: "coral-gables",
      started_at: "2026-10-12T15:00:00.000Z",
      updated_at: "2026-10-12T15:02:00.000Z",
      archived_at: null,
      revision: 1,
      payload: {
        duration: 0,
        status: "saved",
        notes: "Setup verification",
        mime: "",
        photos: [
          {
            id: "photo-1",
            projectId: "coral-gables",
            sessionId: "pdf-test",
            area: "Primary Bathroom",
            capturedAt: "2026-10-12T15:01:00.000Z",
            elapsed: null,
            note: "Illustrative photo used for PDF layout testing.",
            origin: "upload",
            original: { path: "test", type: "image/png", size: 1 },
            model: { path: "test", type: "image/png", size: 1 },
          },
        ],
        report: {
          id: "report-1",
          projectId: "coral-gables",
          sessionId: "pdf-test",
          generatedAt: "2026-10-12T15:02:00.000Z",
          mode: "manual",
          reviewStatus: "draft",
          summary:
            "SETUP TEST. Verify the original photo and report link. This record demonstrates how the Rockwood team will receive site documentation. Español: baño, revisión y fotografías.",
          observations: [
            {
              id: "o1",
              area: "Primary Bathroom",
              description:
                "Photo provided for review; this test does not certify site work.",
              basis: "photo",
              state: "requested_review",
              photoIds: ["photo-1"],
              transcriptSegmentIds: [],
              noteIds: [],
              needsVerification: true,
            },
          ],
          actionItems: [
            {
              id: "a1",
              area: "Primary Bathroom",
              task: "Review the photograph and confirm the saved report link opens the same visit.",
              category: "next_step",
              observationIds: ["o1"],
              photoIds: ["photo-1"],
              transcriptSegmentIds: [],
              noteIds: [],
              priority: "unassigned",
              suggestedTrade: null,
              assignee: null,
              dueDateText: null,
              status: "open",
              needsConfirmation: true,
            },
          ],
          captions: [
            {
              photoId: "photo-1",
              caption:
                "Illustrative test image, not evidence of actual construction conditions.",
            },
          ],
        },
      },
    };
    const photo = await readFile("public/brand/rockwood-logo.png");
    const bytes = await createReportPdf({
      row,
      projectName: "Coral Gables Residence",
      isSampleProject: true,
      reportUrl: "https://example.com/?report=pdf-test",
      photos: [photo],
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(pdf.getPage(0).node.Annots()?.size()).toBe(1);
    expect(bytes.length).toBeGreaterThan(10_000);
    if (process.env.REPORT_PDF_QA === "1") {
      await mkdir("qa", { recursive: true });
      await writeFile("qa/automatic-report-test.pdf", bytes);
    }
  });
});

const workerWorkspace = "00000000-0000-4000-8000-000000000001";
const workerJobId = "00000000-0000-4000-8000-000000000003";
const workerPdfPath = `${workerWorkspace}/${workerJobId}.pdf`;
const originalPdf = new Uint8Array([37, 80, 68, 70]);
function queuedJob() {
  const snapshot: CloudRow = {
    id: "ses-test-visit",
    workspace_id: workerWorkspace,
    created_by: "00000000-0000-4000-8000-000000000002",
    project_id: "coral-gables",
    started_at: "2026-10-14T15:01:00.000Z",
    updated_at: "2026-10-14T15:02:00.000Z",
    archived_at: null,
    revision: 1,
    payload: {
      duration: 0,
      status: "saved",
      notes: "Fictional worker test.",
      mime: "",
      photos: [],
      report: {
        id: "ses-test-report",
        projectId: "coral-gables",
        sessionId: "ses-test-visit",
        generatedAt: "2026-10-14T15:02:00.000Z",
        mode: "manual",
        outputLanguage: "en",
        reviewStatus: "draft",
        summary: "Fictional original report.",
        observations: [],
        actionItems: [],
        captions: [],
      },
    },
  };
  return {
    id: workerJobId,
    workspace_id: workerWorkspace,
    walkthrough_id: snapshot.id,
    report_id: snapshot.payload.report!.id,
    revision: 1,
    created_at: "2026-10-14T15:02:00.000Z",
    snapshot,
    project_name: "Fictional Project",
    is_sample_project: true,
    attempts: 1,
    lease_token: "00000000-0000-4000-8000-000000000004",
    send_started_at: null as string | null,
    email_envelope: null as ReturnType<typeof emailEnvelope> | null,
    pdf_path: workerPdfPath as string | null,
  };
}

function workerHarness(
  job = queuedJob(),
  options: { failSentPatch?: boolean; failPdfRead?: boolean } = {},
) {
  const patches: Record<string, unknown>[] = [];
  let status = "queued";
  const events: string[] = [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/rpc/claim_report_delivery")) {
        events.push("claim");
        if (!["queued", "processing"].includes(status))
          return Response.json([]);
        status = "processing";
        return Response.json([job]);
      }
      if (url.pathname.endsWith("/walkthroughs")) {
        events.push("read-visit");
        return Response.json({ archived_at: null });
      }
      if (
        url.pathname.endsWith("/report_deliveries") &&
        request.method === "PATCH"
      ) {
        const fields = await request.json();
        patches.push(fields);
        events.push(
          fields.send_started_at
            ? "freeze-send"
            : `patch-${fields.status ?? "pdf"}`,
        );
        expect(url.searchParams.get("id")).toBe(`eq.${job.id}`);
        expect(url.searchParams.get("lease_token")).toBe(
          `eq.${job.lease_token}`,
        );
        expect(url.searchParams.get("status")).toBe("eq.processing");
        if (fields.status === "sent" && options.failSentPatch)
          return Response.json(
            { message: "Database response failed" },
            { status: 500 },
          );
        Object.assign(job, fields);
        if (fields.status) status = fields.status;
        return Response.json({ id: job.id });
      }
      if (
        url.pathname.includes("/storage/v1/object/") &&
        request.method === "GET"
      ) {
        events.push("read-pdf");
        if (options.failPdfRead)
          return Response.json({ message: "Unavailable" }, { status: 503 });
        return new Response(originalPdf, {
          headers: { "Content-Type": "application/pdf" },
        });
      }
      if (
        url.pathname.includes("/storage/v1/object/") &&
        request.method === "POST"
      ) {
        events.push("save-pdf");
        expect(request.headers.get("x-upsert")).toBe("false");
        return Response.json({ Key: `walkthrough-reports/${workerPdfPath}` });
      }
      throw new Error(
        `Unexpected mocked worker request: ${request.method} ${url.pathname}`,
      );
    },
  );
  const client = createClient(
    "https://worker.example.test",
    "test-server-key",
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetcher },
    },
  );
  return { client, patches, events, job, fetcher };
}

function enableSes() {
  vi.stubEnv("REPORT_DELIVERY_ENABLED", "true");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-server-key");
  vi.stubEnv("APP_URL", "https://example.test");
  vi.stubEnv("REPORT_EMAIL_PROVIDER", "ses");
  vi.stubEnv("REPORT_EMAIL_FROM", REPORT_RECIPIENT);
  vi.stubEnv("ROCKWOOD_AWS_REGION", "us-east-1");
  vi.stubEnv("VERCEL", "0");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");
  vi.stubEnv("GMAIL_APP_PASSWORD", "");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("REPORT_EMAIL_NOT_BEFORE", "2026-10-14T15:00:00.000Z");
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("SES outbox integration", () => {
  it.each(["new", "gmail", "resend", "ses"] as const)(
    "keeps email disabled with legacy credentials and a %s envelope while preserving PDF work",
    async (provider) => {
      enableSes();
      vi.stubEnv("REPORT_EMAIL_PROVIDER", "disabled");
      vi.stubEnv("GMAIL_APP_PASSWORD", "legacy-test-password");
      vi.stubEnv("RESEND_API_KEY", "legacy-test-key");
      vi.stubEnv("REPORT_EMAIL_NOT_BEFORE", "");
      expect(deliveryConfigured()).toBe(false);
      const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected email request"));
      const smtp = vi.spyOn(nodemailer, "createTransport").mockImplementation(() => {
        throw new Error("Unexpected SMTP connection");
      });
      const job = queuedJob();
      if (provider === "new") job.pdf_path = null;
      else job.email_envelope = emailEnvelope(
        REPORT_RECIPIENT, "https://example.test/frozen", "Fictional project", job.id, true, provider,
      );
      const frozen = structuredClone(job.email_envelope);
      const harness = workerHarness(job);
      expect(await processDelivery(job.id, harness.client)).toEqual({ configured: true, processed: false });
      expect(harness.events).toContain(provider === "new" ? "save-pdf" : "read-pdf");
      expect(harness.job.pdf_path).toBe(workerPdfPath);
      expect(harness.job.email_envelope).toEqual(frozen);
      expect(harness.patches.at(-1)).toMatchObject({ status: "queued", lease_token: null });
      expect(harness.job.send_started_at).toBeNull();
      expect(harness.events).not.toContain("freeze-send");
      expect(sendSesReport).not.toHaveBeenCalled();
      expect(smtp).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    },
  );

  it("requires explicit SES selection and a sender, with invalid cutoff failing closed", () => {
    enableSes();
    expect(deliveryConfigured()).toBe(true);
    vi.stubEnv("REPORT_EMAIL_PROVIDER", "");
    expect(deliveryConfigured()).toBe(false);
    vi.stubEnv("REPORT_EMAIL_PROVIDER", "ses");
    vi.stubEnv("REPORT_EMAIL_FROM", "");
    expect(deliveryConfigured()).toBe(false);
    vi.stubEnv("REPORT_EMAIL_FROM", REPORT_RECIPIENT);
    vi.stubEnv("REPORT_EMAIL_NOT_BEFORE", "not-a-date");
    expect(deliveryConfigured()).toBe(false);
    vi.stubEnv("REPORT_EMAIL_NOT_BEFORE", "2026-10-14");
    expect(deliveryConfigured()).toBe(false);
  });

  it("freezes the envelope before SES, reuses the stored PDF, and records acceptance once", async () => {
    enableSes();
    const harness = workerHarness();
    vi.mocked(sendSesReport).mockImplementation(async (envelope, pdf) => {
      expect(harness.events).toContain("freeze-send");
      expect(harness.job.email_envelope).toEqual(envelope);
      expect(harness.job.send_started_at).toBeTruthy();
      expect(pdf).toEqual(originalPdf);
      harness.events.push("send-email");
      return "ses-message-1";
    });
    expect(await processDelivery(workerJobId, harness.client)).toEqual({
      configured: true,
      processed: true,
    });
    expect(harness.job.snapshot.payload.report?.summary).toBe(
      "Fictional original report.",
    );
    expect(harness.job.email_envelope?.provider).toBe("ses");
    expect(harness.job.email_envelope?.to).toEqual([REPORT_RECIPIENT]);
    expect(harness.patches.at(-1)).toMatchObject({
      status: "sent",
      provider_id: "ses-message-1",
      lease_token: null,
    });
    expect(harness.events.indexOf("freeze-send")).toBeLessThan(
      harness.events.indexOf("send-email"),
    );
    await processDelivery(workerJobId, harness.client);
    expect(sendSesReport).toHaveBeenCalledTimes(1);
  });

  it.each(["ses", "gmail"] as const)(
    "never replays an earlier uncertain %s submission",
    async (provider) => {
      enableSes();
      const job = queuedJob();
      job.send_started_at = "2026-10-14T15:03:00.000Z";
      job.email_envelope = emailEnvelope(
        REPORT_RECIPIENT,
        "https://example.test/frozen",
        "Old project",
        job.id,
        true,
        provider,
      );
      const harness = workerHarness(job);
      await processDelivery(job.id, harness.client);
      expect(harness.patches.at(-1)).toMatchObject({
        status: "needs_attention",
      });
      expect(harness.events).not.toContain("read-pdf");
      expect(sendSesReport).not.toHaveBeenCalled();
    },
  );

  it.each(["response timeout", "accepted but database update failed"])(
    "halts automatic replay after %s",
    async (failure) => {
      enableSes();
      const harness = workerHarness(queuedJob(), {
        failSentPatch: failure.includes("database"),
      });
      if (failure.includes("timeout"))
        vi.mocked(sendSesReport).mockRejectedValue(
          new DOMException("Response lost", "AbortError"),
        );
      else vi.mocked(sendSesReport).mockResolvedValue("ses-message-uncertain");
      await processDelivery(workerJobId, harness.client);
      expect(harness.patches.at(-1)).toMatchObject({
        status: "needs_attention",
        lease_token: null,
      });
      expect(harness.job.send_started_at).toBeTruthy();
      await processDelivery(workerJobId, harness.client);
      expect(sendSesReport).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves a failure before any email submission retryable", async () => {
    enableSes();
    const harness = workerHarness(queuedJob(), { failPdfRead: true });
    await processDelivery(workerJobId, harness.client);
    expect(harness.patches.at(-1)).toMatchObject({ status: "queued" });
    expect(harness.job.send_started_at).toBeNull();
    expect(sendSesReport).not.toHaveBeenCalled();
  });

  it("does not switch a frozen Resend envelope to the newly configured SES sender", async () => {
    enableSes();
    const job = queuedJob();
    job.email_envelope = emailEnvelope(
      "old@example.test",
      "https://example.test/frozen",
      "Old project",
      job.id,
      true,
      "resend",
    );
    const frozen = structuredClone(job.email_envelope);
    const harness = workerHarness(job);
    await processDelivery(job.id, harness.client);
    expect(harness.job.email_envelope).toEqual(frozen);
    expect(harness.patches.at(-1)).toMatchObject({ status: "queued" });
    expect(sendSesReport).not.toHaveBeenCalled();
  });

  it("saves an old report's PDF but holds its email outside the activation window", async () => {
    enableSes();
    const job = queuedJob();
    job.created_at = "2026-10-12T15:00:00.000Z";
    job.pdf_path = null;
    const harness = workerHarness(job);
    await processDelivery(job.id, harness.client);
    expect(harness.events).toContain("save-pdf");
    expect(harness.job.pdf_path).toBe(workerPdfPath);
    expect(harness.patches.at(-1)).toMatchObject({
      status: "needs_attention",
      last_error:
        "Report predates automatic email activation. Review before sending.",
    });
    expect(harness.job.send_started_at).toBeNull();
    expect(sendSesReport).not.toHaveBeenCalled();
  });
});
