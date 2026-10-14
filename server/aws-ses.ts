import {
  SESv2Client,
  SendEmailCommand,
  type SESv2ClientConfig,
  type SendEmailCommandOutput,
} from "@aws-sdk/client-sesv2";

export const SES_REPORT_RECIPIENT = "rockwoodrocky1@gmail.com";
export const SES_SEND_TIMEOUT_MS = 30_000;
const MAX_REPORT_BYTES = 10_000_000;

export type SesReportEnvelope = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  filename: string;
};
type SesSender = {
  send(
    command: SendEmailCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<SendEmailCommandOutput>;
};
export type SesReportOptions = {
  region: string;
  credentials?: SESv2ClientConfig["credentials"];
  client?: SesSender;
};

export function createSesReportClient(
  options: Pick<SesReportOptions, "region" | "credentials">,
) {
  if (!options.region.trim())
    throw new Error("The report email connection is not configured.");
  return new SESv2Client({
    region: options.region.trim(),
    credentials: options.credentials,
    // SES SendEmail has no idempotency key. Even one hidden SDK retry could
    // duplicate a PDF after SES accepted it but its response was lost.
    maxAttempts: 1,
  });
}

/**
 * Submit one immutable outbox message. The caller must persist send_started_at
 * before invoking this function and stop uncertain sends for administrator review.
 * MessageId confirms SES acceptance, not inbox delivery.
 */
export async function sendSesReport(
  envelope: SesReportEnvelope,
  pdf: Uint8Array,
  jobId: string,
  options: SesReportOptions,
) {
  if (
    envelope.to.length !== 1 ||
    envelope.to[0] !== SES_REPORT_RECIPIENT ||
    !envelope.from.trim() ||
    /[\r\n]/.test(envelope.from) ||
    /[\r\n]/.test(envelope.subject) ||
    !/^[a-zA-Z0-9._-]+\.pdf$/.test(envelope.filename) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(jobId)
  )
    throw new Error("The report email request is invalid.");
  if (!pdf.byteLength || pdf.byteLength > MAX_REPORT_BYTES)
    throw new Error("The report PDF is empty or exceeds the delivery limit.");

  const ownedClient = options.client
    ? undefined
    : createSesReportClient(options);
  const client = options.client ?? ownedClient!;
  try {
    const result = await client.send(
      new SendEmailCommand({
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
                // The SDK serializes bytes as base64; pre-encoding would corrupt
                // the attachment by encoding its text representation twice.
                RawContent: pdf,
              },
            ],
          },
        },
        EmailTags: [{ Name: "rockwood_job", Value: jobId }],
      }),
      { abortSignal: AbortSignal.timeout(SES_SEND_TIMEOUT_MS) },
    );
    if (!result.MessageId?.trim())
      throw new Error("SES did not confirm acceptance of the report.");
    return result.MessageId;
  } finally {
    ownedClient?.destroy();
  }
}
