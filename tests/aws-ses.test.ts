import { afterEach, describe, expect, it, vi } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  createSesReportClient,
  sendSesReport,
  SES_REPORT_RECIPIENT,
  SES_SEND_TIMEOUT_MS,
  type SesReportEnvelope,
} from "../server/aws-ses";

const credentials = {
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
};
const connection = { region: "us-east-1", credentials };
const envelope: SesReportEnvelope = {
  from: SES_REPORT_RECIPIENT,
  to: [SES_REPORT_RECIPIENT],
  subject: "[TEST] Rockwood walkthrough - Project",
  text: "The attached PDF is the original report. Review: https://example.test/report",
  filename: "rockwood-report-job-1.pdf",
};
const pdf = new Uint8Array([37, 80, 68, 70]);
afterEach(() => vi.restoreAllMocks());

describe("SES report adapter", () => {
  it("disables SDK retries and uses only the explicit account and region", async () => {
    const client = createSesReportClient(connection);
    try {
      expect(await client.config.maxAttempts()).toBe(1);
      expect(await client.config.region()).toBe("us-east-1");
      expect(await client.config.credentials()).toMatchObject(credentials);
    } finally {
      client.destroy();
    }
    expect(() => createSesReportClient({ ...connection, region: " " })).toThrow(
      "not configured",
    );
  });

  it("submits the exact frozen text and PDF bytes to the fixed recipient", async () => {
    const send = vi.fn(async () => ({
      MessageId: "ses-accepted-id",
      $metadata: {},
    }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const result = await sendSesReport(envelope, pdf, "job-1", {
      ...connection,
      client: { send },
    });
    expect(result).toBe("ses-accepted-id");
    expect(send).toHaveBeenCalledTimes(1);
    const [command, options] = send.mock.calls[0] as unknown as [
      SendEmailCommand,
      { abortSignal: AbortSignal },
    ];
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input).toEqual({
      FromEmailAddress: envelope.from,
      Destination: { ToAddresses: [SES_REPORT_RECIPIENT] },
      Content: {
        Simple: {
          Subject: { Data: envelope.subject, Charset: "UTF-8" },
          Body: { Text: { Data: envelope.text, Charset: "UTF-8" } },
          Attachments: [
            {
              FileName: envelope.filename,
              ContentType: "application/pdf",
              ContentDisposition: "ATTACHMENT",
              ContentTransferEncoding: "BASE64",
              RawContent: pdf,
            },
          ],
        },
      },
      EmailTags: [{ Name: "rockwood_job", Value: "job-1" }],
    });
    expect(command.input.Content?.Simple?.Attachments?.[0].RawContent).toBe(
      pdf,
    );
    expect(timeout).toHaveBeenCalledWith(SES_SEND_TIMEOUT_MS);
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { ...envelope, to: ["other@example.test"] },
    { ...envelope, to: [SES_REPORT_RECIPIENT, "other@example.test"] },
    { ...envelope, from: "sender@example.test\nBcc: other@example.test" },
    { ...envelope, subject: "Report\r\nBcc: other@example.test" },
    { ...envelope, filename: "../report.pdf" },
  ])(
    "rejects changed recipients and invalid headers before contacting SES",
    async (invalid) => {
      const send = vi.fn();
      await expect(
        sendSesReport(invalid, pdf, "job-1", {
          ...connection,
          client: { send },
        }),
      ).rejects.toThrow("invalid");
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([new Uint8Array(), new Uint8Array(10_000_001)])(
    "rejects empty or oversized PDFs before contacting SES",
    async (invalidPdf) => {
      const send = vi.fn();
      await expect(
        sendSesReport(envelope, invalidPdf, "job-1", {
          ...connection,
          client: { send },
        }),
      ).rejects.toThrow("delivery limit");
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    new DOMException("Response lost", "AbortError"),
    Object.assign(new Error("Throttled"), { name: "TooManyRequestsException" }),
  ])(
    "propagates uncertain failure without sending a second time",
    async (error) => {
      const send = vi.fn().mockRejectedValue(error);
      await expect(
        sendSesReport(envelope, pdf, "job-1", {
          ...connection,
          client: { send },
        }),
      ).rejects.toBe(error);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("does not report success when SES omits its acceptance ID", async () => {
    const send = vi.fn(async () => ({ $metadata: {} }));
    await expect(
      sendSesReport(envelope, pdf, "job-1", {
        ...connection,
        client: { send },
      }),
    ).rejects.toThrow("did not confirm acceptance");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
