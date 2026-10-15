import { z } from "zod";
import type { Language, Participant } from "./participant";

export const LIMITS = {
  seconds: 300,
  photos: 12,
  requestBytes: 3_000_000,
  imageTargetBytes: 150_000,
  imageEdge: 1280,
  audioBitsPerSecond: 64_000,
  uploadBytes: 15_000_000,
} as const;
export const GENERAL = "General / area unconfirmed";
export const projects = [
  {
    id: "coral-gables",
    name: "Coral Gables Residence",
    type: "Residential renovation",
    stage: "Finishing stage",
    areas: ["Kitchen", "Primary Bathroom", "Living Room", "Exterior"],
    image: "/images/residence.webp",
    number: "01",
  },
  {
    id: "doral-office",
    name: "Doral Office Buildout",
    type: "Commercial interiors",
    stage: "Active construction",
    areas: ["Reception", "Conference Room", "Open Office", "Restrooms"],
    image: "/images/office.webp",
    number: "02",
  },
  {
    id: "pinecrest",
    name: "Pinecrest Custom Home",
    type: "New construction",
    stage: "Framing / rough-in",
    areas: ["First Floor", "Second Floor", "Garage", "Exterior"],
    image: "/images/house.webp",
    number: "03",
  },
];
export type Project = (typeof projects)[number];
const id = z.string().min(1).max(100);
const ids = z.array(id).max(100);
const short = z.string().max(300);
const text = z.string().max(4000);
export const segmentSchema = z.object({
  id,
  start: z.number().nonnegative().nullable(),
  end: z.number().nonnegative().nullable(),
  text: text.min(1),
});
export const transcriptSchema = z.object({
  text: z.string().max(50_000),
  segments: z.array(segmentSchema).max(500),
  source: z.enum(["audio", "manual", "sample"]),
});
export type Transcript = z.infer<typeof transcriptSchema>;
export const photoMetaSchema = z.object({
  id,
  projectId: id,
  sessionId: id,
  area: short,
  capturedAt: z.iso.datetime(),
  elapsed: z
    .number()
    .nonnegative()
    .max(LIMITS.seconds + 5)
    .nullable(),
  note: text,
  origin: z.enum(["camera", "upload", "sample"]),
});
export type Photo = z.infer<typeof photoMetaSchema> & {
  blob: Blob;
  modelBlob: Blob;
};
export const observationSchema = z.object({
  id,
  area: short,
  description: text.min(1),
  basis: z.enum(["narration", "photo", "user_note", "mixed"]),
  state: z.enum([
    "reported_complete",
    "outstanding",
    "requested_review",
    "information",
  ]),
  photoIds: ids,
  transcriptSegmentIds: ids,
  noteIds: ids,
  needsVerification: z.boolean(),
});
export const actionSchema = z.object({
  id,
  area: short,
  task: text.min(1),
  category: z.enum(["outstanding", "next_step", "question"]),
  observationIds: ids,
  photoIds: ids,
  transcriptSegmentIds: ids,
  noteIds: ids,
  priority: z.enum(["high", "normal", "low", "unassigned"]),
  suggestedTrade: short.nullable(),
  assignee: short.nullable(),
  dueDateText: short.nullable(),
  status: z.enum(["open", "done"]),
  needsConfirmation: z.boolean(),
});
export const reportContentSchema = z.object({
  summary: text.min(1),
  observations: z.array(observationSchema).max(80),
  actionItems: z.array(actionSchema).max(80),
  captions: z
    .array(z.object({ photoId: id, caption: short }))
    .max(LIMITS.photos),
});
export type Observation = z.infer<typeof observationSchema>;
export type ActionItem = z.infer<typeof actionSchema>;
export type ReportContent = z.infer<typeof reportContentSchema>;
export type Report = ReportContent & {
  id: string;
  projectId: string;
  sessionId: string;
  generatedAt: string;
  mode: "live" | "sample" | "manual";
  reviewStatus: "draft" | "reviewed";
  outputLanguage?: "en";
};
export type Session = {
  participant?: Participant;
  language?: Language;
  recordingLanguage?: Language;
  id: string;
  projectId: string;
  startedAt: string;
  duration: number;
  status: "recording" | "saved" | "interrupted";
  photos: Photo[];
  notes: string;
  audio?: Blob;
  mime: string;
  transcript?: Transcript;
  report?: Report;
  error?: string;
  lowAudio?: boolean;
  cloud?: {
    revision: number;
    savedAt?: string;
    createdBy?: string;
    pending: boolean;
    error?: string;
    mediaLoaded?: boolean;
    archived?: boolean;
  };
};
export const reportInputSchema = z.object({
  language: z.enum(["en", "es"]).default("en"),
  sessionId: id,
  // Legacy fixtures and canonical workspace property UUIDs share the worker.
  projectId: z.union([z.uuid(), z.enum(["coral-gables", "doral-office", "pinecrest"])]),
  notes: z.string().max(8000),
  transcript: transcriptSchema,
  photos: z
    .array(
      photoMetaSchema.extend({
        dataUrl: z
          .string()
          .max(230_000)
          .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/),
      }),
    )
    .max(LIMITS.photos),
});
export type ReportInput = z.input<typeof reportInputSchema>;

export function validateEvidence(
  report: ReportContent,
  input: Pick<
    ReportInput,
    "sessionId" | "projectId" | "photos" | "transcript" | "notes"
  >,
): ReportContent {
  reportContentSchema.parse(report);
  const photoIds = new Set(input.photos.map((p) => p.id));
  const segmentIds = new Set(input.transcript.segments.map((s) => s.id));
  const noteIds = new Set([
    ...(input.notes.trim() ? ["session-note"] : []),
    ...input.photos.filter((p) => p.note.trim()).map((p) => p.id),
  ]);
  const obsIds = new Set(report.observations.map((o) => o.id));
  const unique = (values: string[]) => {
    if (new Set(values).size !== values.length)
      throw new Error("Duplicate evidence IDs.");
  };
  unique(input.photos.map((p) => p.id));
  unique(input.transcript.segments.map((s) => s.id));
  unique(report.observations.map((o) => o.id));
  unique(report.actionItems.map((a) => a.id));
  unique(report.captions.map((c) => c.photoId));
  if (
    input.photos.some(
      (p) => p.projectId !== input.projectId || p.sessionId !== input.sessionId,
    )
  )
    throw new Error("Photos do not belong to this walkthrough.");
  const check = (refs: string[], allowed: Set<string>) => {
    if (refs.some((ref) => !allowed.has(ref)))
      throw new Error("Report contains an unknown evidence reference.");
  };
  for (const item of [...report.observations, ...report.actionItems]) {
    check(item.photoIds, photoIds);
    check(item.transcriptSegmentIds, segmentIds);
    check(item.noteIds, noteIds);
  }
  for (const item of report.actionItems) check(item.observationIds, obsIds);
  check(
    report.captions.map((c) => c.photoId),
    photoIds,
  );
  for (const o of report.observations) {
    if (o.basis === "narration" && !o.transcriptSegmentIds.length)
      throw new Error("Narration evidence is missing.");
    if (o.basis === "photo" && !o.photoIds.length)
      throw new Error("Photo evidence is missing.");
    if (o.basis === "user_note" && !o.noteIds.length)
      throw new Error("User note evidence is missing.");
    if (
      o.basis === "mixed" &&
      [
        o.photoIds.length > 0,
        o.transcriptSegmentIds.length > 0,
        o.noteIds.length > 0,
      ].filter(Boolean).length < 2
    )
      throw new Error("Mixed evidence needs multiple sources.");
    if (
      o.state === "reported_complete" &&
      !o.transcriptSegmentIds.length &&
      !o.noteIds.length
    )
      throw new Error(
        "Completion must be reported, not inferred from an image.",
      );
  }
  return report;
}
export function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}
export function audioExtension(mime: string) {
  const base = mime.split(";")[0];
  return (
    (
      {
        "audio/webm": "webm",
        "audio/mp4": "m4a",
        "audio/ogg": "ogg",
        "audio/wav": "wav",
        "audio/mpeg": "mp3",
      } as Record<string, string>
    )[base] ?? null
  );
}
export function chooseAudioMime(supported: (type: string) => boolean) {
  return (
    ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(supported) ??
    null
  );
}
export class RecordingClock {
  private accrued = 0;
  private activeSince: number | null = null;
  constructor(private now: () => number = () => performance.now()) {}
  resume() {
    if (this.activeSince === null) this.activeSince = this.now();
  }
  pause() {
    if (this.activeSince !== null) {
      this.accrued += this.now() - this.activeSince;
      this.activeSince = null;
    }
  }
  seconds() {
    return (
      (this.accrued +
        (this.activeSince === null ? 0 : this.now() - this.activeSince)) /
      1000
    );
  }
}
