import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getProcessing, queueProcessing, getLiveConfig } from "../src/api";
import { getSupabase } from "../src/supabase";
import { processingLocksSource, watchProcessingStatus } from "../src/ProcessingStatus";
import { resolveVisitForOpening, saveSourceForProcessing } from "../src/App";
import SessionReview from "../src/SessionReview";
import { loadCloudSession, type WorkspaceAccess } from "../src/cloud";
import { createSample } from "../src/sample";
import { projects, type Session } from "../shared/model";
import type { ProcessingStatus } from "../shared/processing";
import { translate } from "../src/i18n";

vi.mock("../src/supabase", () => ({ getSupabase: vi.fn() }));
vi.mock("../src/cloud", async (original) => ({
  ...await original<typeof import("../src/cloud")>(),
  loadCloudSession: vi.fn(),
}));
const workspace = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const visitId = "visit-1";
function job(status: ProcessingStatus["status"] = "queued"): ProcessingStatus {
  return { id: jobId, walkthrough_id: visitId, source_revision: 3, status,
    phase: status === "completed" ? "complete" : "queued",
    last_error: null, transcript: null, report: null,
    created_at: "2026-10-14T12:00:00Z", updated_at: "2026-10-14T12:00:00Z" };
}
beforeEach(() => {
  vi.mocked(getSupabase).mockReturnValue({
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "test-session" } } }) },
  } as unknown as ReturnType<typeof getSupabase>);
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers();
});

describe("saved report processing requests", () => {
  it("queues only a saved visit identity and an explicit retry, authenticated once", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({id: jobId}, {status: 202}));
    vi.stubGlobal("fetch", fetch);
    await expect(queueProcessing(workspace, visitId, true)).resolves.toEqual({id: jobId});
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/process");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({workspaceId: workspace, walkthroughId: visitId, retry: true});
    expect(init.headers.Authorization).toBe("Bearer test-session");
  });
  it("checks uncached status with an encoded visit id and authenticated session", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({job: job()}));
    vi.stubGlobal("fetch", fetch);
    await expect(getProcessing(workspace, "visit / ?")).resolves.toEqual(job());
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url, "http://localhost").searchParams.get("visit")).toBe("visit / ?");
    expect(init.cache).toBe("no-store");
    expect(init.headers.Authorization).toBe("Bearer test-session");
  });
  it("does not send unauthenticated processing requests", async () => {
    vi.mocked(getSupabase).mockReturnValue(null);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(getProcessing(workspace, visitId)).rejects.toThrow("Sign in again");
    await expect(queueProcessing(workspace, visitId)).rejects.toThrow("Sign in again");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("distinguishes a missing job from an invalid response instead of unlocking edits", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({job: null}))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({job: {...job(), status: "done"}}))
      .mockResolvedValueOnce(Response.json({id: "not-a-job-id"})));
    await expect(getProcessing(workspace, visitId)).resolves.toBeNull();
    await expect(getProcessing(workspace, visitId)).rejects.toThrow("Could not check report progress");
    await expect(getProcessing(workspace, visitId)).rejects.toThrow("Could not check report progress");
    await expect(queueProcessing(workspace, visitId)).rejects.toThrow("Check report progress before retrying");
  });
  it("times out a lost enqueue response without retrying or claiming device-only storage", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetch);
    const result = expect(queueProcessing(workspace, visitId)).rejects.toThrow(
      "The connection was interrupted. Your visit is saved. Check report progress before retrying.");
    await vi.advanceTimersByTimeAsync(20_001);
    await result;
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps background status available when new AI processing is disabled", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({live: false, processing: "background"}))
      .mockResolvedValueOnce(Response.json({live: true, processing: "invalid"})));
    await expect(getLiveConfig()).resolves.toEqual({live: false, processing: "background"});
    await expect(getLiveConfig()).rejects.toThrow("Could not check AI availability");
  });
});

describe("processing status lifecycle", () => {
  it("polls pending jobs, retains state on a network error, then stops on completion", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(job())
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(job("completed"));
    const receive = vi.fn(), failed = vi.fn();
    const stop = watchProcessingStatus(workspace, visitId, receive, failed, read);
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenLastCalledWith(job());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failed).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(receive).toHaveBeenLastCalledWith(job("completed"));
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
  it("ignores a response for a page already left and does not restart its timer", async () => {
    vi.useFakeTimers();
    let finish!: (value: ProcessingStatus) => void;
    const read = vi.fn(() => new Promise<ProcessingStatus>(resolve => {finish = resolve;}));
    const receive = vi.fn(), failed = vi.fn();
    const stop = watchProcessingStatus(workspace, visitId, receive, failed, read);
    stop(); finish(job());
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not release a stale source when the worker has completed a newer saved version", () => {
    expect(processingLocksSource(job(), 3)).toBe(true);
    expect(processingLocksSource(job("processing"), 4)).toBe(true);
    expect(processingLocksSource(job("completed"), 3)).toBe(true);
    expect(processingLocksSource(job("completed"), 4)).toBe(false);
    expect(processingLocksSource(job("conflict"), 3)).toBe(true);
    expect(processingLocksSource(job("failed"), 3)).toBe(false);
    expect(processingLocksSource(null, 3)).toBe(false);
  });
});

describe("completed report and source controls", () => {
  const access = {workspaceId: workspace} as WorkspaceAccess;
  const stale: Session = {...createSample(projects[0]), report: undefined,
    cloud: {revision: 3, mediaLoaded: true, pending: false}};
  it("retries an unchanged saved source without advancing the deduplication revision", async () => {
    const save = vi.fn(async (session: Session) => ({...session,
      cloud: {...session.cloud!, revision: session.cloud!.revision + 1}}));
    const fetch = vi.fn().mockImplementation(async () => Response.json({id: jobId}, {status: 202}));
    vi.stubGlobal("fetch", fetch);
    const first = await saveSourceForProcessing(stale, access, save);
    const firstJob = await queueProcessing(workspace, first.id);
    const retry = await saveSourceForProcessing({...first, error: "Connection lost"}, access, save);
    const retriedJob = await queueProcessing(workspace, retry.id, true);
    expect(save).not.toHaveBeenCalled();
    expect(first.cloud?.revision).toBe(3);
    expect(retry.cloud?.revision).toBe(3);
    expect(retry.error).toBeUndefined();
    expect(retriedJob.id).toBe(firstJob.id);
    expect(JSON.parse(fetch.mock.calls[1][1].body).retry).toBe(true);
  });
  it.each(["new capture", "pending recovery", "explicit regeneration"])("saves %s before queuing", async (kind) => {
    const source: Session = {...stale,
      cloud: kind === "new capture" ? undefined : {...stale.cloud!, pending: kind === "pending recovery"},
      report: kind === "explicit regeneration" ? createSample(projects[0]).report : undefined};
    const saved = {...source, cloud: {...stale.cloud!, revision: 4, pending: false}};
    const save = vi.fn().mockResolvedValue(saved);
    await expect(saveSourceForProcessing(source, access, save)).resolves.toBe(saved);
    expect(save).toHaveBeenCalledOnce();
  });
  it("explicitly reloads a completed report even when its source media is already loaded", async () => {
    const completed = {...stale, report: createSample(projects[0]).report,
      cloud: {...stale.cloud!, revision: 4}};
    vi.mocked(loadCloudSession).mockResolvedValueOnce(completed);
    const opened = await resolveVisitForOpening(stale, access, true);
    expect(loadCloudSession).toHaveBeenCalledWith(access, stale.id);
    expect(opened.report).toBe(completed.report);
    expect(opened.cloud?.revision).toBe(4);
  });
  it("preserves local drafts during ordinary navigation and offline report opening", async () => {
    await expect(resolveVisitForOpening(stale, access)).resolves.toBe(stale);
    await expect(resolveVisitForOpening(stale, undefined, true)).resolves.toBe(stale);
    expect(loadCloudSession).not.toHaveBeenCalled();
  });
  it("disables source mutations while pending but keeps navigation available", () => {
    const html = renderToStaticMarkup(createElement(SessionReview, {
      session: stale, project: projects[0], stage: "", backgroundBusy: true,
      liveAiEnabled: true, cloudEnabled: true, update: vi.fn(), process: vi.fn(),
      manual: vi.fn(), back: vi.fn(), sample: vi.fn(),
    }));
    const fields = html.match(/<(?:textarea|select|input)\b[^>]*>/g) ?? [];
    expect(fields.length).toBeGreaterThanOrEqual(4);
    for (const field of fields) expect(field).toContain('disabled=""');
    expect(html).toMatch(/<button[^>]*class="button primary report-next"[^>]*disabled=""/);
    const back = html.match(/<button[^>]*class="text-button back no-print"[^>]*>/)?.[0];
    expect(back).toBeDefined();
    expect(back).not.toContain("disabled");
  });
  it.each([
    "Checking report progress…", "Report ready", "Report queued", "Open report", "Retry report",
    "Your visit is saved. You can leave this page while the report finishes.",
    "Processing took too long. Your recording is saved. Retry the report.",
    "Transcription could not be completed. Your recording is saved. Retry the report.",
    "No speech was found in the recording. Add a transcript before creating the report.",
    "No recording was saved. Add spoken notes or a transcript before creating the report.",
    "No speech or notes were found. Add notes or photos before creating the report.",
    "The report could not be completed. Your recording is saved. Retry the report.",
    "Processing was interrupted. It will retry automatically.",
    "This saved visit could not be processed. Reopen and save the visit before trying again.",
    "The connection was interrupted. Your visit is saved. Check report progress before retrying.",
  ])("translates processing feedback: %s", message => {
    expect(translate("es", message)).not.toBe(message);
    expect(translate("en", message)).toBe(message);
  });
});
