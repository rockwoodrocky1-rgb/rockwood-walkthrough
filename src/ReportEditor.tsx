"use client";
import { useLanguage } from "./i18n";
import { translateReport } from "./api";
import { createId } from "./id";
import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Circle,
  FileText,
  Printer,
  Plus,
  Trash2,
  Save,
  Pencil,
  ChevronDown,
  Link2,
  Download,
} from "lucide-react";
import {
  GENERAL,
  formatTime,
  type Session,
  type Report,
  type Project,
  type ActionItem,
  type Observation,
} from "../shared/model";
import { Back, Logo, Notice, PhotoImage, useBlobUrl } from "./ui";
import ReportDelivery from "./ReportDelivery";
import type { WorkspaceAccess } from "./cloud";
const basisLabels = {
  narration: "Narration only",
  photo: "Visible in photo",
  user_note: "User note",
  mixed: "Multiple sources",
};
const stateLabels = {
  reported_complete: "Reported complete",
  outstanding: "Outstanding",
  requested_review: "Requested review",
  information: "Observation",
};
function Editable({
  label,
  value,
  onChange,
  edit,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  edit: boolean;
  multiline?: boolean;
}) {
  const { t } = useLanguage();
  return edit ? (
    <label className="editable-label">
      {t(label)}
      {multiline ? (
        <textarea
          aria-label={t(label)}
          value={value}
          rows={Math.max(2, Math.min(6, Math.ceil(value.length / 85)))}
          onChange={(e) => onChange(e.target.value)}
          maxLength={4000}
        />
      ) : (
        <input
          aria-label={t(label)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={300}
        />
      )}
    </label>
  ) : (
    <p className="preserve-lines">{value}</p>
  );
}
export default function ReportEditor({
  initial,
  project,
  logoAvailable,
  save,
  back,
  source,
  cloudEnabled = false,
  readOnly = false,
  cloud,
  pdfUrl,
}: {
  initial: Session;
  project: Project;
  logoAvailable: boolean;
  save: (s: Session) => Promise<void>;
  back: () => void;
  source: () => void;
  cloudEnabled?: boolean;
  readOnly?: boolean;
  cloud?: WorkspaceAccess;
  pdfUrl?: string | null;
}) {
  const { t, language, locale } = useLanguage();
  const [report, setReport] = useState<Report>(initial.report!);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const audio = useBlobUrl(initial.audio);
  const [evidence, setEvidence] = useState<string>();
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function change(patch: Partial<Report>) {
    if (readOnly) return;
    setReport((r) => ({ ...r, ...patch, reviewStatus: "draft" }));
    setDirty(true);
    setMessage("");
  }
  function changeObservation(id: string, patch: Partial<Observation>) {
    change({
      observations: report.observations.map((o) => {
        if (o.id !== id) return o;
        const updated = { ...o, ...patch };
        if (patch.photoIds) {
          const sources = [
            updated.photoIds.length > 0,
            updated.transcriptSegmentIds.length > 0,
            updated.noteIds.length > 0,
          ];
          updated.basis =
            sources.filter(Boolean).length > 1
              ? "mixed"
              : sources[0]
                ? "photo"
                : sources[1]
                  ? "narration"
                  : "user_note";
        }
        return updated;
      }),
    });
  }
  function changeAction(id: string, patch: Partial<ActionItem>) {
    change({
      actionItems: report.actionItems.map((o) =>
        o.id === id ? { ...o, ...patch } : o,
      ),
    });
  }
  async function persist(reviewed = false) {
    if (readOnly) return;
    setSaving(true);
    try {
      const english =
        language === "es" || initial.language === "es"
          ? await translateReport(report)
          : report;
      const next = {
        ...report,
        ...english,
        outputLanguage: "en" as const,
        reviewStatus: reviewed ? ("reviewed" as const) : report.reviewStatus,
      };
      await save({ ...initial, report: next });
      setReport(next);
      setDirty(false);
      setEditing(false);
      setMessage(
        reviewed
          ? cloudEnabled
            ? "Marked reviewed and saved to Rockwood."
            : "Marked reviewed and saved on this device."
          : cloudEnabled
            ? "Report saved to Rockwood."
            : "Report saved on this device.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function leave(action: () => void) {
    if (!dirty || window.confirm(t("Leave without saving your report edits?")))
      action();
  }
  function addAction(category: ActionItem["category"]) {
    change({
      actionItems: [
        ...report.actionItems,
        {
          id: createId(),
          area: GENERAL,
          task: "New action — add details.",
          category,
          observationIds: [],
          photoIds: [],
          transcriptSegmentIds: [],
          noteIds: [],
          priority: "unassigned",
          suggestedTrade: null,
          assignee: null,
          dueDateText: null,
          status: "open",
          needsConfirmation: true,
        },
      ],
    });
    setEditing(true);
  }
  const areaNames = [...new Set(report.observations.map((o) => o.area))];
  const completed = report.observations.filter(
    (o) => o.state === "reported_complete",
  );
  function references(item: {
    id: string;
    photoIds: string[];
    transcriptSegmentIds: string[];
    noteIds: string[];
  }) {
    const isOpen = evidence === item.id;
    const printSources = [
      ...item.photoIds.map(
        (id) => `Photo ${initial.photos.findIndex((p) => p.id === id) + 1}`,
      ),
      ...item.transcriptSegmentIds.map((id) => {
        const segment = initial.transcript?.segments.find((s) => s.id === id);
        return segment?.start != null
          ? `Narration ${formatTime(segment.start)}`
          : "Untimed transcript";
      }),
      ...(item.noteIds.length ? ["User notes"] : []),
    ];
    return (
      <>
        <div className="evidence-links no-print">
          {item.photoIds.length +
            item.transcriptSegmentIds.length +
            item.noteIds.length >
          0 ? (
            <button
              className="button evidence-toggle"
              onClick={() => setEvidence(isOpen ? undefined : item.id)}
              aria-expanded={isOpen}
            >
              <Link2 size={20} />
              {isOpen ? t("Hide evidence") : t("View evidence")}
              <ChevronDown size={20} />
            </button>
          ) : (
            <span className="muted">
              {t("No evidence linked · verify before sharing")}
            </span>
          )}
          {isOpen && (
            <div className="evidence-details">
              {item.transcriptSegmentIds.map((id) => {
                const s = initial.transcript?.segments.find((s) => s.id === id);
                return (
                  s && (
                    <blockquote key={id}>
                      <span>
                        {s.start === null
                          ? t("Timing unconfirmed")
                          : formatTime(s.start)}
                      </span>
                      {s.text}
                    </blockquote>
                  )
                );
              })}
              {item.noteIds.map((id) => (
                <p key={id}>
                  <b>{t("User note:")}</b>
                  {id === "session-note"
                    ? initial.notes
                    : initial.photos.find((p) => p.id === id)?.note}
                </p>
              ))}
              {item.photoIds.map((id) => {
                const p = initial.photos.find((p) => p.id === id);
                return p && <PhotoImage key={id} photo={p} />;
              })}
            </div>
          )}
        </div>
        {printSources.length > 0 && (
          <p className="print-only evidence-print">
            {t("Evidence:")} {printSources.join(" · ")}
          </p>
        )}
      </>
    );
  }
  function photoPicker(
    item: { id: string; photoIds: string[] },
    isObservation: boolean,
  ) {
    return (
      editing &&
      initial.photos.length > 0 && (
        <fieldset className="photo-picker no-print">
          <legend>{t("Link photos")}</legend>
          {initial.photos.map((p, i) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={item.photoIds.includes(p.id)}
                onChange={(e) => {
                  const ids = e.target.checked
                    ? [...item.photoIds, p.id]
                    : item.photoIds.filter((id) => id !== p.id);
                  if (isObservation)
                    changeObservation(item.id, {
                      photoIds: ids,
                      needsVerification: true,
                    });
                  else
                    changeAction(item.id, {
                      photoIds: ids,
                      needsConfirmation: true,
                    });
                }}
              />
              {t("Photo")} {i + 1} · {p.area}
            </label>
          ))}
        </fieldset>
      )
    );
  }
  return (
    <main className="report-page">
      <div className="report-topbar no-print">
        <Back onClick={() => leave(back)}>{t("Back to project")}</Back>
        <div className="button-row">
          {pdfUrl && (
            <a
              className="button primary"
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Download size={22} />
              {t("Download PDF")}
            </a>
          )}
          {!readOnly && (
            <>
              <button
                className="button"
                disabled={saving}
                aria-pressed={editing}
                onClick={() => setEditing(!editing)}
              >
                <Pencil size={22} />
                {editing ? t("Preview report") : t("Edit report")}
              </button>
              {(editing || dirty) && (
                <button
                  className="button primary"
                  onClick={() => void persist()}
                  disabled={saving || !dirty}
                >
                  <Save size={22} />
                  {saving ? t("Saving…") : t("Save report")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {message && (
        <div className="no-print">
          <Notice>{t(message)}</Notice>
        </div>
      )}
      {(language === "es" || readOnly || dirty) && (
        <p className="report-status no-print">
          {[
            language === "es" && t("English report"),
            readOnly && t("Read only"),
            dirty && t("Unsaved changes"),
          ].filter(Boolean).join(" · ")}
        </p>
      )}
      {cloud && initial.report?.mode !== "sample" && (
        <ReportDelivery access={cloud} session={initial} readOnly={readOnly} />
      )}
      <article className={`report-paper ${editing ? "is-editing" : ""}`}>
        <header className="report-header">
          <Logo available={logoAvailable} />
          <div className="report-identity">
            <span className="eyebrow">{t("FIELD DOCUMENTATION")}</span>
            <span>
              RW / {project.number} /{" "}
              {new Date(initial.startedAt).getFullYear()}
            </span>
          </div>
        </header>
        <div className="report-title">
          <p className="eyebrow">
            {report.mode === "sample"
              ? t("FICTIONAL SAMPLE · NOT BASED ON A RECORDING")
              : report.mode === "manual"
                ? t("MANUALLY PREPARED REPORT")
                : t("SITE VISIT RECORD")}
          </p>
          <h1>
            {t("Site Walkthrough")}
            <br className="desktop-break" />
            {t("Report")}
          </h1>
          <p className="report-project">{project.name}</p>
          <span className="sample-label">{t("Fictional sample project")}</span>
        </div>
        {initial.participant && (
          <div className="participant-summary">
            <strong>{t("Submitted by")}</strong> {initial.participant.name} ·{" "}
            {initial.participant.phone}
          </div>
        )}
        <div className="report-meta">
          <div>
            <span>{t("VISIT DATE")}</span>
            <strong>
              {new Date(initial.startedAt).toLocaleDateString(locale, {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </strong>
            <small>
              {new Date(initial.startedAt).toLocaleTimeString(locale, {
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              })}
            </small>
          </div>
          <div>
            <span>{t("DURATION / PHOTOS")}</span>
            <strong>
              {formatTime(initial.duration)} / {initial.photos.length}{" "}
              {t(initial.photos.length === 1 ? "photo" : "photos")}
            </strong>
            <small>
              {[
                ...new Set(initial.photos.map((p) => p.area).concat(areaNames)),
              ].join(", ") || t("Area unconfirmed")}
            </small>
          </div>
          <div>
            <span>{t("STATUS")}</span>
            <strong className="burgundy">
              {report.mode === "sample" ? t("Sample · ") : ""}
              {report.reviewStatus === "reviewed" ? t("Reviewed") : t("Draft")}
              {dirty ? t(" · unsaved") : ""}
            </strong>
            <small>
              {report.reviewStatus === "reviewed"
                ? t("Local review status")
                : t("Awaiting your review")}
            </small>
          </div>
        </div>
        <div className="report-disclosure">
          {report.mode === "sample"
            ? t(
                "Fictional sample report. These findings are illustrative and are not based on any captured recording or photographs.",
              )
            : report.mode === "live" && report.reviewStatus !== "reviewed"
              ? t("AI-assisted draft. Review before sharing.")
              : report.mode === "manual"
                ? t(
                    "Manually prepared from your notes. Review evidence and wording before sharing.",
                  )
                : t(
                    "Reviewed by the local user. This is not a signed inspection or authenticated approval.",
                  )}
        </div>
        <section className="report-section">
          <div className="report-section-title">
            <span>01</span>
            <h2>{t("Visit summary")}</h2>
          </div>
          <div className="summary-text">
            <Editable
              label={t("Visit summary")}
              value={report.summary}
              onChange={(summary) => change({ summary })}
              edit={editing}
              multiline
            />
          </div>
        </section>
        <section className="report-section">
          <div className="report-section-title">
            <span>02</span>
            <h2>{t("Observations by area")}</h2>
          </div>
          {!areaNames.length && (
            <p className="muted">{t("No observations recorded yet.")}</p>
          )}
          {areaNames.map((area) => (
            <div className="area-group" key={area}>
              <h3>{area}</h3>
              {report.observations
                .filter((o) => o.area === area)
                .map((o) => (
                  <div className="observation" key={o.id}>
                    <div className="observation-heading">
                      <span className={`state-label ${o.state}`}>
                        {t(stateLabels[o.state])}
                      </span>
                      <span className="muted small">
                        {t(basisLabels[o.basis])}
                        {o.needsVerification ? t(" · needs verification") : ""}
                      </span>
                    </div>
                    <Editable
                      label={t("Observation")}
                      value={o.description}
                      onChange={(description) =>
                        changeObservation(o.id, { description })
                      }
                      edit={editing}
                      multiline
                    />
                    {editing && (
                      <div className="form-grid">
                        <label>
                          {t("Area")}
                          <input
                            value={o.area}
                            maxLength={300}
                            onChange={(e) =>
                              changeObservation(o.id, { area: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          {t("Observation status")}
                          <select
                            value={o.state}
                            onChange={(e) =>
                              changeObservation(o.id, {
                                state: e.target.value as Observation["state"],
                              })
                            }
                          >
                            {Object.entries(stateLabels).map(([key, label]) => (
                              <option key={key} value={key}>
                                {t(label)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                    {references(o)}
                    {photoPicker(o, true)}
                    {editing && (
                      <button
                        className="button danger"
                        onClick={() =>
                          change({
                            observations: report.observations.filter(
                              (x) => x.id !== o.id,
                            ),
                            actionItems: report.actionItems.map((a) => ({
                              ...a,
                              observationIds: a.observationIds.filter(
                                (id) => id !== o.id,
                              ),
                            })),
                          })
                        }
                      >
                        <Trash2 size={20} />
                        {t("Remove observation")}
                      </button>
                    )}
                  </div>
                ))}
            </div>
          ))}
          {editing && (
            <button
              className="button no-print"
              onClick={() => {
                const id = createId();
                change({
                  observations: [
                    ...report.observations,
                    {
                      id,
                      area: GENERAL,
                      description: "Add a documented observation.",
                      basis: "user_note",
                      state: "information",
                      photoIds: [],
                      transcriptSegmentIds: [],
                      noteIds: [],
                      needsVerification: true,
                    },
                  ],
                });
              }}
            >
              <Plus size={20} />
              {t("Add observation")}
            </button>
          )}
        </section>
        <section className="report-section">
          <div className="report-section-title">
            <span>03</span>
            <h2>{t("Work reported complete")}</h2>
          </div>
          {completed.length ? (
            <ul className="completed-list">
              {completed.map((o) => (
                <li key={o.id}>
                  <CheckCircle2 size={18} />
                  <div>
                    <strong>{o.area}</strong>
                    <p>{o.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t("No completed work has been reported.")}</p>
          )}
          <p className="section-note">
            {t(
              "Reported completion is not independent verification or an inspection sign-off.",
            )}
          </p>
        </section>
        {(["outstanding", "next_step", "question"] as const).map(
          (category, index) => (
            <section className="report-section" key={category}>
              <div className="report-section-title">
                <span>{String(index + 4).padStart(2, "0")}</span>
                <h2>
                  {category === "outstanding"
                    ? t("Outstanding work / punch list")
                    : category === "next_step"
                      ? t("Proposed next steps")
                      : t("Questions & confirmations")}
                </h2>
              </div>
              {report.actionItems
                .filter((a) => a.category === category)
                .map((a, i) => (
                  <div
                    className={`action-item ${a.status === "done" ? "is-done" : ""}`}
                    key={a.id}
                  >
                    {!readOnly ? (
                      <button
                        className="task-check no-print"
                        aria-label={`${t(a.status === "done" ? "Reopen" : "Complete")}: ${a.task}`}
                        onClick={() =>
                          changeAction(a.id, {
                            status: a.status === "done" ? "open" : "done",
                          })
                        }
                      >
                        {a.status === "done" ? (
                          <CheckCircle2 size={22} />
                        ) : (
                          <Circle size={22} />
                        )}
                      </button>
                    ) : (
                      <span
                        className="task-check no-print"
                        role="img"
                        aria-label={t(a.status === "done" ? "Done" : "Open")}
                      >
                        {a.status === "done" ? (
                          <CheckCircle2 size={22} />
                        ) : (
                          <Circle size={22} />
                        )}
                      </span>
                    )}
                    <span className="print-only task-print-status">
                      [{a.status === "done" ? t("Done") : t("Open")}]
                    </span>
                    <div className="action-body">
                      <span className="eyebrow">
                        {String(i + 1).padStart(2, "0")} / {a.area}
                      </span>
                      <Editable
                        label={t("Action item")}
                        value={a.task}
                        onChange={(task) => changeAction(a.id, { task })}
                        edit={editing}
                        multiline
                      />
                      {editing ? (
                        <div className="form-grid">
                          <label>
                            {t("Area")}
                            <input
                              value={a.area}
                              maxLength={300}
                              onChange={(e) =>
                                changeAction(a.id, { area: e.target.value })
                              }
                            />
                          </label>
                          <label>
                            {t("Assignee")}
                            <input
                              value={a.assignee ?? ""}
                              placeholder={t("Unassigned")}
                              maxLength={300}
                              onChange={(e) =>
                                changeAction(a.id, {
                                  assignee: e.target.value || null,
                                })
                              }
                            />
                          </label>
                          <label>
                            {t("Due date / timing")}
                            <input
                              value={a.dueDateText ?? ""}
                              placeholder={t("Unassigned")}
                              maxLength={300}
                              onChange={(e) =>
                                changeAction(a.id, {
                                  dueDateText: e.target.value || null,
                                })
                              }
                            />
                          </label>
                          <label>
                            {t("Priority")}
                            <select
                              value={a.priority}
                              onChange={(e) =>
                                changeAction(a.id, {
                                  priority: e.target
                                    .value as ActionItem["priority"],
                                })
                              }
                            >
                              <option value="unassigned">
                                {t("Unassigned")}
                              </option>
                              <option value="low">{t("Low")}</option>
                              <option value="normal">{t("Normal")}</option>
                              <option value="high">{t("High")}</option>
                            </select>
                          </label>
                        </div>
                      ) : (
                        <p className="task-meta">
                          {a.assignee || t("Unassigned")} <span>·</span>{" "}
                          {a.dueDateText || t("No due date")}
                          {a.priority !== "unassigned"
                            ? t(" · {priority} priority", {
                                priority: t(a.priority),
                              })
                            : ""}
                          {a.status === "done" ? t(" · Done") : ""}
                        </p>
                      )}
                      {a.suggestedTrade && (
                        <p className="small muted">
                          {t("Suggested trade:")} {a.suggestedTrade}{" "}
                          {t("· no person assigned")}
                        </p>
                      )}
                      {a.needsConfirmation && (
                        <p className="small muted">{t("Needs confirmation")}</p>
                      )}
                      {references(a)}
                      {photoPicker(a, false)}
                      {editing && (
                        <button
                          className="button danger"
                          onClick={() =>
                            change({
                              actionItems: report.actionItems.filter(
                                (x) => x.id !== a.id,
                              ),
                            })
                          }
                        >
                          <Trash2 size={20} />
                          {t("Remove action")}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              {!report.actionItems.some((a) => a.category === category) && (
                <p className="muted">{t("None recorded.")}</p>
              )}
              {!readOnly && editing && (
                <button
                  className="button no-print"
                  onClick={() => addAction(category)}
                >
                  <Plus size={20} />
                  {t("Add")}{" "}
                  {category === "question"
                    ? t("question")
                    : category === "next_step"
                      ? t("next step")
                      : t("task")}
                </button>
              )}
            </section>
          ),
        )}
        <section className="report-section">
          <div className="report-section-title">
            <span>07</span>
            <h2>{t("Photo record")}</h2>
          </div>
          {initial.photos.length ? (
            <div className="report-photos">
              {initial.photos.map((p, i) => (
                <figure key={p.id}>
                  <PhotoImage photo={p} />
                  <figcaption>
                    <span className="eyebrow">
                      {t("PHOTO")} {String(i + 1).padStart(2, "0")} · {p.area}
                    </span>
                    <Editable
                      label={t("Caption for photo {number}", { number: i + 1 })}
                      value={
                        report.captions.find((c) => c.photoId === p.id)
                          ?.caption ||
                        p.note ||
                        "Caption not supplied."
                      }
                      onChange={(caption) =>
                        change({
                          captions: [
                            ...report.captions.filter(
                              (c) => c.photoId !== p.id,
                            ),
                            { photoId: p.id, caption },
                          ],
                        })
                      }
                      edit={editing}
                    />
                    <small className="muted">
                      {p.elapsed === null
                        ? t("Uploaded · time unconfirmed")
                        : t("Captured at {time}", {
                            time: formatTime(p.elapsed),
                          })}
                    </small>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="muted">
              {t(
                "No photos attached. Observations with narration evidence remain labeled accordingly.",
              )}
            </p>
          )}
        </section>
        <section className="transcript-section">
          <details className="transcript-details">
            <summary>
              <FileText size={17} />
              {t("Walkthrough transcript")}{" "}
              <span>
                {initial.transcript?.source === "sample"
                  ? t("Fictional sample")
                  : initial.transcript?.source === "manual"
                    ? t("Manual transcript")
                    : t("Original evidence")}
              </span>
            </summary>
            {initial.transcript?.segments.map((s) => (
              <div className="transcript-segment" id={s.id} key={s.id}>
                <span>
                  {s.start === null ? t("Untimed") : formatTime(s.start)}
                </span>
                <p>{s.text}</p>
              </div>
            ))}
            {!initial.transcript?.text && (
              <p className="muted">{t("No transcript supplied.")}</p>
            )}
            {audio && (
              <div className="no-print">
                <h3>{t("Original audio")}</h3>
                <audio
                  controls
                  src={audio}
                  aria-label={t("Original recording")}
                />
              </div>
            )}
          </details>
        </section>
        <footer className="report-footer">
          <span>ROCKWOOD DEVELOPMENT</span>
          <span>
            {report.mode === "sample" ? t("FICTIONAL SAMPLE · ") : ""}
            {t("SITE WALKTHROUGH /")}
            {t(
              report.reviewStatus === "reviewed" ? "Reviewed" : "Draft",
            ).toUpperCase()}
          </span>
        </footer>
      </article>
      <div className="report-actions no-print">
        {dirty && <p role="status">{t("Unsaved changes")}</p>}
        <div className="button-row">
          {report.mode !== "sample" && !readOnly && (
            <button className="button" onClick={() => leave(source)}>
              <FileText size={22} />
              {t("Photos & notes")}
            </button>
          )}
          <button
            className="button"
            onClick={() => {
              setEditing(false);
              requestAnimationFrame(() =>
                requestAnimationFrame(() => window.print()),
              );
            }}
          >
            <Printer size={22} />
            {t("Print report")}
          </button>
          {!readOnly && (dirty || report.reviewStatus !== "reviewed") && (
            <button
              className="button primary"
              onClick={() => void persist(true)}
              disabled={saving}
            >
              <Check size={22} />
              {saving ? t("Saving…") : t("Mark reviewed")}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
