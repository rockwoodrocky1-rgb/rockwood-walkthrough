import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cloudRowSchema } from "../src/cloud";
import {
  LIMITS,
  photoMetaSchema,
  transcriptSchema,
  reportContentSchema,
  reportInputSchema,
  validateEvidence,
  type Transcript,
} from "../shared/model";
import { generateReport } from "./api";
import { startAwsTranscription, pollAwsTranscription } from "./aws-transcribe";

const jobSchema = z.object({
  id: z.uuid(), workspace_id: z.uuid(), walkthrough_id: z.string(),
  snapshot: cloudRowSchema, lease_token: z.uuid(),
  transcribe_job_name: z.string().nullable(),
  transcribe_generation: z.number().int().nonnegative(),
  transcript: transcriptSchema.nullable(), report: reportContentSchema.nullable(),
  poll_count: z.number().int().nonnegative(),
  failure_count: z.number().int().nonnegative(),
  deadline_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});
type Services = {
  start: typeof startAwsTranscription;
  poll: typeof pollAwsTranscription;
  report: typeof generateReport;
};
const services: Services = { start: startAwsTranscription, poll: pollAwsTranscription, report: generateReport };
const claimIdentitySchema = z.object({ id: z.uuid(), lease_token: z.uuid() });
type ProcessingStage = "source_load" | "transcribe_start" | "transcribe_poll" | "report_generate" | "report_validate" | "checkpoint" | "finalize";
const awsErrorNames = new Set([
  "AccessDenied", "AccessDeniedException", "BadRequestException", "ConflictException",
  "ExpiredToken", "ExpiredTokenException", "InternalFailureException", "InternalServerException",
  "InvalidAccessKeyId", "InvalidClientTokenId", "InvalidSignatureException", "LimitExceededException",
  "ModelErrorException", "ModelNotReadyException", "ModelTimeoutException", "NoSuchBucket", "NoSuchKey",
  "RequestTimeout", "RequestTimeoutException", "ResourceNotFoundException", "ServiceQuotaExceededException",
  "ServiceUnavailableException", "SignatureDoesNotMatch", "ThrottlingException", "TooManyRequestsException",
  "UnrecognizedClientException", "ValidationException",
]);
const safeRequestId = /^(?:[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}|[a-f\d]{16}|[a-f\d]{32}|[a-f\d]{64})$/i;
function ownValue(value: unknown, key: string): unknown {
  // Do not invoke provider-defined getters or stringify an error object.
  try {
    return value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  } catch { return undefined; }
}
function logProcessingFailure(jobId: string, stage: ProcessingStage, error: unknown) {
  const name = ownValue(error, "name");
  const metadata = ownValue(error, "$metadata");
  const status = ownValue(metadata, "httpStatusCode");
  const requestId = ownValue(metadata, "requestId");
  // Only fixed names, a validated job UUID, HTTP status, and a bounded AWS
  // request identifier leave this worker. Never include messages or stacks.
  console.warn(JSON.stringify({
    event: "report_processing_failed",
    job_id: jobId,
    stage,
    error_name: typeof name === "string" && awsErrorNames.has(name) ? name : "UnknownError",
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { http_status: status } : {}),
    ...(typeof requestId === "string" && safeRequestId.test(requestId) ? { aws_request_id: requestId } : {}),
  }));
}

/** One bounded step per invocation. No sleeping while Transcribe is running. */
export async function processReportJob(client: SupabaseClient, deps: Services = services) {
  const claimed = await client.rpc("claim_report_processing", { job_id: null });
  if (claimed.error) throw new Error("Processing queue unavailable.");
  if (!claimed.data?.length) return { processed: false };
  // Validate enough of the database claim to release it safely even when an
  // older saved payload or a damaged checkpoint no longer matches the schema.
  const identity = claimIdentitySchema.safeParse(claimed.data[0]);
  if (!identity.success) throw new Error("Processing claim is invalid.");
  const patch = async (fields: Record<string, unknown>) => {
    const { data, error } = await client.from("processing_jobs").update(fields)
      .eq("id", identity.data.id).eq("lease_token", identity.data.lease_token).eq("status", "processing")
      .gt("lease_until", new Date().toISOString()).select("id").maybeSingle();
    if (error || !data) throw new Error("Processing lease lost.");
  };
  const release = (fields: Record<string, unknown>) => patch({
    status: "queued", next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
    lease_token: null, lease_until: null, ...fields,
  });
  const parsed = jobSchema.safeParse(claimed.data[0]);
  if (!parsed.success) {
    // Never let invalid immutable input be reclaimed forever or leak schema
    // errors into logs. Keep its snapshot and any existing output for review.
    await release({
      status: "failed",
      last_error: "This saved visit could not be processed. Reopen and save the visit before trying again.",
    });
    return { processed: true };
  }
  const job = parsed.data;
  const row = job.snapshot;
  let stage: ProcessingStage = "source_load";
  async function media(file: {path: string; size: number; type: string}, max: number) {
    if (!file.path.startsWith(`${job.workspace_id}/`) || file.path.includes("..") || file.size <= 0 || file.size > max)
      throw new Error("Saved media is invalid.");
    const result = await client.storage.from("walkthrough-media").download(file.path);
    if (result.error || !result.data || result.data.size !== file.size || result.data.size > max)
      throw new Error("Saved media could not be loaded.");
    return new Blob([await result.data.arrayBuffer()], {type: file.type});
  }
  try {
    if (row.workspace_id !== job.workspace_id || row.id !== job.walkthrough_id)
      throw new Error("Processing snapshot is invalid.");
    if (Date.parse(job.deadline_at) <= Date.now()) {
      await release({status: "failed", last_error: "Processing took too long. Your recording is saved. Retry the report."});
      return {processed: true};
    }
    let transcript: Transcript | undefined = job.transcript ?? row.payload.transcript;
    if (!transcript?.text.trim() && row.payload.audio?.size) {
      if (!job.transcribe_job_name) {
        const audio = await media(row.payload.audio, LIMITS.uploadBytes);
        stage = "transcribe_start";
        const started = await deps.start({jobId: job.id, generation: job.transcribe_generation, audio, language: row.payload.recordingLanguage ?? row.payload.language ?? "en"});
        stage = "checkpoint";
        await release({phase: "transcribing", transcribe_job_name: started.jobName, audio_key: started.audioKey, transcribe_failed: false, last_error: null});
        return {processed: true};
      }
      stage = "transcribe_poll";
      const result = await deps.poll(job.transcribe_job_name);
      if (result.status === "pending") {
        await release({phase: "transcribing", poll_count: job.poll_count + 1, last_error: null});
        return {processed: true};
      }
      if (result.status === "failed") {
        await release({status: "failed", phase: "transcribing", transcribe_failed: true, last_error: "Transcription could not be completed. Your recording is saved. Retry the report."});
        return {processed: true};
      }
      transcript = transcriptSchema.parse(result.transcript);
      if (!transcript.text.trim()) {
        await release({status: "failed", last_error: "No speech was found in the recording. Add a transcript before creating the report."});
        return {processed: true};
      }
      if (transcript.source !== "audio")
        throw new Error("Transcription source is invalid.");
      // Persist speech before generating the report so a model failure cannot lose it.
      stage = "checkpoint";
      await patch({transcript, phase: "reporting", last_error: null});
    }
    transcript ??= {text: "", source: "manual", segments: []};
    if (transcript.source === "sample")
      throw new Error("Sample transcripts cannot generate a live report.");
    if (!row.payload.audio?.size && row.payload.duration > 0 && !transcript.text.trim()) {
      await release({status: "failed", last_error: "No recording was saved. Add spoken notes or a transcript before creating the report."});
      return {processed: true};
    }
    if (!transcript.text.trim() && !row.payload.notes.trim() && !row.payload.photos.length) {
      await release({status: "failed", last_error: "No speech or notes were found. Add notes or photos before creating the report."});
      return {processed: true};
    }
    stage = "source_load";
    const input = {
      language: row.payload.language ?? "en", sessionId: row.id,
      projectId: reportInputSchema.shape.projectId.parse(row.project_id),
      notes: row.payload.notes, transcript,
      // Reference validation needs only metadata. A saved report checkpoint
      // must not depend on downloading every image again just to finalize it.
      photos: row.payload.photos.map(p => ({
        ...photoMetaSchema.parse(p),
        dataUrl: "",
      })),
    };
    validateEvidence({summary: "validation", observations: [], actionItems: [], captions: []}, input);
    let generated = job.report;
    if (!generated) {
      const photos = await Promise.all(row.payload.photos.map(async (p, index) => ({
        ...input.photos[index],
        dataUrl: `data:image/jpeg;base64,${Buffer.from(await (await media(p.model, LIMITS.imageTargetBytes)).arrayBuffer()).toString("base64")}`,
      })));
      stage = "report_generate";
      generated = await deps.report({ ...input, photos });
    }
    stage = "report_validate";
    const report = validateEvidence(reportContentSchema.parse(generated), input);
    // Checkpoint before completion; retries after a DB timeout reuse the AI output.
    stage = "checkpoint";
    await patch({transcript, report, phase: "reporting", last_error: null});
    stage = "finalize";
    const completed = await client.rpc("complete_report_processing", {
      job_id: job.id, worker_lease: job.lease_token, transcript_value: transcript, report_value: report,
    });
    if (completed.error || !["completed", "conflict", "cancelled"].includes(completed.data))
      throw new Error("Could not save the generated report.");
    return {processed: true};
  } catch (error) {
    logProcessingFailure(job.id, stage, error);
    // Members receive only the fixed recovery message, never operational details.
    await release({
      status: job.failure_count >= 2 ? "failed" : "queued",
      failure_count: job.failure_count + 1,
      last_error: job.failure_count >= 2
        ? "The report could not be completed. Your recording is saved. Retry the report."
        : "Processing was interrupted. It will retry automatically.",
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    });
    return {processed: true};
  }
}
