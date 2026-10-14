import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { GetTranscriptionJobCommand, StartTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import { parseAwsTranscript, pollAwsTranscription, startAwsTranscription } from "../server/aws-transcribe";
import { LIMITS } from "../shared/model";

const jobId = "1fdb3477-b913-435f-a1a1-3ab3a9f8ce12";
const jobName = `rockwood-${jobId}`;
const bucket = "rockwood-private-test";
const dataRoleArn = "arn:aws:iam::111111111111:role/rockwood-transcription-data";
const bytes = Buffer.from("fixture-audio");
const digest = createHash("sha256").update(bytes).digest("hex");
const audioKey = `jobs/${jobId}/audio-${digest}.m4a`;
const audio = () => new Blob([bytes], { type: "audio/mp4" });
const missing = () => Object.assign(new Error("The requested job couldn't be found."), { name: "BadRequestException" });
const job = (patch: Record<string, unknown> = {}) => ({
  TranscriptionJobName: jobName,
  TranscriptionJobStatus: "IN_PROGRESS",
  LanguageCode: "es-US",
  Media: { MediaFileUri: `s3://${bucket}/${audioKey}` },
  ...patch,
});
const rawTranscript = (text = "La cocina está terminada.") => ({
  jobName, status: "COMPLETED",
  results: {
    transcripts: [{ transcript: text }],
    audio_segments: [{ transcript: text, start_time: "0.64", end_time: "2.56" }],
  },
});
const deps = () => ({
  bucket, dataRoleArn,
  transcribe: { send: vi.fn() },
  s3: { send: vi.fn().mockResolvedValue({}) },
});
afterEach(() => vi.unstubAllEnvs());

describe("AWS Transcribe durable adapter", () => {
  it("stages iPhone M4A privately and starts one named Spanish job without guessing language or sample rate", async () => {
    const injected = deps();
    injected.transcribe.send.mockRejectedValueOnce(missing()).mockResolvedValueOnce({});
    await expect(startAwsTranscription({ jobId, audio: audio(), language: "es" }, injected))
      .resolves.toEqual({ jobName, audioKey });
    expect(injected.transcribe.send).toHaveBeenCalledTimes(2);
    expect(injected.transcribe.send.mock.calls[0][0]).toBeInstanceOf(GetTranscriptionJobCommand);
    const [upload, uploadOptions] = injected.s3.send.mock.calls[0];
    expect(upload).toBeInstanceOf(PutObjectCommand);
    expect(upload.input).toEqual({ Bucket: bucket, Key: audioKey, Body: bytes, ContentType: "audio/mp4", ServerSideEncryption: "AES256" });
    expect(uploadOptions.abortSignal).toBeInstanceOf(AbortSignal);
    const [start, options] = injected.transcribe.send.mock.calls[1];
    expect(start).toBeInstanceOf(StartTranscriptionJobCommand);
    expect(start.input).toEqual({
      TranscriptionJobName: jobName, Media: { MediaFileUri: `s3://${bucket}/${audioKey}` },
      MediaFormat: "m4a", LanguageCode: "es-US", OutputBucketName: bucket,
      OutputKey: `jobs/${jobId}/transcript.json`,
      JobExecutionSettings: { AllowDeferredExecution: true, DataAccessRoleArn: dataRoleArn },
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("supports WebM/Opus browser recordings and pins English for short English clips", async () => {
    const injected = deps();
    injected.transcribe.send.mockRejectedValueOnce(missing()).mockResolvedValueOnce({});
    const result = await startAwsTranscription({ jobId, audio: new Blob([bytes], { type: "audio/webm;codecs=opus" }), language: "en" }, injected);
    expect(result.audioKey).toMatch(/\.webm$/);
    expect(injected.transcribe.send.mock.calls[1][0].input).toMatchObject({ MediaFormat: "webm", LanguageCode: "en-US" });
  });

  it("gives an explicitly retried terminal failure a separate deterministic name and output path", async () => {
    const injected = deps();
    injected.transcribe.send.mockRejectedValueOnce(missing()).mockResolvedValueOnce({});
    const result = await startAwsTranscription({ jobId, audio: audio(), language: "es", generation: 1 }, injected);
    expect(result).toEqual({ jobName: `${jobName}-r1`, audioKey: `jobs/${jobId}/retry-1/audio-${digest}.m4a` });
    expect(injected.transcribe.send.mock.calls[1][0].input).toMatchObject({
      TranscriptionJobName: `${jobName}-r1`, OutputKey: `jobs/${jobId}/retry-1/transcript.json`,
    });
    injected.transcribe.send.mockResolvedValue({ TranscriptionJob: job({
      TranscriptionJobName: `${jobName}-r1`, TranscriptionJobStatus: "COMPLETED",
      Media: { MediaFileUri: `s3://${bucket}/${result.audioKey}` },
    }) });
    injected.s3.send.mockResolvedValue({ Body: { transformToString: vi.fn().mockResolvedValue(JSON.stringify({ ...rawTranscript(), jobName: `${jobName}-r1` })) } });
    expect((await pollAwsTranscription(`${jobName}-r1`, injected)).status).toBe("completed");
    expect(injected.s3.send.mock.calls.at(-1)![0].input).toEqual({ Bucket: bucket, Key: `jobs/${jobId}/retry-1/transcript.json` });
  });

  it.each([-1, 0.5, 1000000, Number.NaN])("rejects invalid generation %s before calling AWS", async generation => {
    const injected = deps();
    await expect(startAwsTranscription({ jobId, audio: audio(), language: "es", generation }, injected)).rejects.toThrow("Invalid or oversized");
    expect(injected.transcribe.send).not.toHaveBeenCalled();
    expect(injected.s3.send).not.toHaveBeenCalled();
  });

  it("recovers a lost start response without uploading again or creating another paid job", async () => {
    const injected = deps();
    injected.transcribe.send.mockResolvedValue({ TranscriptionJob: job() });
    await expect(startAwsTranscription({ jobId, audio: audio(), language: "es" }, injected)).resolves.toEqual({ jobName, audioKey });
    expect(injected.transcribe.send).toHaveBeenCalledTimes(1);
    expect(injected.s3.send).not.toHaveBeenCalled();
  });

  it("recovers a racing start conflict only after checking the existing job uses the same recording", async () => {
    const injected = deps();
    injected.transcribe.send.mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(Object.assign(new Error("Already exists"), { name: "ConflictException" }))
      .mockResolvedValueOnce({ TranscriptionJob: job() });
    await expect(startAwsTranscription({ jobId, audio: audio(), language: "es" }, injected)).resolves.toEqual({ jobName, audioKey });
    expect(injected.transcribe.send).toHaveBeenCalledTimes(3);
  });

  it.each([
    { Media: { MediaFileUri: "s3://another-bucket/private/audio.m4a" } },
    { Media: { MediaFileUri: `s3://${bucket}/jobs/${jobId}/audio-${"0".repeat(64)}.m4a` } },
    { LanguageCode: "en-US" },
    { TranscriptionJobName: "unrelated" },
  ])("refuses an existing provider job with a different identity, input or language", async patch => {
    const injected = deps();
    injected.transcribe.send.mockResolvedValue({ TranscriptionJob: job(patch) });
    await expect(startAwsTranscription({ jobId, audio: audio(), language: "es" }, injected)).rejects.toThrow();
    expect(injected.s3.send).not.toHaveBeenCalled();
  });

  it("does not interpret permission errors or other bad requests as a missing job", async () => {
    for (const error of [
      Object.assign(new Error("Access denied"), { name: "AccessDeniedException" }),
      Object.assign(new Error("Invalid job request"), { name: "BadRequestException" }),
    ]) {
      const injected = deps();
      injected.transcribe.send.mockRejectedValue(error);
      await expect(startAwsTranscription({ jobId, audio: audio(), language: "es" }, injected)).rejects.toBe(error);
      expect(injected.s3.send).not.toHaveBeenCalled();
      expect(injected.transcribe.send).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects invalid, empty and oversized audio before any cloud call", async () => {
    const injected = deps();
    for (const input of [
      { jobId: "../other", audio: audio(), language: "en" as const },
      { jobId, audio: new Blob([], { type: "audio/mp4" }), language: "en" as const },
      { jobId, audio: new Blob([bytes], { type: "application/octet-stream" }), language: "en" as const },
      { jobId, audio: new Blob([new Uint8Array(LIMITS.uploadBytes + 1)], { type: "audio/mp4" }), language: "en" as const },
    ]) await expect(startAwsTranscription(input, injected)).rejects.toThrow("Invalid or oversized");
    expect(injected.transcribe.send).not.toHaveBeenCalled();
    expect(injected.s3.send).not.toHaveBeenCalled();
  });

  it.each(["QUEUED", "IN_PROGRESS"])("polls %s without sleeping or downloading", async status => {
    const injected = deps();
    injected.transcribe.send.mockResolvedValue({ TranscriptionJob: job({ TranscriptionJobStatus: status }) });
    await expect(pollAwsTranscription(jobName, injected)).resolves.toEqual({ status: "pending" });
    expect(injected.s3.send).not.toHaveBeenCalled();
  });

  it("reads the fixed private S3 output and preserves Spanish speech with actual timestamps", async () => {
    const injected = deps();
    injected.transcribe.send.mockResolvedValue({ TranscriptionJob: job({
      TranscriptionJobStatus: "COMPLETED",
      Transcript: { TranscriptFileUri: "https://untrusted.example/private-result" },
    }) });
    injected.s3.send.mockResolvedValue({ Body: { transformToString: vi.fn().mockResolvedValue(JSON.stringify(rawTranscript())) } });
    await expect(pollAwsTranscription(jobName, injected)).resolves.toEqual({ status: "completed", transcript: {
      text: "La cocina está terminada.", source: "audio",
      segments: [{ id: "segment-1", text: "La cocina está terminada.", start: 0.64, end: 2.56 }],
    } });
    const [read] = injected.s3.send.mock.calls[0];
    expect(read).toBeInstanceOf(GetObjectCommand);
    expect(read.input).toEqual({ Bucket: bucket, Key: `jobs/${jobId}/transcript.json` });
  });

  it("does not expose provider failure text or storage locations", async () => {
    const injected = deps();
    injected.transcribe.send.mockResolvedValue({ TranscriptionJob: job({ TranscriptionJobStatus: "FAILED", FailureReason: "s3://private/path contains sensitive provider detail" }) });
    const result = await pollAwsTranscription(jobName, injected);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toMatch(/s3:|sensitive/);
    expect(injected.s3.send).not.toHaveBeenCalled();
  });

  it("rejects malformed, oversized or mismatched results rather than silently losing speech", async () => {
    for (const output of [
      { Body: { transformToString: vi.fn().mockResolvedValue("not-json") } },
      { ContentLength: 2_000_001, Body: { transformToString: vi.fn() } },
      { Body: { transformToString: vi.fn().mockResolvedValue(" ".repeat(2_000_001)) } },
      { Body: { transformToString: vi.fn().mockResolvedValue(JSON.stringify({ ...rawTranscript(), jobName: "another-job" })) } },
    ]) {
      const injected = deps();
      injected.transcribe.send.mockResolvedValue({ TranscriptionJob: job({ TranscriptionJobStatus: "COMPLETED" }) });
      injected.s3.send.mockResolvedValue(output);
      await expect(pollAwsTranscription(jobName, injected)).rejects.toThrow();
    }
  });

  it("preserves all words when timestamped segments are absent, incomplete or longer than the app limit", () => {
    const text = "Palabra ".repeat(1000).trim();
    for (const segments of [undefined, [{ transcript: "Incomplete", start_time: "0", end_time: "1" }], [{ transcript: text, start_time: "0", end_time: "80" }]]) {
      const result = parseAwsTranscript({ ...rawTranscript(text), results: { transcripts: [{ transcript: text }], audio_segments: segments } }, jobName);
      expect(result.text).toBe(text);
      expect(result.segments.map(segment => segment.text).join(" ")).toBe(text);
      expect(result.segments.every(segment => segment.text.length <= 4000 && segment.start === null && segment.end === null)).toBe(true);
    }
  });

  it("represents no detected speech honestly and rejects invalid provider timestamps", () => {
    expect(parseAwsTranscript(rawTranscript(""), jobName)).toEqual({ text: "", segments: [], source: "audio" });
    const raw = rawTranscript();
    raw.results.audio_segments[0].end_time = "-1";
    expect(() => parseAwsTranscript(raw, jobName)).toThrow();
  });

  it("requires the explicit Rockwood region and bucket, never an automatic Vercel region", async () => {
    vi.stubEnv("ROCKWOOD_AWS_REGION", "");
    vi.stubEnv("AWS_REGION", "unrelated-region");
    vi.stubEnv("AWS_TRANSCRIBE_BUCKET", bucket);
    await expect(startAwsTranscription({ jobId, audio: audio(), language: "en" })).rejects.toThrow("Rockwood AWS region");
    vi.stubEnv("ROCKWOOD_AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_TRANSCRIBE_DATA_ROLE_ARN", "");
    await expect(startAwsTranscription({ jobId, audio: audio(), language: "en" })).rejects.toThrow("transcription data role");
    vi.stubEnv("AWS_TRANSCRIBE_BUCKET", "");
    await expect(pollAwsTranscription(jobName)).rejects.toThrow("transcription storage");
  });
});
