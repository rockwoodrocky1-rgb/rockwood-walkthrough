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
  CircleHelp,
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
      setMessage("Photo captured. Audio continues recording.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setTaking(false);
    }
  }
  const activePhoto = session.photos.find((p) => p.id === selected);
  return (
    <main className="capture-page">
      <div className="page-heading compact">
        <div>
          <p className="eyebrow">{t("WALKTHROUGH IN PROGRESS")}</p>
          <h1>{project.name}</h1>
        </div>
        <span className="sample-label">{t("Sample project")}</span>
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
                <i />
                {state === "recording"
                  ? t("AUDIO REC")
                  : state === "paused"
                    ? t("PAUSED")
                    : state === "starting"
                      ? t("CONNECTING")
                      : state === "finishing"
                        ? t("SAVING")
                        : t("UNAVAILABLE")}
                <b>{formatTime(seconds)}</b>
              </span>
              <span className="viewfinder-note">{t("STILLS ONLY")}</span>
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
                    ? t("Opening your camera")
                    : t("Camera unavailable")}
                </h2>
                <p>
                  {state === "starting"
                    ? t("Allow camera and microphone access to begin.")
                    : t(
                        "Your visit can still be documented with photos and notes.",
                      )}
                </p>
              </div>
            )}
            <div className="viewfinder-bottom">
              <span>
                {area === GENERAL ? t("Choose an area when ready") : t(area)}
              </span>
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
          <div className="recording-explainer">
            <Mic size={16} />
            <span>
              {state === "recording"
                ? t("Audio recording. Transcript prepared when you finish.")
                : state === "paused"
                  ? t("Audio paused. Resume when you are ready.")
                  : state === "starting"
                    ? t("Waiting for camera and microphone permission.")
                    : state === "finishing"
                      ? t("Saving your complete recording and photos.")
                      : t(
                          "No recording is running. Use photos and typed notes.",
                        )}
            </span>
          </div>
          {message && (
            <Notice tone={state === "error" ? "warning" : "neutral"}>
              {t(message)}
            </Notice>
          )}
          {state === "error" ? (
            <div className="button-row">
              <button
                className="button primary"
                onClick={() => setAttempt((a) => a + 1)}
              >
                {t("Retry camera & microphone")}
              </button>
              <button
                className="button"
                onClick={() =>
                  fallback({ ...session, status: "saved", error: undefined })
                }
              >
                {t("Use photos & typed notes")}
              </button>
            </div>
          ) : (
            <div className="capture-controls">
              <button
                className="capture-secondary"
                disabled={
                  state === "starting" || state === "finishing" || taking
                }
                onClick={() =>
                  state === "paused"
                    ? engine.current?.resume()
                    : engine.current?.pause()
                }
              >
                {state === "paused" ? <Play size={23} /> : <Pause size={23} />}
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
                  <Camera size={29} />
                </span>
              </button>
              <button
                className="capture-done"
                disabled={
                  state === "starting" || state === "finishing" || taking
                }
                onClick={() => engine.current?.finish()}
              >
                <Check size={23} />
                <span>{state === "finishing" ? t("Saving…") : t("Done")}</span>
              </button>
            </div>
          )}
        </section>
        <aside className="capture-sidebar">
          <label className="area-label">
            {t("Current area")}
            <span>{t("Optional")}</span>
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
            <h2>{t("Captured photos")}</h2>
            <span>
              {session.photos.length} / {LIMITS.photos}
            </span>
          </div>
          <PhotoStrip photos={session.photos} onSelect={setSelected} />
          <label>
            {t("Walkthrough notes")}
            <span className="muted">{t("Optional")}</span>
            <textarea
              rows={4}
              maxLength={8000}
              placeholder={t(
                "A detail to remember, or a question to follow up…",
              )}
              defaultValue={session.notes}
              onChange={(e) => engine.current?.setNotes(e.target.value)}
            />
          </label>
          <div className="capture-tip">
            <CircleHelp size={18} />
            <div>
              <strong>{t("Walk. Talk. Capture the details.")}</strong>
              <p>
                {t(
                  "Say the room and describe what you see. Take a photo when it helps explain an observation.",
                )}
              </p>
              <p>
                {t(
                  "Keep this page open while recording. Prototype limit: 5 minutes, 12 photos.",
                )}
              </p>
            </div>
          </div>
        </aside>
      </div>
      {activePhoto && (
        <PhotoDialog
          photo={activePhoto}
          project={project}
          close={() => setSelected(undefined)}
          save={(p) => engine.current?.editPhoto(p)}
          remove={() => engine.current?.removePhoto(activePhoto.id)}
        />
      )}
    </main>
  );
}
