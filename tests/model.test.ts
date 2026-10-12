import { describe, it, expect } from "vitest";
import {
  chooseAudioMime,
  audioExtension,
  RecordingClock,
  validateEvidence,
  projects,
  type ReportInput,
  type ReportContent,
} from "../shared/model";
import { createSample } from "../src/sample";
const sample = createSample(projects[0]);
const input: ReportInput = {
  sessionId: sample.id,
  projectId: "coral-gables",
  notes: sample.notes,
  photos: [],
  transcript: sample.transcript!,
};
const report = () => structuredClone(sample.report!);
describe("Audio formats and active recording timeline", () => {
  it("prefers Opus and falls back to audio MP4 without inventing support", () => {
    expect(
      chooseAudioMime(
        (t) => t === "audio/webm;codecs=opus" || t === "audio/mp4",
      ),
    ).toBe("audio/webm;codecs=opus");
    expect(chooseAudioMime((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(chooseAudioMime(() => false)).toBeNull();
  });
  it("uses matching extensions for actual audio MIME types", () => {
    expect(audioExtension("audio/mp4;codecs=mp4a.40.2")).toBe("m4a");
    expect(audioExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtension("video/mp4")).toBeNull();
  });
  it("excludes paused time; duplicate pause/resume do not skew time", () => {
    let now = 0;
    const clock = new RecordingClock(() => now);
    clock.resume();
    now = 3450;
    clock.resume();
    expect(clock.seconds()).toBe(3.45);
    clock.pause();
    now = 50_000;
    clock.pause();
    expect(clock.seconds()).toBe(3.45);
    clock.resume();
    now = 51_250;
    expect(clock.seconds()).toBe(4.7);
    clock.pause();
  });
});
describe("Report integrity and conservative evidence", () => {
  it("preserves the bathroom acceptance example with unassigned owners and dates", () => {
    expect(validateEvidence(report(), input)).toBeDefined();
    expect(report().observations.map((o) => o.state)).toEqual([
      "reported_complete",
      "outstanding",
      "requested_review",
    ]);
    expect(
      report().actionItems.every(
        (a) => a.assignee === null && a.dueDateText === null,
      ),
    ).toBe(true);
  });
  it("rejects unknown photos", () => {
    const r = report();
    r.observations[0].photoIds = ["other-session"];
    expect(() => validateEvidence(r, input)).toThrow("unknown evidence");
  });
  it("rejects unknown transcript segments", () => {
    const r = report();
    r.observations[0].transcriptSegmentIds = ["invented"];
    expect(() => validateEvidence(r, input)).toThrow();
  });
  it("rejects cross-session and cross-project photos", () => {
    expect(() =>
      validateEvidence(report(), {
        ...input,
        photos: [
          {
            id: "photo",
            sessionId: "different",
            projectId: "doral-office",
            area: "Kitchen",
            capturedAt: new Date().toISOString(),
            elapsed: 1,
            note: "",
            origin: "camera",
            dataUrl: "data:image/jpeg;base64,/9j/",
          },
        ],
      }),
    ).toThrow("belong");
  });
  it("never considers nearby photo timing evidence automatically", () => {
    const r = report();
    const withPhoto = {
      ...input,
      photos: [
        {
          id: "photo",
          sessionId: sample.id,
          projectId: input.projectId,
          area: "Primary Bathroom",
          capturedAt: new Date().toISOString(),
          elapsed: 1,
          note: "",
          origin: "camera" as const,
          dataUrl: "data:image/jpeg;base64,/9j/",
        },
      ],
    };
    const parsed = validateEvidence(r, withPhoto);
    expect(parsed.observations[0].photoIds).toEqual([]);
  });
  it("requires actual sources for mixed observations and reported completion", () => {
    const r = report();
    r.observations[0].basis = "mixed";
    expect(() => validateEvidence(r, input)).toThrow("Mixed evidence");
    r.observations[0].basis = "photo";
    r.observations[0].transcriptSegmentIds = [];
    expect(() => validateEvidence(r, input)).toThrow();
  });
  it("rejects duplicate IDs and dangling observation references", () => {
    const r = report();
    r.observations[1].id = r.observations[0].id;
    expect(() => validateEvidence(r, input)).toThrow("Duplicate");
    const r2 = report();
    r2.actionItems[0].observationIds = ["missing"];
    expect(() => validateEvidence(r2, input)).toThrow();
  });
  it("all sample projects have distinct stable report and session IDs", () => {
    const sessions = projects.map(createSample);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(3);
    for (const s of sessions) expect(s.report?.projectId).toBe(s.projectId);
  });
  it("schema rejects absent summary and invalid types", () => {
    expect(() =>
      validateEvidence(
        { ...report(), summary: 42 } as unknown as ReportContent,
        input,
      ),
    ).toThrow();
  });
});
