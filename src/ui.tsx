"use client";
import { LanguageToggle, useLanguage } from "./i18n";
import { useEffect, useState, useRef, type ReactNode } from "react";
import {
  X,
  ChevronLeft,
  ImagePlus,
  Trash2,
  Download,
} from "lucide-react";
import { formatTime, GENERAL, type Photo, type Project } from "../shared/model";
import { downloadBlob } from "./media";
export function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!blob) return;
    const value = URL.createObjectURL(blob);
    // The URL is an external browser resource: acquire and release in the same effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [blob]);
  return blob ? url : "";
}
export function Logo({ available = true }: { available?: boolean }) {
  const { t } = useLanguage();
  return available ? (
    <img
      className="logo"
      src="/brand/rockwood-logo.png"
      alt="Rockwood Development"
      width="578"
      height="158"
    />
  ) : (
    <div className="logo-missing">
      {t("Required Rockwood logo asset is missing.")}
    </div>
  );
}
export function CamBrand() {
  return (
    <span className="cam-brand" aria-label="Rockwood Cam">
      <img src="/brand/rockwood-cam-mark.png" width="64" height="64" alt="" />
      <span className="cam-wordmark">ROCKWOOD<span>CAM</span></span>
    </span>
  );
}
export function Header({ home }: {
  logoAvailable: boolean;
  home: () => void;
  storageLabel?: string;
}) {
  const { t } = useLanguage();
  return (
    <header className="app-header no-print">
      <button className="brand-button" onClick={home} aria-label={t("Back to projects")}>
        <CamBrand />
      </button>
      <LanguageToggle />
    </header>
  );
}
export function Back({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="text-button back no-print" onClick={onClick}>
      <ChevronLeft size={16} />
      {children}
    </button>
  );
}
export function Notice({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "warning" | "success";
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "warning" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const { t } = useLanguage();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const previous = document.activeElement as HTMLElement;
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label={t("Close dialog")}
          onClick={close}
        >
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function PhotoImage({
  photo,
  onClick,
}: {
  photo: Photo;
  onClick?: () => void;
}) {
  const { t } = useLanguage();
  const url = useBlobUrl(photo.blob);
  return onClick ? (
    <button
      className="photo-thumb"
      onClick={onClick}
      aria-label={t("Preview photo in {area}", { area: t(photo.area) })}
    >
      <img
        src={url || undefined}
        alt={`${t(photo.area)}, ${photo.elapsed === null ? t("Uploaded photo · timing unconfirmed") : formatTime(photo.elapsed)}`}
      />
    </button>
  ) : (
    <img
      className="evidence-photo"
      src={url || undefined}
      alt={t("Walkthrough photo: {area}", { area: t(photo.area) })}
    />
  );
}
export function PhotoStrip({
  photos,
  onSelect,
}: {
  photos: Photo[];
  onSelect: (id: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="photo-strip">
      {photos.length ? (
        photos.map((p) => (
          <PhotoImage key={p.id} photo={p} onClick={() => onSelect(p.id)} />
        ))
      ) : (
        <div className="photo-empty">
          <ImagePlus size={21} />
          <span>{t("No photos yet")}</span>
        </div>
      )}
    </div>
  );
}
export function PhotoDialog({
  photo,
  project,
  save,
  remove,
  close,
  readOnly = false,
}: {
  photo: Photo;
  project: Project;
  save: (p: Photo) => void;
  remove: () => void;
  close: () => void;
  readOnly?: boolean;
}) {
  const { t, locale } = useLanguage();
  const [draft, setDraft] = useState(photo);
  return (
    <Modal title={t("Photo details")} close={close}>
      <PhotoImage photo={draft} />
      <p className="muted small">
        {new Date(draft.capturedAt).toLocaleString(locale)} ·{" "}
        {draft.elapsed === null
          ? t("Uploaded photo · timing unconfirmed")
          : t("{time} into recording", { time: formatTime(draft.elapsed) })}
      </p>
      <label>
        {t("Area")}
        <select
          value={draft.area}
          disabled={readOnly}
          onChange={(e) => setDraft({ ...draft, area: e.target.value })}
        >
          <option value={GENERAL}>{t(GENERAL)}</option>
          {project.areas.map((a) => (
            <option key={a} value={a}>
              {t(a)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("Optional note")}
        <textarea
          value={draft.note}
          readOnly={readOnly}
          maxLength={4000}
          rows={3}
          placeholder={t("What should this photo help document?")}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        />
      </label>
      <div className="button-row">
        {!readOnly && <button
          className="button primary"
          onClick={() => {
            save(draft);
            close();
          }}
        >
          {t("Save photo details")}
        </button>}
        <button
          className="button"
          onClick={() => downloadBlob(draft.blob, `photo-${draft.id}.jpg`)}
        >
          <Download size={16} />
          {t("Download")}
        </button>
        {!readOnly && <button
          className="button danger"
          onClick={() => {
            remove();
            close();
          }}
        >
          <Trash2 size={16} />
          {t("Remove photo")}
        </button>}
      </div>
    </Modal>
  );
}
