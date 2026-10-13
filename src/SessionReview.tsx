"use client";
import { useLanguage } from "./i18n";
import { createId } from "./id";
import { useEffect, useState } from "react";
import { FileText, Download, Mic, RotateCw, ImagePlus, Save } from "lucide-react";
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
  const { t, language } = useLanguage();
  const [selected, setSelected] = useState<string>();
  const [area, setArea] = useState(GENERAL);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState<"photos" | "notes" | "report" | null>(
    null,
  );
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
  const busy = !!stage || working !== null || readOnly;
  const active = session.photos.find((p) => p.id === selected);
  async function update(next: Session) {
    if (readOnly) throw new Error("This visit is view only.");
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
      language:
        session.language === "es" || language === "es"
          ? ("es" as const)
          : ("en" as const),
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
    if (!files || busy) return;
    setWorking("photos");
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
      setWorking(null);
    }
  }
  async function run(action: (s: Session) => void) {
    if (busy) return;
    setWorking("report");
    setMessage("");
    try {
      const next = await persistText();
      action(next);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setWorking(null);
    }
  }
  async function saveText() {
    if (busy) return;
    setWorking("notes");
    setMessage("");
    try {
      await persistText();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setWorking(null);
    }
  }
  return (
    <main className="page narrow field-review">
      <Back
        onClick={() => {
          if (
            !dirty ||
            window.confirm(
              t("Leave without saving your notes and transcript edits?"),
            )
          )
            back();
        }}
      >
        {t("Project")}
      </Back>
      <div className="page-heading">
        <h1>{t("Review visit")}</h1>
        <p>
          {project.name} <span className="dot-separator">·</span>{" "}
          {session.photos.length} {t(session.photos.length === 1 ? "photo" : "photos")}
        </p>
      </div>
      {!cloudEnabled && (
        <Notice>
          {t(
            "Saved in this browser only. Clearing browser data deletes this visit.",
          )}
        </Notice>
      )}
      {readOnly && (
        <Notice>
          {t("View only. The author or owner can edit this visit.")}
        </Notice>
      )}
      {stage && (
        <div className="processing">
          <span className="spinner" />
          <div>
            <strong>{t(stage)}</strong>
            <p>
              {t("Keep this page open. Your photos and notes are saved.")}
            </p>
          </div>
        </div>
      )}
      {session.error && (
        <Notice tone="warning">
          {t(explainSavedProcessingError(session.error))}
        </Notice>
      )}
      {session.lowAudio && (
        <Notice tone="warning">
          {t("Audio is quiet. Check the recording or add notes.")}
        </Notice>
      )}
      {message && <Notice tone="warning">{t(message)}</Notice>}
      <div className="review-grid">
        <section className="panel review-photos">
          <div className="section-rule">
            <h2>{t("Photos")}</h2>
            <span>
              {session.photos.length}/{LIMITS.photos}
            </span>
          </div>
          <PhotoStrip photos={session.photos} onSelect={setSelected} />
          {!readOnly && (
            <>
              <label>
                {t("Area")}
                <select
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  disabled={busy}
                >
                  <option value={GENERAL}>{t(GENERAL)}</option>
                  {project.areas.map((a) => (
                    <option key={a} value={a}>
                      {t(a)}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className={`upload-zone ${busy || session.photos.length >= LIMITS.photos ? "disabled" : ""}`}
              >
                <ImagePlus size={28} aria-hidden />
                <strong>
                  {working === "photos" ? t("Adding photos…") : t("Add photos")}
                </strong>
                <input
                  type="file"
                  aria-label={t("Add photos")}
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  disabled={busy || session.photos.length >= LIMITS.photos}
                  onChange={(e) => {
                    void upload(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
              {session.photos.length >= LIMITS.photos && (
                <p className="photo-limit">{t("Photo limit reached.")}</p>
              )}
            </>
          )}
        </section>
        <section className="panel review-notes">
          <div className="section-rule">
            <h2>{t("Notes")}</h2>
            <FileText size={22} aria-hidden />
          </div>
          <label>
            <span className="sr-only">{t("Walkthrough notes")}</span>
            <textarea
              rows={5}
              value={notes}
              maxLength={8000}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("What needs attention?")}
              readOnly={readOnly}
              disabled={!readOnly && busy}
            />
          </label>
          {(audio || transcript || !readOnly) && (
            <details
              className="recording-details"
              open={session.lowAudio || undefined}
            >
              <summary>
                <Mic size={22} aria-hidden /> {t("Recording & transcript")}
              </summary>
              {audio && (
                <>
                  <audio
                    controls
                    src={audio}
                    preload="metadata"
                    aria-label={t("Original walkthrough recording")}
                  />
                  <button
                    className="button"
                    onClick={() =>
                      downloadBlob(
                        session.audio!,
                        `walkthrough-${session.id}.${audioExtension(session.mime) || "bin"}`,
                      )
                    }
                  >
                    <Download size={22} aria-hidden />
                    {t("Download audio")} · {formatTime(session.duration)}
                  </button>
                </>
              )}
              <label>
                {t("Transcript")}
                <textarea
                  aria-label={t("Manual transcript")}
                  rows={5}
                  value={transcript}
                  maxLength={50_000}
                  onChange={(e) => setTranscript(e.target.value)}
                  readOnly={readOnly}
                  disabled={!readOnly && busy}
                  placeholder={t("Add spoken notes here.")}
                />
              </label>
            </details>
          )}
          {!readOnly && (
            <button
              className="button save-notes"
              onClick={() => void saveText()}
              disabled={busy || !dirty}
            >
              <Save size={22} aria-hidden />
              {working === "notes"
                ? t("Saving…")
                : dirty
                  ? t("Save notes")
                  : t("Notes saved")}
            </button>
          )}
        </section>
      </div>
      {!readOnly && (
        <section className="report-choice review-actions">
          {liveAiEnabled && (
            <p>
              {t("AI sends this visit to OpenAI. Review the report before sharing.")}
            </p>
          )}
          <button
            className="button primary report-next"
            onClick={() => void run(liveAiEnabled ? process : manual)}
            disabled={busy}
          >
            <FileText size={24} aria-hidden />
            {working === "report" || stage
              ? t("Preparing…")
              : t("Create report")}
          </button>
          <details className="review-options">
            <summary>{t("More options")}</summary>
            {!liveAiEnabled && (
              <p>{t("Automatic reports are not connected yet.")}</p>
            )}
            <div className="button-row">
              <button
                className="button"
                onClick={() => void run(liveAiEnabled ? manual : process)}
                disabled={busy}
              >
                {liveAiEnabled ? (
                  <FileText size={22} aria-hidden />
                ) : (
                  <RotateCw size={22} aria-hidden />
                )}
                {liveAiEnabled ? t("Write report") : t("Check AI availability")}
              </button>
              <button
                className="button"
                onClick={() => void run(() => sample())}
                disabled={busy}
              >
                {t("Sample report")}
              </button>
            </div>
          </details>
        </section>
      )}
      {active && (
        <PhotoDialog
          key={active.id}
          photo={active}
          project={project}
          readOnly={busy}
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
    outputLanguage: session.language === "es" ? undefined : "en",
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
