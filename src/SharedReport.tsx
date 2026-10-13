"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cloudRowSchema, rowToSession } from "./cloud";
import type { Project, Session } from "../shared/model";
import { LanguageProvider, useLanguage } from "./i18n";
import { Header, Notice } from "./ui";
import ReportEditor from "./ReportEditor";
function SharedContent() {
  const { t } = useLanguage();
  const router = useRouter();
  const [saved, setSaved] = useState<{
    session: Session;
    project: Project;
    pdfUrl: string | null;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const response = await fetch(`/api/shared-report${location.search}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const row = cloudRowSchema.parse(data.row);
      const session = rowToSession(row);
      async function blob(url: string) {
        const result = await fetch(url, { signal: controller.signal });
        if (!result.ok)
          throw new Error(
            "Could not load report photos. Refresh to try again.",
          );
        return result.blob();
      }
      session.photos = await Promise.all(
        row.payload.photos.map(async (photo, i) => {
          const image = await blob(data.row.payload.photos[i].url);
          return { ...photo, blob: image, modelBlob: image };
        }),
      );
      if (data.audioUrl) session.audio = await blob(data.audioUrl);
      if (!controller.signal.aborted)
        setSaved({ session, project: data.project, pdfUrl: data.pdfUrl });
    }
    void load().catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, []);
  return (
    <>
      <Header
        logoAvailable
        home={() => {
          router.push("/");
        }}
        storageLabel={t("Shared report")}
      />
      {error ? (
        <main className="page">
          <Notice tone="warning">{t(error)}</Notice>
        </main>
      ) : saved ? (
        <ReportEditor
          project={saved.project}
          initial={saved.session}
          logoAvailable
          cloudEnabled
          readOnly
          pdfUrl={saved.pdfUrl}
          save={async () => {
            throw new Error("Read-only report");
          }}
          back={() => {
            router.push("/");
          }}
          source={() => {}}
        />
      ) : (
        <main className="page">
          <Notice>{t("Opening saved visit…")}</Notice>
        </main>
      )}
    </>
  );
}
export default function SharedReport() {
  return (
    <LanguageProvider>
      <SharedContent />
    </LanguageProvider>
  );
}
