import { afterEach, describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import {
  handleReport,
  handleTranscribe,
  transcribeAudio,
  generateReport,
  readLimited,
} from "../server/api";
import { projects, LIMITS } from "../shared/model";
import { createSample } from "../src/sample";
afterEach(() => vi.unstubAllEnvs());
function live() {
  vi.stubEnv("LIVE_AI_ENABLED", "true");
  vi.stubEnv("OPENAI_API_KEY", "test-not-real");
}
function request(body: string, origin = "http://localhost:8790") {
  return new Request("http://localhost:8790/api/report", {
    method: "POST",
    body,
    headers: { origin, "content-type": "application/json" },
  });
}
describe("API input and mode boundaries", () => {
  it("defaults disabled, never returns sample success from either live route", async () => {
    vi.stubEnv("LIVE_AI_ENABLED", "false");
    for (const handler of [handleReport, handleTranscribe]) {
      const result = await handler(request("{}"));
      expect(result.status).toBe(503);
      expect(await result.json()).toHaveProperty("error");
    }
  });
  it("requires a configured trusted origin", async () => {
    live();
    expect(
      (await handleReport(request("{}", "https://untrusted.example"))).status,
    ).toBe(403);
  });
  it("requires sign-in on cloud-configured AI routes before processing input", async () => {
    live();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    for (const handler of [handleReport, handleTranscribe])
      expect((await handler(request("{}"))).status).toBe(401);
  });
  it("rejects malformed inputs before any provider request", async () => {
    live();
    expect((await handleReport(request("{bad"))).status).toBe(400);
    expect((await handleReport(request("{}"))).status).toBe(400);
  });
  it("enforces actual streamed body size even without Content-Length", async () => {
    await expect(
      readLimited(request("x".repeat(LIMITS.requestBytes + 1))),
    ).rejects.toThrow("3 MB");
  });
  it("rejects video and MIME spoofing", async () => {
    live();
    const form = new FormData();
    form.set("audio", new File(["fake"], "audio.webm", { type: "audio/webm" }));
    form.set("duration", "10");
    const r = await handleTranscribe(
      new Request("http://localhost/api/transcribe", {
        method: "POST",
        body: form,
        headers: { origin: "http://localhost:8790" },
      }),
    );
    expect(r.status).toBe(400);
  });
});
describe("Provider integration contract (mocked SDK, no billable calls)", () => {
  it("requests whisper segment timestamps using the completed file", async () => {
    vi.stubEnv("OPENAI_TRANSCRIBE_MODEL", "whisper-1");
    const create = vi.fn().mockResolvedValue({
      text: "Vanity installed.",
      segments: [{ start: 0, end: 2, text: "Vanity installed." }],
    });
    const fake = { audio: { transcriptions: { create } } } as unknown as OpenAI;
    const audio = new File(["complete-audio"], "recording.webm", {
      type: "audio/webm",
    });
    const t = await transcribeAudio(audio, fake);
    expect(create.mock.calls[0][0]).toMatchObject({
      file: audio,
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });
    expect(t.segments[0].start).toBe(0);
  });
  it("other models receive no unsupported timestamp arguments or invented timing", async () => {
    vi.stubEnv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe");
    const create = vi
      .fn()
      .mockResolvedValue({ text: "A manually timed example is not assumed." });
    const t = await transcribeAudio(new File(["audio"], "x.m4a"), {
      audio: { transcriptions: { create } },
    } as unknown as OpenAI);
    expect(create.mock.calls[0][0].timestamp_granularities).toBeUndefined();
    expect(t.segments[0].start).toBeNull();
    expect(t.segments[0].end).toBeNull();
  });
  it("rejects empty transcription", async () => {
    const fake = {
      audio: {
        transcriptions: { create: vi.fn().mockResolvedValue({ text: " " }) },
      },
    } as unknown as OpenAI;
    await expect(
      transcribeAudio(new File(["audio"], "x.webm"), fake),
    ).rejects.toThrow("No speech");
  });
  it("uses actual supplied data, strict schema, image content, and store false", async () => {
    const s = createSample(projects[0]);
    const output = structuredClone(s.report!);
    output.actionItems[0].assignee = "Invented Person";
    output.actionItems[0].dueDateText = "October 19";
    const parse = vi
      .fn()
      .mockResolvedValue({ status: "completed", output_parsed: output });
    const input = {
      sessionId: s.id,
      projectId: s.projectId,
      notes: s.notes,
      transcript: s.transcript,
      photos: [
        {
          id: "photo",
          sessionId: s.id,
          projectId: s.projectId,
          area: "Primary Bathroom",
          capturedAt: new Date().toISOString(),
          elapsed: 2,
          note: "photo note",
          origin: "camera",
          dataUrl: "data:image/jpeg;base64,/9j/",
        },
      ],
    };
    const report = await generateReport(input, {
      responses: { parse },
    } as unknown as OpenAI);
    expect(report.actionItems[0].assignee).toBeNull();
    expect(report.actionItems[0].dueDateText).toBeNull();
    const arg = parse.mock.calls[0][0];
    expect(arg.store).toBe(false);
    expect(arg.text.format.type).toBe("json_schema");
    expect(
      arg.input[0].content.some(
        (c: { type: string }) => c.type === "input_image",
      ),
    ).toBe(true);
    expect(arg.input[0].content[0].text).toContain(
      "The shower still needs caulking.",
    );
  });
  it("refusal, incomplete output, and bad evidence fail without fictional replacement", async () => {
    const s = createSample(projects[0]);
    const input = {
      sessionId: s.id,
      projectId: s.projectId,
      notes: s.notes,
      transcript: s.transcript,
      photos: [],
    };
    for (const result of [
      { status: "incomplete", output_parsed: null },
      { status: "completed", output_parsed: null },
    ])
      await expect(
        generateReport(input, {
          responses: { parse: vi.fn().mockResolvedValue(result) },
        } as unknown as OpenAI),
      ).rejects.toThrow("incomplete");
    const bad = structuredClone(s.report!);
    bad.observations[0].photoIds = ["invented"];
    await expect(
      generateReport(input, {
        responses: {
          parse: vi
            .fn()
            .mockResolvedValue({ status: "completed", output_parsed: bad }),
        },
      } as unknown as OpenAI),
    ).rejects.toThrow("unknown evidence");
  });
});
