"use client";
import { useLanguage } from "./i18n";
import { useEffect, useState } from "react";
import { Download, Mail, RefreshCw } from "lucide-react";
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
      ? "Saving report…"
      : !status
        ? "Preparing PDF…"
        : !status.configured
          ? status.pdfUrl
            ? "PDF ready. Automatic email is not connected."
            : "Report saved. Preparing PDF…"
          : sent
            ? "Email submitted to rockwoodrocky1@gmail.com."
            : status.job?.status === "needs_attention"
              ? "Report saved. Email needs administrator review."
              : status.job?.status === "cancelled"
                ? "Visit archived. Email cancelled."
                : "Preparing PDF and email…");
  return (
    <aside className="report-delivery no-print" aria-live="polite">
      <div>
        <strong>{t("PDF & email")}</strong>
        <p>{t(label)}</p>
        {sent && (
          <p>{t("The PDF is the original version. This page shows saved edits.")}</p>
        )}
      </div>
      <div className="button-row report-delivery-actions">
        {status?.pdfUrl && (
          <a
            className="button primary"
            href={status.pdfUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Download size={22} />
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
            <Mail size={22} />
            {t("Draft email")}
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
              <RefreshCw size={22} />
              {busy ? t("Checking…") : t("Check delivery")}
            </button>
          )}
      </div>
    </aside>
  );
}
