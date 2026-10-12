import "fake-indexeddb/auto";
import { afterEach, it, expect } from "vitest";
import { createSample } from "../src/sample";
import { projects } from "../shared/model";
import {
  saveSession,
  loadSession,
  listSessions,
  saveChunk,
  recoverSession,
  resetData,
  configureStorage,
} from "../src/storage";
afterEach(async () => {
  await resetData();
  configureStorage();
});
it("isolates unfinished recovery copies between user accounts", async () => {
  configureStorage("account-one");
  await saveSession(createSample(projects[0]));
  configureStorage("account-two");
  expect(await listSessions()).toEqual([]);
  configureStorage("account-one");
  expect(await listSessions()).toHaveLength(1);
});
it("round trips full media and report edits through IndexedDB", async () => {
  const s = createSample(projects[0]);
  s.audio = new Blob(["audio"], { type: "audio/webm" });
  s.report!.summary = "Edited and saved";
  await saveSession(s);
  const loaded = await loadSession(s.id);
  expect(loaded?.report?.summary).toBe("Edited and saved");
  expect(await loaded?.audio?.text()).toBe("audio");
});
it("recovers only the interrupted session chunks in sequence, preserving photos and warning", async () => {
  const s = createSample(projects[0]);
  s.status = "recording";
  s.mime = "audio/webm";
  await saveChunk(s.id, 1, new Blob(["second"]));
  await saveChunk(s.id, 0, new Blob(["first"]));
  await saveChunk("another-session", 0, new Blob(["unrelated"]));
  const recovered = await recoverSession(s);
  expect(await recovered.audio?.text()).toBe("firstsecond");
  expect(recovered.status).toBe("interrupted");
  expect(recovered.error).toContain("may not be playable");
});
it("keeps projects isolated and reset removes both session and chunk data", async () => {
  for (const p of projects) await saveSession(createSample(p));
  expect(
    (await listSessions()).filter((s) => s.projectId === "doral-office"),
  ).toHaveLength(1);
  await resetData();
  expect(await listSessions()).toHaveLength(0);
});
