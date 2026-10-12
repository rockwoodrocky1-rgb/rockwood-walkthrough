import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  participantSchema,
  languageSchema,
  type Participant,
} from "../shared/participant";
import {
  photoMetaSchema,
  transcriptSchema,
  reportContentSchema,
  type Project,
  type Session,
} from "../shared/model";

export type WorkspaceAccess = {
  client: SupabaseClient;
  workspaceId: string;
  workspaceName: string;
  userId: string;
  email: string;
  role: "owner" | "editor" | "viewer" | "contributor";
  participant?: Participant;
  projects: Project[];
  signOut: () => Promise<void>;
};
const fileSchema = z.object({
  path: z.string().min(1),
  type: z.string(),
  size: z.number().nonnegative(),
});
const payloadSchema = z.object({
  participant: participantSchema.optional(),
  language: languageSchema.optional(),
  duration: z.number().nonnegative(),
  status: z.enum(["saved", "interrupted"]),
  notes: z.string().max(8000),
  mime: z.string(),
  error: z.string().optional(),
  lowAudio: z.boolean().optional(),
  transcript: transcriptSchema.optional(),
  report: reportContentSchema
    .extend({
      id: z.string(),
      projectId: z.string(),
      sessionId: z.string(),
      generatedAt: z.string(),
      mode: z.enum(["live", "manual", "sample"]),
      reviewStatus: z.enum(["draft", "reviewed"]),
      outputLanguage: z.literal("en").optional(),
    })
    .optional(),
  audio: fileSchema.optional(),
  photos: z
    .array(photoMetaSchema.extend({ original: fileSchema, model: fileSchema }))
    .max(12),
});
export const cloudRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  workspace_id: z.string(),
  created_by: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  revision: z.number().int().positive(),
  archived_at: z.string().nullable(),
  payload: payloadSchema,
});
export type CloudRow = z.infer<typeof cloudRowSchema>;
type StoredFile = z.infer<typeof fileSchema>;
const bucket = "walkthrough-media";
export const SAVE_RETRY_MESSAGE =
  "Upload did not finish. A recovery copy is kept in this browser. Keep this page open, check your connection, and tap Retry upload.";
export const CONFLICT_MESSAGE =
  "Someone changed this walkthrough on another device. Your edits are preserved in this browser. Reopen the latest shared visit before applying your changes.";

export function rowToSession(row: CloudRow): Session {
  const { photos, audio: _audio, ...payload } = row.payload;
  void _audio;
  return {
    ...payload,
    id: row.id,
    projectId: row.project_id,
    startedAt: row.started_at,
    photos: photos.map(({ original, model, ...meta }) => ({
      ...meta,
      blob: new Blob([], { type: original.type }),
      modelBlob: new Blob([], { type: model.type }),
    })),
    cloud: {
      revision: row.revision,
      savedAt: row.updated_at,
      createdBy: row.created_by,
      pending: false,
      mediaLoaded: false,
      archived: !!row.archived_at,
    },
  };
}
export function mergeSessions(local: Session[], remote: Session[]): Session[] {
  const items = new Map(remote.map((s) => [s.id, s]));
  for (const session of local) {
    const shared = items.get(session.id);
    if (
      !shared ||
      session.cloud?.pending ||
      session.status === "recording" ||
      (session.cloud?.revision ?? 0) >= (shared.cloud?.revision ?? 0)
    )
      items.set(session.id, session);
  }
  return [...items.values()]
    .filter((s) => !s.cloud?.archived)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export function canEditSession(access: WorkspaceAccess, session: Session) {
  return (
    access.role === "owner" ||
    (["editor", "contributor"].includes(access.role) &&
      (!session.cloud?.createdBy || session.cloud.createdBy === access.userId))
  );
}
export async function listCloudSessions(
  access: WorkspaceAccess,
): Promise<Session[]> {
  const { data, error } = await access.client
    .from("walkthroughs")
    .select("*")
    .eq("workspace_id", access.workspaceId)
    .order("started_at", { ascending: false })
    .limit(100);
  if (error)
    throw new Error(
      "Could not load Rockwood’s shared visits. Check your connection and refresh.",
    );
  return (data ?? []).map((row) => rowToSession(cloudRowSchema.parse(row)));
}
function checkPath(access: WorkspaceAccess, path: string) {
  if (!path.startsWith(`${access.workspaceId}/`) || path.includes(".."))
    throw new Error("This media does not belong to the selected workspace.");
}
export async function loadCloudSession(
  access: WorkspaceAccess,
  id: string,
): Promise<Session> {
  const { data, error } = await access.client
    .from("walkthroughs")
    .select("*")
    .eq("workspace_id", access.workspaceId)
    .eq("id", id)
    .is("archived_at", null)
    .single();
  if (error || !data)
    throw new Error(
      "This visit could not be opened. It may have been archived or your access changed.",
    );
  const row = cloudRowSchema.parse(data);
  async function download(file: StoredFile) {
    checkPath(access, file.path);
    const result = await access.client.storage.from(bucket).download(file.path);
    if (result.error || !result.data)
      throw new Error(
        "Could not load this visit’s media. Check your connection and reopen it.",
      );
    return new Blob([result.data], { type: file.type });
  }
  const session = rowToSession(row);
  session.photos = await Promise.all(
    row.payload.photos.map(async ({ original, model, ...meta }) => ({
      ...meta,
      blob: await download(original),
      modelBlob: await download(model),
    })),
  );
  session.audio = row.payload.audio
    ? await download(row.payload.audio)
    : undefined;
  session.cloud!.mediaLoaded = true;
  return session;
}
async function uploadBlob(
  access: WorkspaceAccess,
  sessionId: string,
  blob: Blob,
): Promise<StoredFile> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const path = `${access.workspaceId}/${access.userId}/${encodeURIComponent(sessionId)}/${hash}`;
  const type = blob.type.split(";")[0] || "application/octet-stream";
  const { error } = await access.client.storage
    .from(bucket)
    .upload(path, blob, { contentType: type, upsert: false });
  // Identical content is immutable and may already exist after an interrupted save.
  if (error && String((error as { statusCode?: string }).statusCode) !== "409")
    throw new Error(SAVE_RETRY_MESSAGE);
  return { path, type: blob.type, size: blob.size };
}
export async function saveCloudSession(
  access: WorkspaceAccess,
  session: Session,
): Promise<Session> {
  if (!canEditSession(access, session))
    throw new Error(
      "You can view this visit, but do not have permission to edit it.",
    );
  if (session.status === "recording" || session.cloud?.mediaLoaded === false)
    throw new Error(
      "Finish recording and load the visit’s media before saving.",
    );
  const photos = [];
  // Small, sequential uploads avoid flooding a mobile connection. Content hashes
  // make retry safe; metadata becomes visible only after every upload succeeds.
  for (const photo of session.photos) {
    photos.push({
      ...photoMetaSchema.parse(photo),
      original: await uploadBlob(access, session.id, photo.blob),
      model: await uploadBlob(access, session.id, photo.modelBlob),
    });
  }
  const audio = session.audio?.size
    ? await uploadBlob(access, session.id, session.audio)
    : undefined;
  const payload = payloadSchema.parse({
    participant: session.participant,
    language: session.language,
    duration: session.duration,
    status: session.status,
    notes: session.notes,
    mime: session.mime,
    error: session.error,
    lowAudio: session.lowAudio,
    transcript: session.transcript,
    report: session.report,
    photos,
    audio,
  });
  const revision = session.cloud?.revision ?? 0;
  const table = access.client.from("walkthroughs");
  const result = revision
    ? await table
        .update({ payload, revision: revision + 1 })
        .eq("workspace_id", access.workspaceId)
        .eq("id", session.id)
        .eq("revision", revision)
        .is("archived_at", null)
        .select("*")
        .maybeSingle()
    : await table
        .insert({
          workspace_id: access.workspaceId,
          id: session.id,
          project_id: session.projectId,
          started_at: session.startedAt,
          payload,
        })
        .select("*")
        .single();
  if (result.error?.code === "23505" || (!result.error && !result.data))
    throw new Error(CONFLICT_MESSAGE);
  if (result.error) throw new Error(SAVE_RETRY_MESSAGE);
  const row = cloudRowSchema.parse(result.data);
  return {
    ...session,
    cloud: {
      revision: row.revision,
      savedAt: row.updated_at,
      createdBy: row.created_by,
      pending: false,
      mediaLoaded: true,
    },
  };
}
export async function archiveCloudSession(
  access: WorkspaceAccess,
  session: Session,
) {
  if (!session.cloud?.revision || session.cloud.pending)
    throw new Error(
      "Finish uploading this visit before archiving it. Its recovery copy is still needed.",
    );
  const { data, error } = await access.client
    .from("walkthroughs")
    .update({
      archived_at: new Date().toISOString(),
      revision: session.cloud.revision + 1,
    })
    .eq("workspace_id", access.workspaceId)
    .eq("id", session.id)
    .eq("revision", session.cloud.revision)
    .select("id")
    .maybeSingle();
  if (error)
    throw new Error(
      "Could not archive this walkthrough. Check your connection and permissions.",
    );
  if (!data) throw new Error(CONFLICT_MESSAGE);
}
