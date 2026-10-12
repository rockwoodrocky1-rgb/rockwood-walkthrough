"use client";
import { createId } from "./id";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Camera,
  ChevronRight,
  ClipboardList,
  FileText,
  HardDrive,
  Mic,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  projects as demoProjects,
  type Project,
  type Session,
} from "../shared/model";
import {
  archiveCloudSession,
  canEditSession,
  listCloudSessions,
  loadCloudSession,
  mergeSessions,
  saveCloudSession,
  type WorkspaceAccess,
} from "./cloud";
import {
  listSessions,
  recoverSession,
  resetData,
  saveSession,
  deleteSession,
  loadSession,
} from "./storage";
import { createSample } from "./sample";
import { transcribe, prepareReport, getLiveConfig } from "./api";
import { Back, Header, Modal, Notice } from "./ui";
import WalkthroughCapture from "./WalkthroughCapture";
import SessionReview, { makeManualReport } from "./SessionReview";
import ReportEditor from "./ReportEditor";
type Screen = "projects" | "project" | "capture" | "source" | "report";
export default function App({
  logoAvailable,
  initialLiveAiEnabled,
  cloud,
}: {
  logoAvailable: boolean;
  initialLiveAiEnabled: boolean;
  cloud?: WorkspaceAccess;
}) {
  const projects = cloud?.projects ?? demoProjects;
  const [liveAiEnabled, setLiveAiEnabled] = useState(initialLiveAiEnabled);
  const [screen, setScreen] = useState<Screen>("projects");
  const [project, setProject] = useState<Project>(projects[0]);
  const [active, setActive] = useState<Session>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState("");
  const [stage, setStage] = useState("");
  const [about, setAbout] = useState(false);
  const [reset, setReset] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState("");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const savedVersions = useRef(new Map<string, Session["cloud"]>());
  const lock = useRef(false);
  const refresh = useCallback(async () => {
    const items = await listSessions();
    const recovered = await Promise.all(items.map(recoverSession));
    let result = recovered;
    if (cloud) {
      try {
        result = mergeSessions(recovered, await listCloudSessions(cloud));
      } catch (error) {
        setError((error as Error).message);
      }
    }
    setSessions(result);
    return result;
  }, [cloud]);
  useEffect(() => {
    // refresh reads IndexedDB/the API before publishing state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
      .then(async (items) => {
        setSessions(items);
        const parts = location.hash.slice(1).split("/");
        const p = projects.find((p) => p.id === parts[1]);
        if (p) setProject(p);
        if (parts[0] === "project" && p) setScreen("project");
        if (["source", "report", "capture"].includes(parts[0]) && p) {
          let s =
            items.find((s) => s.id === parts[2]) ||
            (parts[2] === `sample-${p.id}` ? createSample(p) : undefined);
          if (s) {
            if (cloud && s.cloud?.mediaLoaded === false) {
              s = await loadCloudSession(cloud, s.id);
              savedVersions.current.set(s.id, s.cloud);
            }
            setActive(s);
            setScreen(parts[0] === "report" && s.report ? "report" : "source");
          }
        }
      })
      .catch((error) =>
        setError(
          cloud && error instanceof Error
            ? error.message
            : "Device storage is unavailable. Enable browser storage to save walkthroughs.",
        ),
      )
      .finally(() => setLoaded(true));
  }, [refresh, cloud, projects]);
  function navigate(next: Screen, p = project, s = active) {
    setScreen(next);
    setProject(p);
    if (s) setActive(s);
    const hash =
      next === "projects"
        ? ""
        : `${next}/${p.id}${s && ["source", "report", "capture"].includes(next) ? `/${s.id}` : ""}`;
    history.replaceState(null, "", `#${hash}`);
    window.scrollTo({ top: 0 });
  }
  function home() {
    if (screen === "capture" || stage || uploading) {
      setError("Finish the current walkthrough before leaving.");
      return;
    }
    if (
      screen === "report" &&
      !window.confirm("Return to projects? Save any report edits first.")
    )
      return;
    navigate("projects");
  }
  function update(s: Session): Promise<void> {
    const operation = saveQueue.current.then(async () => {
      let next = s;
      if (cloud) {
        const cached = await loadSession(s.id);
        const known = savedVersions.current.get(s.id) ?? cached?.cloud;
        const previous =
          (known?.revision ?? 0) > (s.cloud?.revision ?? 0) ? known : s.cloud;
        next = {
          ...s,
          cloud: {
            ...previous,
            revision: previous?.revision ?? 0,
            pending: true,
            mediaLoaded: true,
            error: undefined,
          },
        };
      }
      await saveSession(next).catch(() => {
        throw new Error(
          "Could not save the recovery copy. Keep this page open and download your media before leaving.",
        );
      });
      setActive((current) => (current?.id === next.id ? next : current));
      if (cloud) {
        setUploading(next.id);
        try {
          next = await saveCloudSession(cloud, next);
          savedVersions.current.set(next.id, next.cloud);
          await deleteSession(next.id);
          setActive((current) => (current?.id === next.id ? next : current));
        } catch (error) {
          next = {
            ...next,
            cloud: {
              ...next.cloud!,
              pending: true,
              error: (error as Error).message,
            },
          };
          await saveSession(next);
          setActive((current) => (current?.id === next.id ? next : current));
          await refresh();
          throw error;
        } finally {
          setUploading("");
        }
      }
      await refresh();
    });
    saveQueue.current = operation.catch(() => {});
    return operation;
  }
  async function openSession(s: Session, selectedProject = project) {
    try {
      setStage("Opening saved visit");
      const hydrated =
        cloud && s.cloud?.mediaLoaded === false
          ? await loadCloudSession(cloud, s.id)
          : s;
      if (cloud) savedVersions.current.set(hydrated.id, hydrated.cloud);
      else await saveSession(hydrated);
      navigate(
        hydrated.report ? "report" : "source",
        selectedProject,
        hydrated,
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setStage("");
    }
  }
  function sample() {
    const saved = sessions.find((s) => s.id === `sample-${project.id}`);
    if (saved && cloud) {
      void openSession(saved);
      return;
    }
    const s = saved || createSample(project);
    navigate("report", project, s);
  }
  async function start() {
    setError("");
    const s: Session = {
      id: createId(),
      projectId: project.id,
      startedAt: new Date().toISOString(),
      duration: 0,
      status: "recording",
      photos: [],
      notes: "",
      mime: "",
    };
    navigate("capture", project, s);
  }
  async function process(s: Session) {
    if (lock.current) return;
    if (
      s.report &&
      !window.confirm(
        "Regenerate this report? This replaces its saved text, edits, and review status. Captured media is kept.",
      )
    )
      return;
    lock.current = true;
    let current = s;
    setStage("Saving walkthrough");
    navigate("source", project, s);
    try {
      await update(current);
      setStage("Checking AI availability");
      const config = await getLiveConfig();
      setLiveAiEnabled(config.live);
      if (!config.live) {
        await update({ ...current, error: undefined });
        return;
      }
      if (!current.transcript && current.audio?.size) {
        setStage("Transcribing audio");
        current = { ...current, transcript: await transcribe(current) };
        await update(current);
      }
      setStage("Preparing report");
      const content = await prepareReport(current);
      current = {
        ...current,
        error: undefined,
        report: {
          ...content,
          id: createId(),
          projectId: current.projectId,
          sessionId: current.id,
          generatedAt: new Date().toISOString(),
          mode: "live",
          reviewStatus: "draft",
        },
      };
      await update(current);
      navigate(
        "report",
        project,
        cloud
          ? { ...current, cloud: savedVersions.current.get(current.id) }
          : current,
      );
    } catch (e) {
      current = {
        ...current,
        error:
          e instanceof Error
            ? e.message
            : "Processing failed. Your work is preserved.",
      };
      setActive(current);
      try {
        if (cloud)
          current = {
            ...current,
            cloud: {
              ...(await loadSession(current.id))?.cloud,
              ...savedVersions.current.get(current.id),
              revision:
                savedVersions.current.get(current.id)?.revision ??
                current.cloud?.revision ??
                0,
              pending: true,
            },
          };
        await saveSession(current);
        await refresh();
      } catch {
        setError(
          "Storage failed. Keep this page open and download your captured media.",
        );
      }
    } finally {
      setStage("");
      lock.current = false;
    }
  }
  function done(s: Session) {
    setActive(s);
    navigate("source", project, s);
    if (liveAiEnabled) void process(s);
    else void update(s).catch((e) => setError(e.message));
  }
  async function manual(s: Session) {
    if (
      s.report &&
      !window.confirm(
        "Replace this report with a new manual draft? Saved report edits will be replaced.",
      )
    )
      return;
    const next = { ...s, error: undefined, report: makeManualReport(s) };
    try {
      await update(next);
      navigate(
        "report",
        project,
        cloud ? { ...next, cloud: savedVersions.current.get(next.id) } : next,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(s: Session) {
    if (cloud && (!s.cloud?.revision || s.cloud.pending)) {
      setError(
        "Finish uploading this visit before archiving it. Its recovery copy is still needed.",
      );
      return;
    }
    if (
      !window.confirm(
        cloud
          ? "Archive this walkthrough for the team? Its saved data is retained and an administrator can restore it."
          : "Delete this walkthrough, its audio, photos and report from this device?",
      )
    )
      return;
    try {
      if (cloud) await archiveCloudSession(cloud, s);
      await deleteSession(s.id);
      await refresh();
    } catch {
      setError("Could not delete this walkthrough.");
    }
  }
  const projectSessions = sessions.filter((s) => s.projectId === project.id);
  return (
    <>
      <Header
        logoAvailable={logoAvailable}
        home={home}
        storageLabel={cloud ? cloud.workspaceName : undefined}
      />
      {cloud && (
        <div className="workspace-bar no-print">
          <span>{cloud.email}</span>
          <button
            className="text-button"
            disabled={
              !!uploading ||
              !["projects", "project"].includes(screen) ||
              !!stage
            }
            onClick={() =>
              void cloud.signOut().catch((e) => setError(e.message))
            }
          >
            Sign out
          </button>
        </div>
      )}
      {cloud && active && ["source", "report"].includes(screen) && (
        <div className="global-notice no-print">
          <Notice tone={active.cloud?.pending ? "warning" : "success"}>
            <strong>
              {uploading === active.id
                ? "Uploading to Rockwood…"
                : active.cloud?.pending
                  ? "Upload pending"
                  : active.cloud?.savedAt
                    ? "Saved to Rockwood"
                    : "Ready to save to Rockwood"}
            </strong>
            <p>
              {uploading === active.id
                ? "Keep this page open until the upload completes."
                : active.cloud?.error ||
                  (active.cloud?.savedAt && !active.cloud.pending
                    ? "Photos, audio, notes, and reports are available to your team after sign-in."
                    : "A recovery copy stays in this browser until the upload completes.")}
            </p>
            {!uploading && active.cloud?.pending && (
              <button
                className="button"
                onClick={() =>
                  void update(active).catch((e) => setError(e.message))
                }
              >
                Retry upload
              </button>
            )}
          </Notice>
        </div>
      )}
      {stage === "Opening saved visit" && (
        <div className="global-notice">
          <Notice>Opening saved visit…</Notice>
        </div>
      )}
      {error && (
        <div className="global-notice no-print">
          <Notice tone="warning">
            {error}
            <button className="text-button" onClick={() => setError("")}>
              Dismiss
            </button>
          </Notice>
        </div>
      )}
      {screen === "projects" && (
        <main className="page projects-page">
          <div className="page-heading home-heading">
            <div>
              <p className="eyebrow">THE SITE VISIT, DOCUMENTED.</p>
              <h1>Your projects</h1>
              <p>Choose a project to document your next site visit.</p>
            </div>
            <span className="prototype-label">
              <i /> {cloud ? "SHARED TEST WORKSPACE" : "LOCAL PROTOTYPE"}
            </span>
          </div>
          <div className="project-grid">
            {projects.map((p) => (
              <button
                className="project-card"
                key={p.id}
                onClick={() => navigate("project", p)}
                aria-label={`Open ${p.name}`}
              >
                <div className="project-image">
                  <img
                    src={p.image}
                    alt={`Illustrative architecture for ${p.name}; not a Rockwood project`}
                  />
                  <span className="sample-label">Sample project</span>
                  <span className="image-note">ILLUSTRATIVE IMAGE</span>
                </div>
                <div className="project-card-content">
                  <span className="eyebrow">
                    {p.number} / {p.type}
                  </span>
                  <h2>{p.name}</h2>
                  <p>{p.stage}</p>
                  <div className="project-card-bottom">
                    <span>
                      {p.areas.length} areas{" "}
                      <span className="dot-separator">·</span>{" "}
                      {
                        sessions.filter((s) => s.projectId === p.id && s.report)
                          .length
                      }{" "}
                      saved reports
                    </span>
                    <span className="round-arrow">
                      <ArrowRight size={18} />
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="how-it-works">
            <div className="how-intro">
              <p className="eyebrow">LESS ADMIN. MORE CLARITY.</p>
              <h2>
                A site visit. <br />A clear record.
              </h2>
            </div>
            <div className="how-step">
              <span className="step-icon">
                <Mic size={22} />
              </span>
              <span className="eyebrow">01 / WALK & TALK</span>
              <p>
                Narrate what you see. <br />
                Keep your attention on the site.
              </p>
            </div>
            <div className="how-step">
              <span className="step-icon">
                <Camera size={22} />
              </span>
              <span className="eyebrow">02 / CAPTURE DETAILS</span>
              <p>
                Take a photo when it matters. <br />
                Your narration keeps recording.
              </p>
            </div>
            <div className="how-step">
              <span className="step-icon">
                <ClipboardList size={22} />
              </span>
              <span className="eyebrow">03 / LEAVE WITH A PLAN</span>
              <p>
                Review the visit, organize actions, <br />
                and print a report worth sharing.
              </p>
            </div>
          </div>
          <div className="home-footnote">
            <p>
              These three projects are fictional demonstrations, not verified
              Rockwood work.
            </p>
            <button
              className="text-button"
              onClick={() => {
                const p = projects[0];
                const saved = sessions.find((s) => s.id === `sample-${p.id}`);
                if (saved && cloud) void openSession(saved, p);
                else navigate("report", p, saved || createSample(p));
              }}
            >
              Explore a sample report <ChevronRight size={16} />
            </button>
          </div>
        </main>
      )}
      {screen === "project" && (
        <main className="page">
          <Back onClick={() => navigate("projects")}>All projects</Back>
          <div className="project-overview">
            <div>
              <p className="eyebrow">
                {project.type} <span className="dot-separator">/</span>{" "}
                {project.stage}
              </p>
              <h1>{project.name}</h1>
              <p className="sample-description">
                <span className="sample-label">Sample project</span> A fictional
                project for exploring your walkthrough workflow.
              </p>
              <div className="area-list">
                <span className="eyebrow">PROJECT AREAS</span>
                {project.areas.map((a) => (
                  <span key={a}>{a}</span>
                ))}
              </div>
              <div className="button-row">
                <button
                  className="button primary large"
                  onClick={() => void start()}
                  disabled={!loaded || cloud?.role === "viewer"}
                >
                  <Camera size={19} />
                  Start walkthrough <ArrowRight size={17} />
                </button>
                <button className="button large" onClick={sample}>
                  <FileText size={18} />
                  View sample report
                </button>
              </div>
              <button
                className="text-button upload-fallback"
                disabled={cloud?.role === "viewer"}
                onClick={() => {
                  const s: Session = {
                    id: createId(),
                    projectId: project.id,
                    startedAt: new Date().toISOString(),
                    duration: 0,
                    status: "saved",
                    photos: [],
                    notes: "",
                    mime: "",
                  };
                  navigate("source", project, s);
                  void update(s).catch((e) => setError(e.message));
                }}
              >
                Prefer to upload photos and type notes?
              </button>
              <p className="muted small">
                5 minutes · 12 photos per visit. Camera and microphone access
                requested after Start.
              </p>
            </div>
            <div className="overview-image">
              <img
                src={project.image}
                alt="Illustrative architecture, not an actual Rockwood project"
              />
              <span>ILLUSTRATIVE IMAGE</span>
            </div>
          </div>
          <section className="saved-section">
            <div className="section-rule">
              <h2>Walkthroughs & reports</h2>
              <span>
                <HardDrive size={14} />{" "}
                {cloud
                  ? "Shared visits · most recent 100"
                  : "Saved on this device"}
              </span>
            </div>
            {projectSessions.length ? (
              <div className="saved-list">
                {projectSessions.map((s) => (
                  <div className="saved-row" key={s.id}>
                    <button
                      disabled={!!stage || !!uploading}
                      onClick={() => void openSession(s)}
                    >
                      <FileText size={22} />
                      <div>
                        <strong>
                          {s.report?.mode === "sample"
                            ? "Sample walkthrough"
                            : new Date(s.startedAt).toLocaleDateString(
                                undefined,
                                {
                                  month: "long",
                                  day: "numeric",
                                  year: "numeric",
                                },
                              )}
                        </strong>
                        <span>
                          {s.report
                            ? `${s.report.reviewStatus === "reviewed" ? "Reviewed" : "Draft"} report`
                            : "Captured visit · ready to process"}{" "}
                          · {s.photos.length} photos{" "}
                          {s.status === "interrupted" ? "· Interrupted" : ""}
                          {cloud && s.cloud?.pending ? " · Upload pending" : ""}
                        </span>
                      </div>
                      <ChevronRight size={19} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={
                        cloud ? "Archive walkthrough" : "Delete walkthrough"
                      }
                      disabled={
                        !!uploading ||
                        (cloud &&
                          (!canEditSession(cloud, s) ||
                            !!s.cloud?.pending ||
                            !s.cloud?.revision))
                      }
                      onClick={() => void remove(s)}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <ClipboardList size={30} />
                <h3>Your next visit starts here.</h3>
                <p>
                  Saved walkthroughs and reviewed reports will appear here.
                  <br />
                  Start a visit, or explore the sample report above.
                </p>
              </div>
            )}
          </section>
        </main>
      )}
      {screen === "capture" && active && (
        <WalkthroughCapture
          project={project}
          initial={active}
          done={done}
          fallback={(s) => {
            navigate("source", project, s);
            void update(s).catch((e) => setError(e.message));
          }}
        />
      )}
      {screen === "source" && active && (
        <SessionReview
          key={active.id}
          project={project}
          session={active}
          stage={stage}
          liveAiEnabled={liveAiEnabled}
          cloudEnabled={!!cloud}
          readOnly={!!cloud && !canEditSession(cloud, active)}
          update={update}
          process={(s) => void process(s)}
          manual={(s) => void manual(s)}
          back={() => {
            if (!stage) navigate("project");
          }}
          sample={sample}
        />
      )}{" "}
      {screen === "report" && active?.report && (
        <ReportEditor
          key={active.report.id}
          project={project}
          initial={active}
          logoAvailable={logoAvailable}
          cloudEnabled={!!cloud}
          readOnly={!!cloud && !canEditSession(cloud, active)}
          save={update}
          back={() => navigate("project")}
          source={() => navigate("source")}
        />
      )}
      <footer className="app-footer no-print">
        <span>
          ROCKWOOD <span className="footer-slash">/</span> WALKTHROUGHS
        </span>
        <div>
          <button onClick={() => setAbout(true)}>About this prototype</button>
          {!cloud && (
            <button
              onClick={() => setReset(true)}
              disabled={screen === "capture" || !!stage}
            >
              Reset demo data
            </button>
          )}
        </div>
      </footer>
      {about && (
        <Modal
          title="A simple record of the site."
          close={() => setAbout(false)}
        >
          <p>
            Record audio, capture individual photos, and organize the visit into
            an editable report. The camera provides a live viewfinder; video is
            never recorded.
          </p>
          <div className="about-section">
            <HardDrive size={20} />
            <div>
              <h3>{cloud ? "Saved to Rockwood" : "Saved on this device"}</h3>
              <p>
                {cloud ? (
                  "Completed visits upload to Rockwood’s private Supabase workspace. Temporary browser recovery copies protect unfinished uploads. Sign in on another device to open shared visits. Only the most recent 100 visits are listed during testing."
                ) : (
                  <>
                    Sessions, audio, photos, and reports use this browser’s
                    IndexedDB storage. Clearing browser data removes them. This
                    is not cloud backup or offline synchronization.
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="about-section">
            <ShieldCheck size={20} />
            <div>
              <h3>Sample and Live AI are separate</h3>
              <p>
                Samples are fictional. Real processing requires a server API key
                and explicit Live mode configuration. Live mode sends content to
                OpenAI. Use non-sensitive test material in a trusted
                environment.
              </p>
            </div>
          </div>
          <p className="small muted">
            Five-minute and twelve-photo limits apply. Keep the page open during
            recording. Reviewed is a local status, not an inspection approval.{" "}
            <a
              href="/images/source-credits.json"
              target="_blank"
              rel="noreferrer"
            >
              Illustrative image credits
            </a>
            .
          </p>
        </Modal>
      )}
      {reset && (
        <Modal title="Reset data on this device?" close={() => setReset(false)}>
          <p>
            This permanently removes saved walkthroughs, recordings, photos,
            report edits, and sample reports from this browser. The three
            fictional projects remain.
          </p>
          <div className="button-row">
            <button className="button" onClick={() => setReset(false)}>
              Keep my data
            </button>
            <button
              className="button primary"
              onClick={() =>
                void resetData()
                  .then(() => {
                    setSessions([]);
                    setActive(undefined);
                    setReset(false);
                    navigate("projects");
                  })
                  .catch(() => setError("Could not reset local data."))
              }
            >
              Delete all local walkthroughs
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
