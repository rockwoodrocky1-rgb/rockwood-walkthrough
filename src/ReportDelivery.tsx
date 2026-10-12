"use client";
import { useLanguage } from "./i18n";
import { useEffect, useState } from "react";
import type { WorkspaceAccess } from "./cloud";
import type { Session } from "../shared/model";
type Status = {
  configured: boolean;
  pdfUrl: string | null;
  reportUrl: string | null;
  job: { status: string; last_error: string | null; revision: number } | null;
};
export default function ReportDelivery({
  access,
  session,
  readOnly,
}: {
  access: WorkspaceAccess;
  session: Session;
  readOnly: boolean;
}) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/deliveries?workspace=${encodeURIComponent(access.workspaceId)}&report=${encodeURIComponent(session.report!.id)}`;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function refresh(kick = false) {
      try {
        const auth = await access.client.auth.getSession();
        const headers = {
          Authorization: `Bearer ${auth.data.session?.access_token || ""}`,
        };
        if (kick && !readOnly)
          await fetch(endpoint, {
            method: "POST",
            headers,
            signal: controller.signal,
          });
        const response = await fetch(endpoint, {
          headers,
          signal: controller.signal,
          cache: "no-store",
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error || "Could not load report delivery status.",
          );
        if (active) {
          setStatus(result);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    if (!session.cloud?.pending) void refresh(true);
    const timer = setInterval(() => void refresh(), 10_000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [access, endpoint, readOnly, session.cloud?.pending]);
  async function retry() {
    setBusy(true);
    try {
      const auth = await access.client.auth.getSession();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.data.session?.access_token || ""}`,
        },
        signal: AbortSignal.timeout(20_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const sent = status?.job?.status === "sent";
  const label =
    error ||
    (session.cloud?.pending
      ? "Report is uploading. Email is queued after it saves."
      : !status
        ? "Checking report delivery…"
        : !status.configured
          ? status.pdfUrl
            ? "PDF saved to Rockwood. Automatic Gmail sending is not connected for this test."
            : "Report saved. Preparing the PDF; automatic Gmail sending is not connected for this test."
          : sent
            ? "PDF submitted for email to rockwoodrocky1@gmail.com."
            : status.job?.status === "needs_attention"
              ? "Email needs an administrator review. Your report is saved."
              : status.job?.status === "cancelled"
                ? "Email cancelled because the visit was archived."
                : "Preparing the photo PDF and email to rockwoodrocky1@gmail.com…");
  return (
    <aside className="report-delivery no-print" aria-live="polite">
      <div>
        <strong>{t("Report delivery")}</strong>
        <p>{t(label)}</p>
        {sent && (
          <small>
            {t(
              "The emailed PDF is the original report. This page includes saved edits.",
            )}
          </small>
        )}
      </div>
      <div className="button-row">
        {status?.pdfUrl && (
          <a
            className="button"
            href={status.pdfUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t("Download PDF")}
          </a>
        )}
        {status?.pdfUrl && status.reportUrl && !status.configured && (
          <button
            className="button"
            onClick={() => {
              const link = status.reportUrl!;
              const title =
                access.projects.find((p) => p.id === session.projectId)?.name ||
                "Site visit";
              location.href = `mailto:rockwoodrocky1@gmail.com?subject=${encodeURIComponent(`Rockwood walkthrough - ${title}`)}&body=${encodeURIComponent(`Report and photos: ${link}\n\nThis read-only link opens without signing in. Share it only with the intended reviewers. To include the PDF attachment, download it from the report and attach it to this email.`)}`;
            }}
          >
            {t("Draft email with report link")}
          </button>
        )}
        {!readOnly &&
          status?.configured &&
          !sent &&
          status.job?.status !== "needs_attention" && (
            <button
              className="button"
              onClick={() => void retry()}
              disabled={busy}
            >
              {busy ? t("Checking…") : t("Check delivery")}
            </button>
          )}
      </div>
    </aside>
  );
}
