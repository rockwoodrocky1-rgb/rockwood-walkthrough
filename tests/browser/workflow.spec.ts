import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
const imagePath = path.resolve("public/brand/rockwood-logo.png");
async function home(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your projects" }),
  ).toBeVisible();
}
async function project(page: Page, name = "Coral Gables Residence") {
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start walkthrough" }),
  ).toBeEnabled();
}
async function capture(page: Page) {
  await home(page);
  await project(page);
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect(page.locator(".recording-status")).toContainText("AUDIO REC");
  await expect(
    page.getByRole("button", { name: "Take photo", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth),
    )
    .toBeGreaterThan(0);
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function readSessions(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("rockwood-walkthrough-v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const s = await new Promise<unknown[]>((resolve, reject) => {
      const r = db.transaction("sessions").objectStore("sessions").getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return s;
  });
}
test("phone viewfinder fills the available width and stays centered", async ({
  page,
}) => {
  await capture(page);
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ]) {
    await page.setViewportSize(viewport);
    const frame = await page.locator(".viewfinder").boundingBox();
    const video = await page.locator("video").boundingBox();
    expect(frame).not.toBeNull();
    expect(video).not.toBeNull();
    expect(frame!.width).toBeCloseTo(viewport.width - 32, 0);
    expect(frame!.x + frame!.width / 2).toBeCloseTo(viewport.width / 2, 0);
    expect(video!.width).toBeCloseTo(frame!.width, 0);
    expect(video!.x).toBeCloseTo(frame!.x, 0);
    await noOverflow(page);
  }
  await page.getByRole("button", { name: "Done", exact: true }).click();
});

test("Done saves offline without an AI request when AI is disabled", async ({
  page,
  context,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) requests.push(request.url());
  });
  await capture(page);
  await page.getByRole("button", { name: "Take photo", exact: true }).click();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Walkthrough captured." }),
  ).toBeVisible();
  await expect(
    page
      .locator(".notice[role=alert]")
      .filter({ hasText: /AI|fetch|server|storage failed/i }),
  ).toHaveCount(0);
  await expect(page.locator("audio")).toBeVisible();
  expect(requests).toEqual([]);
  const sessions = (await readSessions(page)) as Array<{
    photos: unknown[];
    error?: string;
  }>;
  expect(sessions[0].error).toBeUndefined();
  expect(
    await page
      .locator("audio")
      .evaluate(
        async (audio: HTMLAudioElement) =>
          (await (await fetch(audio.src)).arrayBuffer()).byteLength,
      ),
  ).toBeGreaterThan(0);
  expect(sessions[0].photos).toHaveLength(1);
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator(".photo-thumb")).toHaveCount(1);
  await expect(
    page.getByText("Storage: this browser only", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("audio")).toBeVisible();
});

test("an aborted AI check explains recovery and a retry keeps the capture", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    Object.assign(window, { abortAiCheck: true });
    window.fetch = (...args) => {
      if (args[0] === "/api/config" && Reflect.get(window, "abortAiCheck"))
        return Promise.reject(
          new DOMException("Fetch is aborted", "AbortError"),
        );
      return nativeFetch(...args);
    };
  });
  await capture(page);
  await page.getByRole("button", { name: "Take photo", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Check AI availability", exact: true })
    .click();
  const aiError = page.locator(".notice[role=alert]").filter({ hasText: "AI" });
  await expect(aiError).toContainText(
    "Check AI availability was interrupted or took too long",
  );
  await expect(aiError).not.toContainText("Fetch is aborted");
  await expect(page.locator(".photo-thumb")).toHaveCount(1);
  await page.evaluate(() => Reflect.set(window, "abortAiCheck", false));
  await page
    .getByRole("button", { name: "Check AI availability", exact: true })
    .click();
  await expect(aiError).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create manual report", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(page.locator(".photo-thumb")).toHaveCount(1);
  await expect(page.locator("audio")).toBeVisible();
});

test("three projects, honest sample and desktop/mobile layouts; sample makes no API requests", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const apiCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) apiCalls.push(r.url());
  });
  await home(page);
  await expect(page.locator(".project-card")).toHaveCount(3);
  await page.screenshot({ path: "qa/projects-desktop.png", fullPage: true });
  for (const name of [
    "Coral Gables Residence",
    "Doral Office Buildout",
    "Pinecrest Custom Home",
  ]) {
    await project(page, name);
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "All projects" }).click();
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(page);
    if (width === 390)
      await page.screenshot({ path: "qa/projects-mobile.png", fullPage: true });
  }
  await project(page);
  await page.screenshot({ path: "qa/project-mobile.png", fullPage: true });
  await page
    .getByRole("button", { name: "View sample report", exact: true })
    .click();
  await expect(page.locator(".report-disclosure")).toContainText(
    "Fictional sample report",
  );
  await noOverflow(page);
  await page.screenshot({
    path: "qa/sample-report-mobile.png",
    fullPage: true,
  });
  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
});
test("sample editing, tasks, review invalidation, saving and project isolation survive reload", async ({
  page,
}) => {
  await home(page);
  await project(page);
  await page
    .getByRole("button", { name: "View sample report", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit report", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Visit summary", exact: true })
    .fill("Edited sample summary.");
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Report saved");
  await page
    .getByRole("button", { name: "Mark reviewed", exact: true })
    .click();
  await expect(page.locator(".report-meta")).toContainText("Reviewed");
  await page
    .getByRole("textbox", { name: "Visit summary", exact: true })
    .fill("Further sample edits.");
  await expect(page.locator(".report-meta")).toContainText("Draft");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByLabel("Action item", { exact: true })
    .last()
    .fill("Confirm site access.");
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Report saved");
  await page.reload();
  await expect(page.locator(".summary-text")).toHaveText(
    "Further sample edits.",
  );
  await page
    .getByRole("button", { name: "Back to project", exact: true })
    .click();
  await expect(page.locator(".saved-row")).toHaveCount(1);
  await page.getByRole("button", { name: "All projects" }).click();
  await project(page, "Doral Office Buildout");
  await expect(page.locator(".saved-row")).toHaveCount(0);
});
test("simulated media: audio-only recorder, independent photos, pause timeline, final chunk and reload recovery", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Native = window.MediaRecorder;
    const stats = {
      videoTracks: [] as number[],
      audioTracks: [] as number[],
      bytes: 0,
      events: 0,
      stopped: false,
    };
    Object.assign(window, { captureTestStats: stats });
    window.MediaRecorder = class extends Native {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        stats.videoTracks.push(stream.getVideoTracks().length);
        stats.audioTracks.push(stream.getAudioTracks().length);
        this.addEventListener("dataavailable", (e) => {
          stats.bytes += e.data.size;
          stats.events++;
        });
        this.addEventListener("stop", () => {
          stats.stopped = true;
        });
      }
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page);
  await page.getByLabel("Current area").selectOption("Primary Bathroom");
  await page.getByRole("button", { name: "Take photo", exact: true }).click();
  await expect(page.locator(".photo-thumb")).toHaveCount(1);
  await page.getByRole("button", { name: "Take photo", exact: true }).click();
  await expect(page.locator(".photo-thumb")).toHaveCount(2);
  await expect(page.locator(".recording-status")).toContainText("AUDIO REC");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Take photo", exact: true }),
  ).toBeDisabled();
  const before = await page.locator(".recording-status b").innerText();
  await page.waitForTimeout(1300);
  expect(await page.locator(".recording-status b").innerText()).toBe(before);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "qa/capture-mobile.png", fullPage: true });
  await noOverflow(page);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Walkthrough captured." }),
  ).toBeVisible();
  await expect(page.locator(".report-choice")).toContainText(
    "Automatic AI reports are not enabled",
  );
  await expect(page.locator(".notice[role=alert]")).toHaveCount(0);
  const stats = await page.evaluate(() =>
    Reflect.get(window, "captureTestStats"),
  );
  expect(stats.videoTracks).toEqual([0]);
  expect(stats.audioTracks).toEqual([1]);
  expect(stats.stopped).toBe(true);
  const saved = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("rockwood-walkthrough-v1");
      r.onsuccess = () => resolve(r.result);
    });
    return new Promise<{ size: number; photos: number; type: string }>(
      (resolve) => {
        const r = db.transaction("sessions").objectStore("sessions").getAll();
        r.onsuccess = () => {
          const s = r.result.find((s) => s.audio);
          resolve({
            size: s.audio.size,
            photos: s.photos.length,
            type: s.audio.type,
          });
          db.close();
        };
      },
    );
  });
  expect(saved.size).toBe(stats.bytes);
  expect(saved.photos).toBe(2);
  expect(saved.type).toContain("audio/");
  expect(stats.events).toBeGreaterThan(1);
  await page.reload();
  await expect(page.locator(".photo-thumb")).toHaveCount(2);
  await expect(page.locator("audio")).toBeVisible();
});
test("visibility interruption pauses honestly and media releases on Done", async ({
  page,
}) => {
  await capture(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".recording-status")).toContainText("PAUSED");
  await expect(
    page.getByRole("button", { name: "Take photo", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
  });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator(".recording-status")).toContainText("AUDIO REC");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
});
test("permission denial offers upload/manual fallback; photos, editing, associations and print work", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied in test", "NotAllowedError");
    };
  });
  await home(page);
  await project(page);
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "permission was denied",
  );
  await page.getByRole("button", { name: "Use photos & typed notes" }).click();
  await page
    .getByLabel("Walkthrough notes", { exact: true })
    .fill("The vanity is installed. Verify the shower caulking.");
  await page.getByLabel("Area for uploads").selectOption("Primary Bathroom");
  await page.locator("input[type=file]").setInputFiles(imagePath);
  await expect(page.locator(".photo-thumb")).toHaveCount(1);
  await page.locator(".photo-thumb").click();
  await page
    .getByLabel("Optional note", { exact: true })
    .fill("Test upload, not site evidence.");
  await page.getByRole("button", { name: "Save photo details" }).click();
  await page.getByRole("button", { name: "Create manual report" }).click();
  await expect(page.locator(".report-disclosure")).toContainText(
    "Manually prepared",
  );
  await expect(page.locator(".summary-text")).toContainText(
    "The vanity is installed",
  );
  await page.getByRole("button", { name: "Edit report", exact: true }).click();
  await page
    .getByLabel("Caption for photo 1")
    .fill("QA fixture image — not a site photo.");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByLabel("Action item", { exact: true })
    .fill("Review uploaded fixture.");
  await page.getByLabel("Photo 1 · Primary Bathroom").check();
  await page
    .getByRole("button", { name: "Preview report", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Complete: Review uploaded fixture." })
    .click();
  await expect(page.locator(".is-done")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Mark reviewed", exact: true })
    .click();
  await page.reload();
  await expect(page.locator(".report-meta")).toContainText("Reviewed");
  await expect(page.locator("figcaption")).toContainText("QA fixture");
  await page.screenshot({
    path: "qa/manual-report-desktop.png",
    fullPage: true,
  });
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".report-topbar")).toBeHidden();
  await expect(page.locator(".report-header .logo")).toBeVisible();
  await expect(page.locator(".report-photos img")).toBeVisible();
  await page.pdf({
    path: "qa/manual-report-print.pdf",
    format: "A4",
    printBackground: true,
  });
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 320, height: 844 });
  await noOverflow(page);
});
test("mocked AI failure preserves actual capture and transcript; retry does not retranscribe", async ({
  page,
}) => {
  let transcriptions = 0;
  let reports = 0;
  await page.route("**/api/config", (r) => r.fulfill({ json: { live: true } }));
  await page.route("**/api/transcribe", (r) => {
    transcriptions++;
    return r.fulfill({
      json: {
        text: "The vanity is installed.",
        source: "audio",
        segments: [
          { id: "seg-1", start: 0, end: 2, text: "The vanity is installed." },
        ],
      },
    });
  });
  await page.route("**/api/report", (r) => {
    reports++;
    if (reports <= 2)
      return r.fulfill({
        status: 502,
        json: { error: "Mocked provider failure; capture preserved." },
      });
    return r.fulfill({
      json: {
        summary: "The vanity is reported installed.",
        observations: [
          {
            id: "o-1",
            area: "Primary Bathroom",
            description: "The vanity is reported installed.",
            basis: "narration",
            state: "reported_complete",
            photoIds: [],
            transcriptSegmentIds: ["seg-1"],
            noteIds: [],
            needsVerification: true,
          },
        ],
        actionItems: [],
        captions: [],
      },
    });
  });
  await capture(page);
  await page.getByRole("button", { name: "Take photo", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Check AI availability", exact: true })
    .click();
  await expect(
    page
      .locator(".notice[role=alert]")
      .filter({ hasText: "Mocked provider failure" }),
  ).toContainText("Mocked provider failure");
  expect(transcriptions).toBe(1);
  await page
    .getByRole("button", { name: "Prepare report / Retry", exact: true })
    .click();
  await expect.poll(() => reports).toBe(2);
  await expect(
    page
      .locator(".notice[role=alert]")
      .filter({ hasText: "Mocked provider failure" }),
  ).toContainText("Mocked provider failure");
  expect(transcriptions).toBe(1);
  await page.reload();
  await expect(page.locator(".photo-thumb")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Prepare report / Retry", exact: true })
    .click();
  await expect(page.locator(".report-disclosure")).toContainText(
    "AI-assisted draft",
  );
  expect(transcriptions).toBe(1);
  expect(reports).toBe(3);
  await expect(page.locator(".report-paper")).not.toContainText(
    "Fictional sample report.",
  );
});
test("uploads reject HEIC honestly; reset requires confirmation", async ({
  page,
}) => {
  await home(page);
  await project(page);
  await page
    .getByRole("button", { name: "Prefer to upload photos and type notes?" })
    .click();
  await page.locator("input[type=file]").setInputFiles({
    name: "photo.heic",
    mimeType: "image/heic",
    buffer: Buffer.from("unsupported"),
  });
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "HEIC is not supported",
  );
  await expect(page.locator(".photo-thumb")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reset demo data", exact: true })
    .click();
  await page.getByRole("button", { name: "Keep my data" }).click();
  expect((await readSessions(page)).length).toBe(1);
  await page
    .getByRole("button", { name: "Reset demo data", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete all local walkthroughs" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your projects" }),
  ).toBeVisible();
  expect((await readSessions(page)).length).toBe(0);
});
test("interrupted recording recovers persisted photos/audio after reload", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await capture(page);
  await page.getByRole("button", { name: "Take photo", exact: true }).click();
  await page.waitForTimeout(1300);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Walkthrough captured." }),
  ).toBeVisible();
  await expect(
    page
      .locator(".notice[role=alert]")
      .filter({ hasText: "Recording was interrupted" }),
  ).toBeVisible();
  await expect(page.locator(".photo-thumb")).toHaveCount(1);
  await expect(page.locator("audio")).toBeVisible();
});
test("twelve-photo limit, photo removal, and unsupported-browser fallback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: undefined,
    });
  });
  await home(page);
  await project(page);
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "not supported",
  );
  await page.getByRole("button", { name: "Use photos & typed notes" }).click();
  await page
    .locator("input[type=file]")
    .setInputFiles(Array.from({ length: 13 }, () => imagePath));
  await expect(page.locator(".photo-thumb")).toHaveCount(12);
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "Twelve-photo limit",
  );
  await expect(page.locator("input[type=file]")).toBeDisabled();
  await page.locator(".photo-thumb").first().click();
  await page.getByRole("button", { name: "Remove photo", exact: true }).click();
  await expect(page.locator(".photo-thumb")).toHaveCount(11);
  await expect(page.locator("input[type=file]")).toBeEnabled();
});
test("missing devices are reported with a working manual fallback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Missing in test", "NotFoundError");
    };
  });
  await home(page);
  await project(page);
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "No camera or microphone was found",
  );
  await page.getByRole("button", { name: "Use photos & typed notes" }).click();
  await expect(
    page.getByRole("button", { name: "Create manual report" }),
  ).toBeEnabled();
});
test("plain HTTP capability fallback explains HTTPS and still allows typed notes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });
  await home(page);
  await project(page);
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "HTTPS or localhost",
  );
  await page.getByRole("button", { name: "Use photos & typed notes" }).click();
  await page
    .getByLabel("Walkthrough notes", { exact: true })
    .fill("Manually documented site note.");
  await page.getByRole("button", { name: "Create manual report" }).click();
  await expect(page.locator(".summary-text")).toContainText(
    "Manually documented site note.",
  );
});
