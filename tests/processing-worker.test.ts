import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processReportJob } from "../server/processing-worker";

const workspace = "71111111-1111-4111-8111-111111111111";
const author = "72222222-2222-4222-8222-222222222222";
const jobId = "73333333-3333-4333-8333-333333333333";
const lease = "74444444-4444-4444-8444-444444444444";
const transcript = {
  source: "audio" as const,
  text: "Falta pintar la pared.",
  segments: [{ id: "segment-0", start: 0, end: 2, text: "Falta pintar la pared." }],
};
const report = {
  summary: "The wall still needs painting.",
  observations: [], actionItems: [], captions: [],
};
const audioBlob = new Blob(["test"], { type: "audio/webm" });
const audio = { path: `${workspace}/${author}/visit-1/audio`, type: audioBlob.type, size: audioBlob.size };
function row() {
  return {
    id: "visit-1", project_id: "coral-gables", workspace_id: workspace,
    created_by: author, started_at: "2026-10-14T10:00:00.000Z",
    updated_at: "2026-10-14T10:00:00.000Z", revision: 1, archived_at: null,
    payload: {
      status: "saved" as const, duration: 4, language: "es" as const,
      mime: "audio/webm", notes: "Pared", audio: { ...audio },
      photos: [] as Record<string, unknown>[],
    },
  };
}
function job() {
  return {
    id: jobId, workspace_id: workspace, walkthrough_id: "visit-1",
    snapshot: row(), lease_token: lease,
    transcribe_job_name: null as string | null,
    transcribe_generation: 0,
    transcribe_failed: false,
    transcript: null as typeof transcript | null,
    report: null as typeof report | null,
    poll_count: 0, failure_count: 0,
    deadline_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    status: "queued", phase: "queued",
    lease_until: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}
function store(initial = job()) {
  const state: Record<string, unknown> = structuredClone(initial);
  const patches: Record<string, unknown>[] = [];
  const events: string[] = [];
  const behavior = {
    noClaim: false,
    loseLease: false,
    completionError: false,
    completionStatus: "completed" as string | null,
    ambiguousCheckpoint: false,
  };
  const rpc = vi.fn(async (name: string) => {
    events.push(name);
    if (name === "claim_report_processing") {
      if (behavior.noClaim || ["completed", "failed", "conflict", "cancelled"].includes(String(state.status)))
        return { data: [], error: null };
      state.status = "processing";
      state.lease_token = lease;
      state.lease_until = new Date(Date.now() + 5 * 60_000).toISOString();
      return { data: [structuredClone(state)], error: null };
    }
    if (behavior.completionError) return { data: null, error: new Error("database unavailable") };
    if (behavior.completionStatus) state.status = behavior.completionStatus;
    return { data: behavior.completionStatus, error: null };
  });
  const download = vi.fn(async () => ({ data: audioBlob, error: null }));
  const from = vi.fn((table: string) => ({
    update: (fields: Record<string, unknown>) => {
      expect(table).toBe("processing_jobs");
      const filters = new Map<string, unknown>();
      let expiresAfter = "";
      const query = {
        eq: (name: string, value: unknown) => { filters.set(name, value); return query; },
        gt: (name: string, value: string) => { expect(name).toBe("lease_until"); expiresAfter = value; return query; },
        select: () => query,
        maybeSingle: async () => {
          expect(filters).toEqual(new Map([ ["id", jobId], ["lease_token", lease], ["status", "processing"] ]));
          expect(Number.isFinite(Date.parse(expiresAfter))).toBe(true);
          events.push(fields.report ? "checkpoint-report" : fields.transcript ? "checkpoint-transcript" : "release");
          if (behavior.loseLease) return { data: null, error: null };
          patches.push(structuredClone(fields));
          Object.assign(state, structuredClone(fields));
          if (behavior.ambiguousCheckpoint && fields.report) {
            behavior.ambiguousCheckpoint = false;
            return { data: null, error: new Error("response lost after commit") };
          }
          return { data: { id: jobId }, error: null };
        },
      };
      return query;
    },
  }));
  return {
    client: { rpc, from, storage: { from: () => ({ download }) } } as unknown as SupabaseClient,
    state, patches, events, behavior, rpc, download,
  };
}
function services() {
  return {
    start: vi.fn().mockResolvedValue({ jobName: `rockwood-${jobId}`, audioKey: "fixture-audio-key" }),
    poll: vi.fn().mockResolvedValue({ status: "completed", transcript }),
    report: vi.fn().mockResolvedValue(report),
  };
}

describe("Durable report worker (mocked storage and providers)", () => {
  it("does no provider work when no job is claimed", async () => {
    const db = store();
    db.behavior.noClaim = true;
    const deps = services();
    await expect(processReportJob(db.client, deps)).resolves.toEqual({ processed: false });
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.report).not.toHaveBeenCalled();
  });

  it.each(["snapshot", "checkpoint"])("stops malformed %s data under its lease without erasing saved work or retrying forever", async (invalidPart) => {
    const initial = job();
    initial.transcript = transcript;
    initial.report = report;
    const db = store(initial);
    if (invalidPart === "snapshot") {
      delete (db.state.snapshot as { payload: { duration?: number } }).payload.duration;
    } else {
      db.state.transcript = { ...transcript, source: "PRIVATE INVALID SOURCE" };
    }
    const before = structuredClone(db.state);
    const deps = services();
    await expect(processReportJob(db.client, deps)).resolves.toEqual({ processed: true });
    expect(db.state).toMatchObject({
      status: "failed", lease_token: null, lease_until: null,
      last_error: "This saved visit could not be processed. Reopen and save the visit before trying again.",
    });
    expect(db.state.snapshot).toEqual(before.snapshot);
    expect(db.state.transcript).toEqual(before.transcript);
    expect(db.state.report).toEqual(before.report);
    expect(db.patches).toHaveLength(1);
    expect(JSON.stringify(db.patches)).not.toContain("PRIVATE");
    await expect(processReportJob(db.client, deps)).resolves.toEqual({ processed: false });
    expect(db.patches).toHaveLength(1);
    expect(db.download).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.poll).not.toHaveBeenCalled();
    expect(deps.report).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalledWith("complete_report_processing", expect.anything());
  });

  it("does not mark malformed input failed after losing the claim lease", async () => {
    const db = store();
    db.state.snapshot = { payload: { status: "saved", notes: "PRIVATE INVALID VISIT" } };
    db.behavior.loseLease = true;
    const deps = services();
    await expect(processReportJob(db.client, deps)).rejects.toThrow("Processing lease lost.");
    expect(db.patches).toEqual([]);
    expect(db.state.status).toBe("processing");
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.report).not.toHaveBeenCalled();
  });

  it("rejects an invalid claim identity with a sanitized error and no database mutation", async () => {
    const db = store();
    db.state.id = "PRIVATE INVALID ID";
    const deps = services();
    await expect(processReportJob(db.client, deps)).rejects.toThrow("Processing claim is invalid.");
    expect(db.client.from).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.report).not.toHaveBeenCalled();
  });

  it("starts speech once and checkpoints its stable identity before releasing the lease", async () => {
    const db = store();
    const deps = services();
    await processReportJob(db.client, deps);
    expect(deps.start).toHaveBeenCalledWith({ jobId, generation: 0, audio: expect.any(Blob), language: "es" });
    expect(db.download).toHaveBeenCalledWith(audio.path);
    expect(db.state).toMatchObject({ status: "queued", phase: "transcribing", transcribe_job_name: `rockwood-${jobId}`, audio_key: "fixture-audio-key", transcribe_failed: false, lease_token: null });
    deps.poll.mockResolvedValueOnce({ status: "pending" });
    await processReportJob(db.client, deps);
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(deps.poll).toHaveBeenCalledWith(`rockwood-${jobId}`);
    expect(db.state.poll_count).toBe(1);
    expect(deps.report).not.toHaveBeenCalled();
  });

  it.each([
    { recordingLanguage: "en", language: "es", expected: "en" },
    { recordingLanguage: "es", language: "en", expected: "es" },
    { recordingLanguage: undefined, language: "es", expected: "es" },
    { recordingLanguage: undefined, language: undefined, expected: "en" },
  ])("uses captured language $recordingLanguage over report language $language, with legacy fallback $expected", async ({ recordingLanguage, language, expected }) => {
    const db = store();
    const original = row();
    db.state.snapshot = { ...original, payload: { ...original.payload, recordingLanguage, language } };
    const deps = services();
    await processReportJob(db.client, deps);
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ language: expected }));
    expect(db.state.status).toBe("queued");
    expect(db.state.snapshot).toMatchObject({ payload: { recordingLanguage, language } });
  });

  it("persists original Spanish speech before creating and checkpointing an English report", async () => {
    const initial = job();
    initial.transcribe_job_name = "existing-transcribe-job";
    const db = store(initial);
    const deps = services();
    deps.report.mockImplementationOnce(async () => {
      expect(db.state.transcript).toEqual(transcript);
      return report;
    });
    await processReportJob(db.client, deps);
    expect(deps.report).toHaveBeenCalledWith(expect.objectContaining({ language: "es", sessionId: "visit-1", projectId: "coral-gables", transcript }));
    expect(db.events).toEqual(["claim_report_processing", "checkpoint-transcript", "checkpoint-report", "complete_report_processing"]);
    expect(db.rpc).toHaveBeenLastCalledWith("complete_report_processing", { job_id: jobId, worker_lease: lease, transcript_value: transcript, report_value: report });
    expect(db.state.status).toBe("completed");
  });

  it("retains the transcription checkpoint when the model fails and never retranscribes it", async () => {
    const initial = job();
    initial.transcribe_job_name = "existing-transcribe-job";
    const db = store(initial);
    const deps = services();
    deps.report.mockRejectedValueOnce(new Error("private provider details"));
    await processReportJob(db.client, deps);
    expect(db.state).toMatchObject({ status: "queued", transcript, failure_count: 1 });
    expect(db.state.last_error).not.toContain("private provider");
    await processReportJob(db.client, deps);
    expect(deps.poll).toHaveBeenCalledTimes(1);
    expect(deps.start).not.toHaveBeenCalled();
    expect(db.state.status).toBe("completed");
  });

  it("never treats empty speech as a successful audio report even when notes exist", async () => {
    const initial = job();
    initial.transcribe_job_name = "empty-speech-job";
    const db = store(initial);
    const deps = services();
    deps.poll.mockResolvedValueOnce({ status: "completed", transcript: { text: " ", source: "audio", segments: [] } });
    await processReportJob(db.client, deps);
    expect(db.state).toMatchObject({ status: "failed", last_error: expect.stringContaining("No speech") });
    expect(deps.report).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalledWith("complete_report_processing", expect.anything());
  });

  it("keeps provider failure details out of member-readable status", async () => {
    const initial = job();
    initial.transcribe_job_name = "failed-job";
    const db = store(initial);
    const deps = services();
    deps.poll.mockResolvedValueOnce({ status: "failed", error: "private AWS URL and credential detail" });
    await processReportJob(db.client, deps);
    expect(db.state.status).toBe("failed");
    expect(db.state.transcribe_failed).toBe(true);
    expect(db.state.last_error).not.toContain("private AWS");
    expect(deps.report).not.toHaveBeenCalled();
  });

  it.each(["completion error", "ambiguous checkpoint"])(
    "reuses saved model output after %s without downloading evidence or generating again",
    async (failure) => {
      const initial = job();
      initial.transcript = transcript;
      const db = store(initial);
      const deps = services();
      db.behavior.completionError = failure === "completion error";
      db.behavior.ambiguousCheckpoint = failure === "ambiguous checkpoint";
      await processReportJob(db.client, deps);
      expect(db.state).toMatchObject({ status: "queued", transcript, report });
      db.behavior.completionError = false;
      await processReportJob(db.client, deps);
      expect(deps.report).toHaveBeenCalledTimes(1);
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.poll).not.toHaveBeenCalled();
      expect(db.download).not.toHaveBeenCalled();
      expect(db.state.status).toBe("completed");
    },
  );

  it("stops after losing the lease before a paid report request", async () => {
    const initial = job();
    initial.transcribe_job_name = "completed-speech";
    const db = store(initial);
    db.behavior.loseLease = true;
    const deps = services();
    await expect(processReportJob(db.client, deps)).rejects.toThrow("lease lost");
    expect(deps.report).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalledWith("complete_report_processing", expect.anything());
  });

  it("validates checkpoint references without redownloading photos or calling the model", async () => {
    const initial = job();
    initial.transcript = transcript;
    const storedImage = { path: `${workspace}/${author}/visit-1/photo`, type: "image/jpeg", size: 3 };
    initial.snapshot.payload.photos = [{
      id: "photo-1", projectId: "coral-gables", sessionId: "visit-1", area: "Kitchen",
      capturedAt: "2026-10-14T10:00:00.000Z", elapsed: 2, note: "", origin: "camera",
      model: storedImage, original: storedImage,
    }];
    for (const photoId of ["photo-1", "unknown-photo"]) {
      const db = store(initial);
      db.state.report = { ...report, captions: [{ photoId, caption: "Visible wall" }] };
      db.download.mockRejectedValue(new Error("Media must not be reloaded for finalization"));
      const deps = services();
      await processReportJob(db.client, deps);
      expect(db.download).not.toHaveBeenCalled();
      expect(deps.report).not.toHaveBeenCalled();
      expect(db.state.status).toBe(photoId === "photo-1" ? "completed" : "queued");
      if (photoId !== "photo-1")
        expect(db.rpc).not.toHaveBeenCalledWith("complete_report_processing", expect.anything());
    }
  });

  it.each(["conflict", "cancelled"])("preserves generated output when finalization returns %s", async (status) => {
    const initial = job();
    initial.transcript = transcript;
    const db = store(initial);
    db.behavior.completionStatus = status;
    await processReportJob(db.client, services());
    expect(db.state).toMatchObject({ status, transcript, report });
    expect(db.patches).toHaveLength(1);
  });

  it("does not treat an empty completion response as saved output", async () => {
    const initial = job();
    initial.transcript = transcript;
    const db = store(initial);
    db.behavior.completionStatus = null;
    await processReportJob(db.client, services());
    expect(db.state).toMatchObject({ status: "queued", transcript, report, failure_count: 1 });
  });

  it("blocks media outside the workspace and checks downloaded byte counts", async () => {
    for (const mismatch of ["workspace", "size"]) {
      const initial = job();
      if (mismatch === "workspace") initial.snapshot.payload.audio.path = "another-workspace/audio";
      const db = store(initial);
      if (mismatch === "size") db.download.mockResolvedValueOnce({ data: new Blob(["wrong-size"]), error: null });
      const deps = services();
      await processReportJob(db.client, deps);
      expect(deps.start).not.toHaveBeenCalled();
      expect(deps.report).not.toHaveBeenCalled();
      expect(db.state.status).toBe("queued");
    }
  });

  it("fails closed for expired jobs, missing recording bytes and repeated errors", async () => {
    const expired = job();
    expired.deadline_at = new Date(Date.now() - 1).toISOString();
    const db = store(expired);
    const deps = services();
    await processReportJob(db.client, deps);
    expect(db.state.status).toBe("failed");
    expect(deps.start).not.toHaveBeenCalled();
    const missing = job();
    const missingDb = store(missing);
    delete (missingDb.state.snapshot as { payload: { audio?: typeof audio } }).payload.audio;
    await processReportJob(missingDb.client, deps);
    expect(missingDb.state).toMatchObject({ status: "failed", last_error: expect.stringContaining("No recording") });
    const repeated = job();
    repeated.failure_count = 2;
    const retryDb = store(repeated);
    deps.start.mockRejectedValueOnce(new Error("private error"));
    await processReportJob(retryDb.client, deps);
    expect(retryDb.state).toMatchObject({ status: "failed", failure_count: 3 });
  });
});
