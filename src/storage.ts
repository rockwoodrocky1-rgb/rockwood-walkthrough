import { createStore, get, set, values, del, keys, clear } from "idb-keyval";
import type { Session } from "../shared/model";
let sessions = createStore("rockwood-walkthrough-v1", "sessions");
let chunks = createStore("rockwood-audio-v1", "chunks");
// Recovery copies are isolated by account; logging into another account never
// imports the previous user's recordings or the original anonymous prototype.
export function configureStorage(scope?: string) {
  const suffix = scope ? `-${scope.replace(/[^a-zA-Z0-9-]/g, "")}` : "";
  sessions = createStore(`rockwood-walkthrough-v1${suffix}`, "sessions");
  chunks = createStore(`rockwood-audio-v1${suffix}`, "chunks");
}
export const saveSession = (session: Session) =>
  set(session.id, session, sessions);
export const loadSession = (id: string) => get<Session>(id, sessions);
export const listSessions = async () =>
  (await values<Session>(sessions)).sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
export const saveChunk = (sessionId: string, sequence: number, blob: Blob) =>
  set(`${sessionId}:${sequence.toString().padStart(6, "0")}`, blob, chunks);
export async function recoverSession(session: Session): Promise<Session> {
  if (session.status !== "recording") return session;
  const ids = (await keys<string>(chunks))
    .filter((k) => k.startsWith(`${session.id}:`))
    .sort();
  const blobs = await Promise.all(ids.map((id) => get<Blob>(id, chunks)));
  const recovered = {
    ...session,
    status: "interrupted" as const,
    audio: new Blob(
      blobs.filter((b): b is Blob => !!b),
      { type: session.mime },
    ),
    error:
      "Recording was interrupted. Photos and available audio were recovered. Listen before processing; unfinished audio may not be playable.",
  };
  await saveSession(recovered);
  return recovered;
}
export async function clearChunks(id: string) {
  const ids = (await keys<string>(chunks)).filter((k) =>
    k.startsWith(`${id}:`),
  );
  await Promise.all(ids.map((key) => del(key, chunks)));
}
export async function resetData() {
  await clear(sessions);
  await clear(chunks);
}
export async function deleteSession(id: string) {
  await del(id, sessions);
  await clearChunks(id);
}
