import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLiveConfig,
  serverRequest,
  explainSavedProcessingError,
} from "../src/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("recoverable client request failures", () => {
  it("explains the aborted message on a previously saved visit", () => {
    expect(explainSavedProcessingError("Fetch is aborted")).toContain(
      "The previous AI request was interrupted",
    );
    expect(
      explainSavedProcessingError(
        "Recording was interrupted. Photos were recovered.",
      ),
    ).toBe("Recording was interrupted. Photos were recovered.");
  });
  it("explains a Safari-style aborted configuration check", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(new DOMException("Fetch is aborted", "AbortError")),
    );
    await expect(getLiveConfig()).rejects.toThrow(
      "Check AI availability was interrupted or took too long",
    );
  });

  it("handles timeouts while reading the response body and clears its timer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal!.addEventListener("abort", () =>
                reject(new DOMException("Fetch is aborted", "AbortError")),
              );
            }),
        }),
      ),
    );
    const result = expect(
      serverRequest("/api/report", {}, "Prepare report", 100),
    ).rejects.toThrow("Your walkthrough is still saved in this browser");
    await vi.advanceTimersByTimeAsync(101);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("explains a disconnected server without exposing the browser's raw error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Load failed")),
    );
    await expect(getLiveConfig()).rejects.toThrow(
      "Could not reach the site to check AI availability",
    );
  });

  it("preserves actionable server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: "Audio exceeds the 3 MB limit." },
            { status: 413 },
          ),
        ),
    );
    await expect(
      serverRequest("/api/transcribe", {}, "Transcribe audio"),
    ).rejects.toThrow("Audio exceeds the 3 MB limit.");
  });

  it("explains an HTML response from an unavailable tunnel", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>Unavailable</html>", { status: 502 }),
        ),
    );
    await expect(getLiveConfig()).rejects.toThrow(
      "The site returned an unreadable response",
    );
  });

  it("does not treat malformed configuration as enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ live: "true" })),
    );
    await expect(getLiveConfig()).rejects.toThrow(
      "Could not check AI availability",
    );
  });
});
