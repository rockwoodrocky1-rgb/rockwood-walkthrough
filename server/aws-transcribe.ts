import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GetTranscriptionJobCommand,
  StartTranscriptionJobCommand,
  TranscribeClient,
  type MediaFormat,
  type TranscriptionJob,
} from "@aws-sdk/client-transcribe";
import { z } from "zod";
import { LIMITS, audioExtension, transcriptSchema, type Transcript } from "../shared/model";
import { awsClientOptions } from "./aws-config";

type Clients = {
  transcribe: Pick<TranscribeClient, "send">;
  s3: Pick<S3Client, "send">;
  bucket: string;
  dataRoleArn: string;
};
export type AwsTranscriptionResult =
  | { status: "pending" }
  | { status: "failed"; error: string }
  | { status: "completed"; transcript: Transcript };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxOutputBytes = 2_000_000;
const requestOptions = () => ({ abortSignal: AbortSignal.timeout(30_000) });

function clients(): Clients {
  const bucket = process.env.AWS_TRANSCRIBE_BUCKET?.trim();
  if (!bucket) throw new Error("Rockwood transcription storage is not configured.");
  const options = { ...awsClientOptions(), maxAttempts: 1 };
  const dataRoleArn = process.env.AWS_TRANSCRIBE_DATA_ROLE_ARN?.trim();
  if (!dataRoleArn || !/^arn:aws(?:-[a-z-]+)?:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]+$/.test(dataRoleArn))
    throw new Error("Rockwood transcription data role is not configured.");
  return { transcribe: new TranscribeClient(options), s3: new S3Client(options), bucket, dataRoleArn };
}

function jobIdentity(name: string) {
  const match = /^rockwood-([0-9a-f-]{36})(?:-r([1-9]\d{0,5}))?$/i.exec(name);
  if (!match || !uuid.test(match[1]))
    throw new Error("Invalid transcription job.");
  const id = match[1];
  const generation = Number(match[2] ?? 0);
  return { id, prefix: `jobs/${id}/${generation ? `retry-${generation}/` : ""}` };
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "";
}

async function existingJob(name: string, deps: Clients) {
  try {
    const result = await deps.transcribe.send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: name }), requestOptions(),
    );
    if (!result.TranscriptionJob) throw new Error("Missing transcription job.");
    return result.TranscriptionJob;
  } catch (error) {
    // Transcribe reports a missing job as BadRequestException. Other 400s,
    // credential failures and outages must not be mistaken for a new job.
    if (errorName(error) === "BadRequestException" && error instanceof Error &&
        /couldn.?t be found|not found|does not exist/i.test(error.message)) return null;
    throw error;
  }
}

function validateJob(job: TranscriptionJob, name: string, bucket: string, inputUri?: string) {
  const identity = jobIdentity(name);
  const mediaUri = job.Media?.MediaFileUri;
  const prefix = `s3://${bucket}/${identity.prefix}audio-`;
  if (job.TranscriptionJobName !== name || !mediaUri?.startsWith(prefix) ||
      !/^[a-f0-9]{64}\.(webm|m4a|ogg|wav|mp3)$/.test(mediaUri.slice(prefix.length)) ||
      (inputUri !== undefined && mediaUri !== inputUri))
    throw new Error("Transcription job does not match this recording.");
}

/** Start once per immutable processing snapshot; a lost response is safe to retry. */
export async function startAwsTranscription(
  input: { jobId: string; audio: Blob; language: "en" | "es"; generation?: number },
  injected?: Clients,
): Promise<{ jobName: string; audioKey: string }> {
  const format = audioExtension(input.audio.type);
  const generation = input.generation ?? 0;
  if (!uuid.test(input.jobId) || !format || !input.audio.size ||
      input.audio.size > LIMITS.uploadBytes || !["en", "es"].includes(input.language) ||
      !Number.isInteger(generation) || generation < 0 || generation > 999999)
    throw new Error("Invalid or oversized recording.");
  const bytes = Buffer.from(await input.audio.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  const jobName = `rockwood-${input.jobId}${generation ? `-r${generation}` : ""}`;
  const identity = jobIdentity(jobName);
  const audioKey = `${identity.prefix}audio-${digest}.${format}`;
  const deps = injected ?? clients();
  const mediaUri = `s3://${deps.bucket}/${audioKey}`;
  const languageCode = input.language === "es" ? "es-US" : "en-US";
  const existing = await existingJob(jobName, deps);
  if (existing) {
    validateJob(existing, jobName, deps.bucket, mediaUri);
    if (existing.LanguageCode !== languageCode)
      throw new Error("Transcription language does not match this recording.");
    return { jobName, audioKey };
  }
  await deps.s3.send(new PutObjectCommand({
    Bucket: deps.bucket, Key: audioKey, Body: bytes,
    ContentType: input.audio.type.split(";")[0], ServerSideEncryption: "AES256",
  }), requestOptions());
  try {
    await deps.transcribe.send(new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      Media: { MediaFileUri: mediaUri },
      MediaFormat: format as MediaFormat,
      LanguageCode: languageCode,
      OutputBucketName: deps.bucket,
      OutputKey: `${identity.prefix}transcript.json`,
      JobExecutionSettings: { AllowDeferredExecution: true, DataAccessRoleArn: deps.dataRoleArn },
    }), requestOptions());
  } catch (error) {
    // Two attempts may race before either checkpoints its provider name.
    // The deterministic name prevents a second paid transcription.
    if (errorName(error) !== "ConflictException") throw error;
    const concurrent = await existingJob(jobName, deps);
    if (!concurrent) throw new Error("Transcription job could not be recovered.");
    validateJob(concurrent, jobName, deps.bucket, mediaUri);
    if (concurrent.LanguageCode !== languageCode)
      throw new Error("Transcription language does not match this recording.");
  }
  return { jobName, audioKey };
}

const timestamp = z.union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number()]).transform(Number)
  .pipe(z.number().finite().nonnegative());
const outputSchema = z.object({
  jobName: z.string(),
  status: z.literal("COMPLETED"),
  results: z.object({
    transcripts: z.array(z.object({ transcript: z.string().max(50_000) })).length(1),
    audio_segments: z.array(z.object({
      transcript: z.string().max(50_000),
      start_time: timestamp,
      end_time: timestamp,
    }).refine(s => s.end_time >= s.start_time)).max(500).optional(),
  }),
});

function textParts(text: string) {
  const parts: string[] = [];
  let remainder = text.trim();
  while (remainder.length > 4000) {
    const boundary = remainder.lastIndexOf(" ", 4000);
    const end = boundary > 0 ? boundary : 4000;
    parts.push(remainder.slice(0, end));
    remainder = remainder.slice(end).trimStart();
  }
  if (remainder) parts.push(remainder);
  return parts;
}

/** Preserve original speech. English translation belongs to report generation. */
export function parseAwsTranscript(raw: unknown, jobName: string): Transcript {
  const output = outputSchema.parse(raw);
  if (output.jobName !== jobName) throw new Error("Transcription result belongs to another recording.");
  const text = output.results.transcripts[0].transcript.trim();
  const segments: Transcript["segments"] = [];
  const source = output.results.audio_segments?.filter(s => s.transcript.trim());
  // Require segments to cover the transcript. A legacy/missing segment array
  // falls back to source text without invented timestamps or lost words.
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  if (source?.length && normalize(source.map(s => s.transcript).join(" ")) === normalize(text)) {
    for (const segment of source) {
      const parts = textParts(segment.transcript);
      for (const part of parts) segments.push({
        id: `segment-${segments.length + 1}`,
        text: part,
        start: parts.length === 1 ? segment.start_time : null,
        end: parts.length === 1 ? segment.end_time : null,
      });
    }
  } else for (const part of textParts(text)) segments.push({
    id: `segment-${segments.length + 1}`, text: part, start: null, end: null,
  });
  return transcriptSchema.parse({ text, segments, source: "audio" });
}

/** Poll without waiting; read only this job's private S3 result, never an arbitrary URL. */
export async function pollAwsTranscription(jobName: string, injected?: Clients): Promise<AwsTranscriptionResult> {
  const identity = jobIdentity(jobName);
  const deps = injected ?? clients();
  const job = await existingJob(jobName, deps);
  if (!job) throw new Error("Saved transcription job could not be found.");
  validateJob(job, jobName, deps.bucket);
  if (job.TranscriptionJobStatus === "QUEUED" || job.TranscriptionJobStatus === "IN_PROGRESS")
    return { status: "pending" };
  if (job.TranscriptionJobStatus === "FAILED") return {
    status: "failed", error: "Audio transcription failed. Your recording is saved. Retry the report.",
  };
  if (job.TranscriptionJobStatus !== "COMPLETED") throw new Error("Unknown transcription status.");
  const output = await deps.s3.send(new GetObjectCommand({
    Bucket: deps.bucket, Key: `${identity.prefix}transcript.json`,
  }), requestOptions());
  if (!output.Body || (output.ContentLength !== undefined && output.ContentLength > maxOutputBytes))
    throw new Error("Invalid or oversized transcription result.");
  const text = await output.Body.transformToString("utf-8");
  if (Buffer.byteLength(text, "utf-8") > maxOutputBytes)
    throw new Error("Invalid or oversized transcription result.");
  return { status: "completed", transcript: parseAwsTranscript(JSON.parse(text), jobName) };
}
