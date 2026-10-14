"use client";
import { useEffect, useState } from "react";
import { FileText, RotateCw } from "lucide-react";
import { processingPending, type ProcessingStatus } from "../shared/processing";
import { getProcessing } from "./api";
import { Notice } from "./ui";
import { useLanguage } from "./i18n";

// A completed job advances the cloud revision. Keep stale source data locked
// until the user explicitly opens that saved version, preserving local drafts.
export function processingLocksSource(job: ProcessingStatus | null, revision: number) {
  return processingPending(job) || !!(job &&
    ["completed", "conflict", "cancelled"].includes(job.status) &&
    job.source_revision >= revision);
}

export function watchProcessingStatus(
  workspaceId: string,
  visitId: string,
  receive: (job: ProcessingStatus | null) => void,
  failed: () => void,
  readStatus = getProcessing,
) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    try {
      const next = await readStatus(workspaceId, visitId);
      if (cancelled) return;
      receive(next);
      if (processingPending(next)) timer = setTimeout(check, 10_000);
    } catch {
      if (cancelled) return;
      failed();
      timer = setTimeout(check, 30_000);
    }
  };
  void check();
  return () => { cancelled = true; clearTimeout(timer); };
}

export default function ProcessingStatusPanel({workspaceId, visitId, revision, statusKey, onBusy, openReport, retry, canRetry, dirty = false, working = false}: {
  workspaceId: string; visitId: string; revision: number; statusKey: string;
  onBusy: (key: string, busy: boolean) => void;
  openReport: () => void; retry: () => void; canRetry: boolean;
  dirty?: boolean; working?: boolean;
}) {
  const {t} = useLanguage();
  const [job, setJob] = useState<ProcessingStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => watchProcessingStatus(workspaceId, visitId, next => {
    setJob(next); setError(""); setChecked(true);
    onBusy(statusKey, processingLocksSource(next, revision));
  }, () => {
    // An unavailable status check must not unlock a job already in progress.
    setError("Could not check report progress. Your saved visit is safe.");
  }), [workspaceId, visitId, revision, statusKey, refresh, onBusy]);
  if (!job && !error && checked) return null;
  const pending = processingPending(job);
  const failed = job && ["failed", "conflict", "cancelled"].includes(job.status);
  const reopen = job?.status === "completed" || job?.status === "conflict";
  return <div className="global-notice no-print" aria-live="polite">
    <Notice tone={error || failed ? "warning" : job?.status === "completed" ? "success" : undefined}>
      <strong>{t(error || (!checked ? "Checking report progress…" : job?.status === "completed" ? "Report ready" : failed ? "Report needs attention" : job?.phase === "transcribing" ? "Transcribing recording…" : job?.phase === "reporting" ? "Creating English report…" : "Report queued"))}</strong>
      {pending && <p>{t("Your visit is saved. You can leave this page while the report finishes.")}</p>}
      {failed && <p>{t(job.status === "conflict" ? "This visit changed during processing. Reopen it and create a new report." : job.status === "cancelled" ? "This visit was archived. Return to projects." : job.last_error ?? "The report could not be completed. Your recording is saved. Retry the report.")}</p>}
      {reopen && <button className="button primary" onClick={openReport} disabled={working}><FileText size={22}/>{t(job?.status === "completed" ? "Open report" : "Open saved visit")}</button>}
      {job?.status === "failed" && canRetry && <>
        <button className="button" onClick={retry} disabled={dirty || working}><RotateCw size={22}/>{t("Retry report")}</button>
        {dirty && <p>{t("Save notes before retrying.")}</p>}
      </>}
      {error && <button className="button" onClick={() => setRefresh(v => v + 1)} disabled={working}>{t("Check again")}</button>}
      {failed && job.transcript?.text && <details><summary>{t("Saved transcript")}</summary><p className="preserve-lines">{job.transcript.text}</p></details>}
    </Notice>
  </div>;
}
