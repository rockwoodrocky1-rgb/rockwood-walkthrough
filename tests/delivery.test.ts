import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  deliveryConfigured,
  emailEnvelope,
  reportLink,
  sendReportEmail,
  REPORT_RECIPIENT,
} from "../server/delivery";
import { createReportPdf, wrapText } from "../server/report-pdf";
import { GET as cron } from "../app/api/cron/report-deliveries/route";
import type { CloudRow } from "../src/cloud";
afterEach(() => vi.unstubAllEnvs());
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
