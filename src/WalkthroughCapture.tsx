"use client";
import { useLanguage } from "./i18n";
import { useEffect, useRef, useState } from "react";
import {
  Mic,
  Pause,
  Play,
  Check,
  Camera,
  CameraOff,
  FileText,
} from "lucide-react";
import {
  type Project,
  type Session,
  GENERAL,
  LIMITS,
  formatTime,
} from "../shared/model";
import { WalkthroughRecorder, type CaptureState } from "./recorder";
import { Notice, PhotoStrip, PhotoDialog } from "./ui";
export default function WalkthroughCapture({
  project,
  initial,
  done,
  fallback,
}: {
  project: Project;
  initial: Session;
  done: (s: Session) => void;
  fallback: (s: Session) => void;
}) {
  const { t } = useLanguage();
  const video = useRef<HTMLVideoElement>(null);
  const engine = useRef<WalkthroughRecorder | null>(null);
  const callbacks = useRef({ done, fallback });
  useEffect(() => {
    callbacks.current = { done, fallback };
  }, [done, fallback]);
  const [session, setSession] = useState(initial);
  const [state, setState] = useState<CaptureState>("starting");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState("");
  const [area, setArea] = useState(GENERAL);
  const [selected, setSelected] = useState<string>();
  const [taking, setTaking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const recorder = new WalkthroughRecorder(
      initial,
      video.current!,
      (s, d, t, l, m) => {
        setState(s);
        setSession(d);
        setSeconds(t);
        setLevel(l);
        if (m !== undefined) setMessage(m);
      },
      (s) => callbacks.current.done(s),
    );
    engine.current = recorder;
    void recorder.start();
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      recorder.dispose();
      window.removeEventListener("beforeunload", unload);
    };
  }, [initial, attempt]);
  async function takePhoto() {
    if (taking) return;
    setTaking(true);
    try {
      await engine.current?.photo(area);
      setMessage("Photo added.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setTaking(false);
    }
  }
  function usePhotosAndNotes() {
    const recorder = engine.current;
    const current = recorder?.session ?? session;
    // Stop before navigation so a late camera permission response releases
    // its tracks without starting a recording after the visitor has left.
    recorder?.dispose();
    callbacks.current.fallback({
      ...current,
      status: "saved",
      error: undefined,
    });
  }
  const activePhoto = session.photos.find((p) => p.id === selected);
  return (
    <main className="capture-page">
      <div className="page-heading compact">
        <div>
          <h1>{project.name}</h1>
        </div>
        <span className="capture-limit">{t("5 min max")}</span>
      </div>
      <div className="capture-layout">
        <section className="capture-main">
          <div className="viewfinder">
            <video
              ref={video}
              muted
              autoPlay
              playsInline
              aria-label={t("Live camera preview")}
            />
            <div className="viewfinder-top">
              <span
                className={`recording-status ${state === "recording" ? "is-recording" : ""}`}
              >
                <Mic size={18} aria-hidden />
                {state === "recording"
                  ? t("Recording")
                  : state === "paused"
                    ? t("Paused")
                    : state === "starting"
                      ? t("Connecting…")
                      : state === "finishing"
                        ? t("Saving…")
                        : t("Unavailable")}
                <b>{formatTime(seconds)}</b>
              </span>
              <span className="viewfinder-note">
                <Camera size={18} aria-hidden />
                {session.photos.length}/{LIMITS.photos}
              </span>
            </div>
            {["starting", "error"].includes(state) && (
              <div className="camera-placeholder">
                {state === "error" ? (
                  <CameraOff size={38} />
                ) : (
                  <Camera size={38} />
                )}
                <h2>
                  {state === "starting"
                    ? t("Opening camera…")
                    : t("Camera unavailable")}
                </h2>
                <p>
                  {state === "starting"
                    ? t("Allow camera and microphone access.")
                    : t("Add photos and notes instead.")}
                </p>
              </div>
            )}
            <div className="viewfinder-bottom">
              <span>{t(area)}</span>
              <div
                className="audio-level"
                aria-label={t("Microphone level {level} percent", {
                  level: Math.round(level * 100),
                })}
              >
                {Array.from({ length: 9 }, (_, i) => (
                  <i
                    key={i}
                    style={{
                      opacity:
                        state === "recording" && level > i / 9 ? 1 : 0.22,
                      height: `${8 + (i % 3) * 5}px`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
          {message && (
            <Notice tone={state === "error" ? "warning" : "neutral"}>
              {t(message)}
            </Notice>
          )}
          {state === "error" || state === "starting" ? (
            <div className="button-row capture-fallback">
              {state === "error" && (
                <button
                  className="button primary"
                  onClick={() => setAttempt((a) => a + 1)}
                >
                  <Camera size={22} aria-hidden />
                  {t("Retry camera")}
                </button>
              )}
              <button
                className={`button ${state === "starting" ? "primary" : ""}`}
                onClick={usePhotosAndNotes}
              >
                <FileText size={22} aria-hidden />
                {t("Photos & notes")}
              </button>
            </div>
          ) : (
            <div className="capture-controls">
              <button
                className="capture-secondary"
                disabled={state === "finishing" || taking}
                onClick={() =>
                  state === "paused"
                    ? engine.current?.resume()
                    : engine.current?.pause()
                }
              >
                {state === "paused" ? (
                  <Play size={26} aria-hidden />
                ) : (
                  <Pause size={26} aria-hidden />
                )}
                <span>{state === "paused" ? t("Resume") : t("Pause")}</span>
              </button>
              <button
                className={`shutter ${taking ? "flash" : ""}`}
                aria-label={t("Take photo")}
                disabled={
                  state !== "recording" ||
                  taking ||
                  session.photos.length >= LIMITS.photos
                }
                onClick={takePhoto}
              >
                <span>
                  <Camera size={30} aria-hidden />
                  <strong className="shutter-label">
                    {taking ? t("Taking…") : t("Take photo")}
                  </strong>
                </span>
              </button>
              <button
                className="capture-done"
                disabled={state === "finishing" || taking}
                onClick={() => engine.current?.finish()}
              >
                <Check size={26} aria-hidden />
                <span>{state === "finishing" ? t("Saving…") : t("Done")}</span>
              </button>
            </div>
          )}
        </section>
        <aside className="capture-sidebar">
          <label className="area-label">
            {t("Area")}
            <select value={area} onChange={(e) => setArea(e.target.value)}>
              <option value={GENERAL}>{t(GENERAL)}</option>
              {project.areas.map((a) => (
                <option key={a} value={a}>
                  {t(a)}
                </option>
              ))}
            </select>
          </label>
          <div className="section-rule">
            <h2>{t("Photos")}</h2>
            <span>
              {session.photos.length} / {LIMITS.photos}
            </span>
          </div>
          <PhotoStrip photos={session.photos} onSelect={setSelected} />
          <details className="capture-notes">
            <summary>
              <FileText size={22} aria-hidden /> {t("Add notes")}
            </summary>
            <textarea
              aria-label={t("Walkthrough notes")}
              rows={3}
              maxLength={8000}
              placeholder={t("What needs attention?")}
              defaultValue={session.notes}
              onChange={(e) => engine.current?.setNotes(e.target.value)}
            />
          </details>
          <p className="capture-reminder">
            {t("Keep this page open while recording.")}
          </p>
        </aside>
      </div>
      {activePhoto && (
        <PhotoDialog
          photo={activePhoto}
          project={project}
          readOnly={state === "starting" || state === "finishing" || taking}
          close={() => setSelected(undefined)}
          save={(p) => engine.current?.editPhoto(p)}
          remove={() => engine.current?.removePhoto(activePhoto.id)}
        />
      )}
    </main>
  );
}
