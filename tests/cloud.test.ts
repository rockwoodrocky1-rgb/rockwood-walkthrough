import { describe, it, expect, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  archiveCloudSession,
  loadCloudSession,
  listCloudSessions,
  mergeSessions,
  rowToSession,
  saveCloudSession,
  type CloudRow,
  type WorkspaceAccess,
} from "../src/cloud";
import { projects, type Session } from "../shared/model";

const workspace = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-12T12:00:00.000Z";
const row: CloudRow = {
  id: "visit-1",
  project_id: "coral-gables",
  workspace_id: workspace,
  created_by: user,
  started_at: now,
  updated_at: now,
  revision: 1,
  archived_at: null,
  payload: {
    duration: 5,
    status: "saved",
    notes: "Test note",
    mime: "audio/webm",
    photos: [],
  },
};
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function setup(fetcher: typeof fetch) {
  const client = createClient(
    "https://test.supabase.co",
    "sb_publishable_test",
    {
      accessToken: async () => "test-token",
      global: { fetch: fetcher },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  return {
    client,
    workspaceId: workspace,
    workspaceName: "Rockwood",
    userId: user,
    email: "test@example.com",
    role: "owner",
    projects,
    signOut: async () => {},
  } as WorkspaceAccess;
}
function session(): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    startedAt: now,
    duration: 5,
    status: "saved",
    notes: "Test note",
    mime: "audio/webm",
    photos: [],
  };
}
describe("shared walkthrough persistence", () => {
  it("loads older property visits beyond the first hundred records", async () => {
    const records = Array.from({ length: 105 }, (_, i) => ({ ...row, id: `visit-${i}` }));
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspace}`);
      return response(records.slice(offset, offset + limit));
    });
    const visits = await listCloudSessions(setup(fetcher));
    expect(visits).toHaveLength(105);
    expect(visits.at(-1)?.id).toBe("visit-104");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not silently present an incomplete visit list when a later page fails", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset") ?? 0);
      return offset ? response({ message: "Connection interrupted" }, 400) : response(Array.from({ length: 100 }, () => row));
    });
    await expect(listCloudSessions(setup(fetcher))).rejects.toThrow("Could not load");
  });
  it("uploads media before committing metadata and confirms the server revision", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/storage/")) return response({ Key: "saved" });
      const data = JSON.parse(init!.body as string);
      return response({ ...row, ...data }, 201);
    });
    const visit = session();
    visit.audio = new Blob(["audio"], { type: "audio/webm" });
    const saved = await saveCloudSession(setup(fetcher), visit);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/storage/");
    expect(calls[1]).toContain("/rest/v1/walkthroughs");
    expect(saved.cloud).toMatchObject({
      revision: 1,
      pending: false,
      mediaLoaded: true,
    });
    expect(await saved.audio?.text()).toBe("audio");
  });
  it.each([
    { recordingLanguage: "en" as const, language: "es" as const },
    { recordingLanguage: "es" as const, language: "en" as const },
  ])("preserves recording language $recordingLanguage when the report/UI language is $language across save and reopen", async languages => {
    let persisted = row;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/storage/"))
        return init?.method === "POST" ? response({ Key: "saved" }) : new Response("audio");
      if (init?.method === "POST") {
        persisted = { ...row, ...JSON.parse(init.body as string) };
        return response(persisted, 201);
      }
      return response(persisted);
    });
    const saved = await saveCloudSession(setup(fetcher), {
      ...session(), ...languages, audio: new Blob(["audio"], { type: "audio/webm" }),
    });
    expect(persisted.payload).toMatchObject(languages);
    expect(saved).toMatchObject(languages);
    const reopened = await loadCloudSession(setup(fetcher), row.id);
    expect(reopened).toMatchObject(languages);
    expect(await reopened.audio?.text()).toBe("audio");
  });
  it("never commits metadata when a media upload fails", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({ message: "Upload failed" }, 400),
    );
    const visit = session();
    visit.audio = new Blob(["audio"], { type: "audio/webm" });
    await expect(saveCloudSession(setup(fetcher), visit)).rejects.toThrow(
      "Upload did not finish",
    );
    expect(
      fetcher.mock.calls.every(([url]) => String(url).includes("/storage/")),
    ).toBe(true);
    expect(await visit.audio.text()).toBe("audio");
  });
  it("accepts an already uploaded identical object during retry", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) =>
      String(input).includes("/storage/")
        ? response(
            {
              statusCode: "409",
              error: "Duplicate",
              message: "Already exists",
            },
            409,
          )
        : response({ ...row, ...JSON.parse(init!.body as string) }, 201),
    );
    const visit = session();
    visit.audio = new Blob(["audio"], { type: "audio/webm" });
    expect((await saveCloudSession(setup(fetcher), visit)).cloud?.pending).toBe(
      false,
    );
  });
  it("does not overwrite another device’s newer revision", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(null));
    const visit = session();
    visit.cloud = { revision: 1, pending: true, mediaLoaded: true };
    await expect(saveCloudSession(setup(fetcher), visit)).rejects.toThrow(
      "another device",
    );
    expect(String(fetcher.mock.calls[0][0])).toContain("revision=eq.1");
  });
  it("denies a viewer save before attempting a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      saveCloudSession({ ...setup(fetcher), role: "viewer" }, session()),
    ).rejects.toThrow("permission");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("loads saved audio from private storage in a fresh client", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/storage/")
        ? new Response("saved audio")
        : response({
            ...row,
            payload: {
              ...row.payload,
              audio: {
                path: `${workspace}/${user}/visit-1/hash`,
                size: 11,
                type: "audio/webm",
              },
            },
          }),
    );
    const loaded = await loadCloudSession(setup(fetcher), row.id);
    expect(await loaded.audio?.text()).toBe("saved audio");
    expect(loaded.cloud?.mediaLoaded).toBe(true);
  });
  it("rejects a media reference outside the signed-in workspace", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({
        ...row,
        payload: {
          ...row.payload,
          audio: {
            path: "another-workspace/file",
            size: 5,
            type: "audio/webm",
          },
        },
      }),
    );
    await expect(loadCloudSession(setup(fetcher), row.id)).rejects.toThrow(
      "selected workspace",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps pending local edits over remote metadata and removes archived shared visits", () => {
    const remote = rowToSession({ ...row, revision: 2 });
    const local = {
      ...session(),
      notes: "unsynced",
      cloud: { revision: 1, pending: true },
    };
    expect(mergeSessions([local], [remote])[0].notes).toBe("unsynced");
    expect(
      mergeSessions(
        [{ ...local, cloud: { revision: 1, pending: false } }],
        [rowToSession({ ...row, revision: 2, archived_at: now })],
      ),
    ).toEqual([]);
  });
  it("archives with a revision check instead of deleting records or files", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ id: row.id }));
    await archiveCloudSession(setup(fetcher), rowToSession(row));
    const [url, init] = fetcher.mock.calls[0];
    expect(init?.method).toBe("PATCH");
    expect(String(url)).toContain("revision=eq.1");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      revision: 2,
      archived_at: expect.any(String),
    });
  });
  it("preserves the only recovery copy when a visit has not finished uploading", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      archiveCloudSession(setup(fetcher), session()),
    ).rejects.toThrow("recovery copy");
    await expect(
      archiveCloudSession(setup(fetcher), {
        ...session(),
        cloud: { revision: 1, pending: true },
      }),
    ).rejects.toThrow("recovery copy");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
