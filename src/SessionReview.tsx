"use client";
import { createId } from "./id";
import { useEffect, useState } from "react";
import { FileText, Download, Mic, RotateCw, ImagePlus } from "lucide-react";
import {
  LIMITS,
  GENERAL,
  audioExtension,
  formatTime,
  type Project,
  type Session,
  type Report,
} from "../shared/model";
import { importPhoto, downloadBlob } from "./media";
import { explainSavedProcessingError } from "./api";
import { Back, Notice, PhotoStrip, PhotoDialog, useBlobUrl } from "./ui";
export default function SessionReview({
  session,
  project,
  stage,
  liveAiEnabled,
  cloudEnabled = false,
  readOnly = false,
  update: onUpdate,
  process,
  manual,
  back,
  sample,
}: {
  session: Session;
  project: Project;
  stage: string;
  liveAiEnabled: boolean;
  cloudEnabled?: boolean;
  readOnly?: boolean;
  update: (s: Session) => Promise<void>;
  process: (s: Session) => void;
  manual: (s: Session) => void;
  back: () => void;
  sample: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [area, setArea] = useState(GENERAL);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [notes, setNotes] = useState(session.notes);
  const [transcriptDraft, setTranscript] = useState<string | null>(null);
  const transcript = transcriptDraft ?? session.transcript?.text ?? "";
  const audio = useBlobUrl(session.audio);
  const dirty =
    notes !== session.notes ||
    (transcriptDraft !== null &&
      transcriptDraft !== (session.transcript?.text ?? ""));
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const busy = !!stage || working || readOnly;
  const active = session.photos.find((p) => p.id === selected);
  async function update(next: Session) {
    if (next.report) {
      const photos = new Set(next.photos.map((p) => p.id));
      const segments = new Set(
        next.transcript?.segments.map((s) => s.id) ?? [],
      );
      const notesChanged = next.notes !== session.notes;
      const transcriptChanged =
        next.transcript?.text !== session.transcript?.text;
      const noteIds = new Set([
        ...(next.notes.trim() ? ["session-note"] : []),
        ...next.photos.filter((p) => p.note.trim()).map((p) => p.id),
      ]);
      next = {
        ...next,
        report: {
          ...next.report,
          reviewStatus: "draft",
          observations: next.report.observations.map((o) => ({
            ...o,
            photoIds: o.photoIds.filter((id) => photos.has(id)),
            transcriptSegmentIds: transcriptChanged
              ? []
              : o.transcriptSegmentIds.filter((id) => segments.has(id)),
            noteIds: notesChanged
              ? []
              : o.noteIds.filter((id) => noteIds.has(id)),
            needsVerification: true,
          })),
          actionItems: next.report.actionItems.map((a) => ({
            ...a,
            photoIds: a.photoIds.filter((id) => photos.has(id)),
            transcriptSegmentIds: transcriptChanged
              ? []
              : a.transcriptSegmentIds.filter((id) => segments.has(id)),
            noteIds: notesChanged
              ? []
              : a.noteIds.filter((id) => noteIds.has(id)),
            needsConfirmation: true,
          })),
          captions: next.report.captions.filter((c) => photos.has(c.photoId)),
        },
      };
    }
    await onUpdate(next);
    return next;
  }
  async function persistText() {
    const changed = transcript !== (session.transcript?.text ?? "");
    const next = {
      ...session,
      notes,
      transcript: changed
        ? {
            text: transcript,
            source: "manual" as const,
            segments: transcript.trim()
              ? [
                  {
                    id: "manual-segment",
                    text: transcript,
                    start: null,
                    end: null,
                  },
                ]
              : [],
          }
        : session.transcript,
    };
    const saved = await update(next);
    setTranscript(null);
    return saved;
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    setWorking(true);
    setMessage("");
    let next = session;
    try {
      for (const file of Array.from(files)) {
        if (next.photos.length >= LIMITS.photos)
          throw new Error(
            "Twelve-photo limit reached. Earlier selected photos were saved.",
          );
        const photo = await importPhoto(file, {
          id: createId(),
          projectId: session.projectId,
          sessionId: session.id,
          capturedAt: new Date().toISOString(),
          elapsed: null,
          area,
          note: "",
          origin: "upload",
        });
        next = { ...next, photos: [...next.photos, photo] };
        await update(next);
      }
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function run(action: (s: Session) => void) {
    try {
      const next = await persistText();
      action(next);
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <main className="page narrow">
      <Back
        onClick={() => {
          if (
            !dirty ||
            window.confirm(
              "Leave without saving your notes and transcript edits?",
            )
          )
            back();
        }}
      >
        Back to project
      </Back>
      <div className="page-heading">
        <p className="eyebrow">YOUR FIELD NOTES</p>
        <h1>{stage || "Walkthrough captured."}</h1>
        <p>
          {project.name} <span className="dot-separator">·</span>{" "}
          {formatTime(session.duration)} audio{" "}
          <span className="dot-separator">·</span> {session.photos.length}{" "}
          photos
        </p>
      </div>
      {!cloudEnabled && (
        <Notice>
          <strong>Storage: this browser only</strong>
          <p>
            Reopen this visit under {project.name} → Walkthroughs &amp; reports
            using this same link and browser. It is not uploaded to a shared
            account or saved to your Photos app. Clearing browser data removes
            it.
          </p>
        </Notice>
      )}
      {readOnly && (
        <Notice>
          You can view this visit. Only its author or a workspace owner can make
          changes.
        </Notice>
      )}
      {stage && (
        <div className="processing">
          <span className="spinner" />
          <div>
            <strong>{stage}</strong>
            <p>
              Keep this page open. Your captured work stays available if
              processing fails.
            </p>
          </div>
        </div>
      )}
      {session.error && (
        <Notice tone="warning">
          {explainSavedProcessingError(session.error)}
        </Notice>
      )}
      {session.lowAudio && (
        <Notice tone="warning">
          Very little microphone signal was detected. Listen to the recording
          before processing, or add a typed transcript below.
        </Notice>
      )}
      {message && <Notice tone="warning">{message}</Notice>}
      <div className="review-grid">
        <section className="panel">
          <div className="section-rule">
            <h2>Recording & notes</h2>
            <Mic size={18} />
          </div>
          {audio ? (
            <>
              <audio
                controls
                src={audio}
                preload="metadata"
                aria-label="Original walkthrough recording"
              />
              <button
                className="text-button"
                onClick={() =>
                  downloadBlob(
                    session.audio!,
                    `walkthrough-${session.id}.${audioExtension(session.mime) || "bin"}`,
                  )
                }
              >
                <Download size={15} />
                Download original audio
              </button>
            </>
          ) : (
            <p className="muted">
              No audio recording. You can document this visit with uploaded
              photos and typed notes.
            </p>
          )}
          <label>
            Walkthrough notes
            <textarea
              rows={5}
              value={notes}
              maxLength={8000}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Record observations, completed work, and follow-up questions."
              disabled={busy}
            />
          </label>
          <details className="transcript-details">
            <summary>
              Transcript{" "}
              {session.transcript?.source === "audio"
                ? "· from audio"
                : "· optional manual entry"}
            </summary>
            <p className="muted small">
              Editing creates a manually supplied transcript. Timing stays
              unconfirmed; photos are not matched automatically.
            </p>
            <textarea
              aria-label="Manual transcript"
              rows={7}
              value={transcript}
              maxLength={50_000}
              onChange={(e) => setTranscript(e.target.value)}
              disabled={busy}
            />
          </details>
          <button
            className="button"
            onClick={() =>
              void persistText()
                .then(() =>
                  setMessage(
                    cloudEnabled
                      ? "Notes and transcript saved to Rockwood."
                      : "Notes and transcript saved in this browser. Reopen them from this project’s Walkthroughs & reports.",
                  ),
                )
                .catch((e) => setMessage(e.message))
            }
            disabled={busy}
          >
            Save notes & transcript
          </button>
        </section>
        <section className="panel">
          <div className="section-rule">
            <h2>Visit photos</h2>
            <span>
              {session.photos.length}/{LIMITS.photos}
            </span>
          </div>
          <PhotoStrip photos={session.photos} onSelect={setSelected} />
          <label>
            Area for uploads
            <select
              value={area}
              onChange={(e) => setArea(e.target.value)}
              disabled={busy}
            >
              <option>{GENERAL}</option>
              {project.areas.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <label className={`upload-zone ${busy ? "disabled" : ""}`}>
            <ImagePlus size={25} />
            <strong>{working ? "Preparing photos…" : "Add site photos"}</strong>
            <span>JPEG, PNG or WebP · up to 12 photos</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={busy || session.photos.length >= LIMITS.photos}
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <p className="muted small">
            Uploads are marked as untimed. HEIC is not supported. Keep original
            files outside this prototype if needed.
          </p>
        </section>
      </div>
      <section className="report-choice">
        <h2>Turn the visit into a clear next step.</h2>
        <p>
          {liveAiEnabled
            ? "AI reporting sends your audio, notes and selected photos to OpenAI. Review the draft before sharing."
            : "Automatic AI reports are not enabled for this test. Create a manual report with your photos and notes, or explore the sample below."}
        </p>
        <div className="button-row">
          <button
            className={`button ${liveAiEnabled ? "primary" : ""}`}
            onClick={() => void run(process)}
            disabled={busy}
          >
            <RotateCw size={17} />
            {session.transcript
              ? "Prepare report / Retry"
              : liveAiEnabled
                ? "Transcribe & prepare report"
                : "Check AI availability"}
          </button>
          <button
            className={`button ${liveAiEnabled ? "" : "primary"}`}
            onClick={() => void run(manual)}
            disabled={busy}
          >
            <FileText size={17} />
            Create manual report
          </button>
        </div>
        <button
          className="text-button sample-link"
          onClick={sample}
          disabled={busy}
        >
          View sample report — not based on this recording{" "}
          <span aria-hidden>›</span>
        </button>
      </section>
      {active && (
        <PhotoDialog
          key={active.id}
          photo={active}
          project={project}
          close={() => setSelected(undefined)}
          save={(p) =>
            void update({
              ...session,
              photos: session.photos.map((x) => (x.id === p.id ? p : x)),
            }).catch((e) => setMessage(e.message))
          }
          remove={() =>
            void update({
              ...session,
              photos: session.photos.filter((x) => x.id !== active.id),
            }).catch((e) => setMessage(e.message))
          }
        />
      )}
    </main>
  );
}
export function makeManualReport(session: Session): Report {
  return {
    id: createId(),
    projectId: session.projectId,
    sessionId: session.id,
    generatedAt: new Date().toISOString(),
    mode: "manual",
    reviewStatus: "draft",
    summary:
      session.notes.trim() ||
      "Add a visit summary. This report has not been analyzed by AI.",
    observations: [],
    actionItems: [],
    captions: session.photos.map((p) => ({
      photoId: p.id,
      caption: p.note || `Photo from ${p.area}. Add a descriptive caption.`,
    })),
  };
}
