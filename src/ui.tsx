"use client";
import { useEffect, useState, useRef, type ReactNode } from "react";
import {
  X,
  ChevronLeft,
  HardDrive,
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
  return available ? (
    <img
      className="logo"
      src="/brand/rockwood-logo.png"
      alt="Rockwood Development"
      width="578"
      height="158"
    />
  ) : (
    <div className="logo-missing">Required Rockwood logo asset is missing.</div>
  );
}
export function Header({
  logoAvailable,
  home,
  storageLabel = "Saved on this device",
}: {
  logoAvailable: boolean;
  home: () => void;
  storageLabel?: string;
}) {
  return (
    <header className="app-header no-print">
      <button
        className="brand-button"
        onClick={home}
        aria-label="Back to projects"
      >
        <Logo available={logoAvailable} />
      </button>
      <div className="header-divider" />
      <span className="app-descriptor">Walkthroughs</span>
      <span className="device-note">
        <HardDrive size={14} /> {storageLabel}
      </span>
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
          aria-label="Close dialog"
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
  const url = useBlobUrl(photo.blob);
  return onClick ? (
    <button
      className="photo-thumb"
      onClick={onClick}
      aria-label={`Preview photo in ${photo.area}`}
    >
      <img
        src={url}
        alt={`${photo.area}, ${photo.elapsed === null ? "uploaded" : formatTime(photo.elapsed)}`}
      />
    </button>
  ) : (
    <img
      className="evidence-photo"
      src={url}
      alt={`Walkthrough photo: ${photo.area}`}
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
  return (
    <div className="photo-strip">
      {photos.length ? (
        photos.map((p) => (
          <PhotoImage key={p.id} photo={p} onClick={() => onSelect(p.id)} />
        ))
      ) : (
        <div className="photo-empty">
          <ImagePlus size={21} />
          <span>Your site photos will appear here.</span>
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
}: {
  photo: Photo;
  project: Project;
  save: (p: Photo) => void;
  remove: () => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState(photo);
  return (
    <Modal title="Photo details" close={close}>
      <PhotoImage photo={draft} />
      <p className="muted small">
        {new Date(draft.capturedAt).toLocaleString()} ·{" "}
        {draft.elapsed === null
          ? "Uploaded photo · timing unconfirmed"
          : `${formatTime(draft.elapsed)} into recording`}
      </p>
      <label>
        Area
        <select
          value={draft.area}
          onChange={(e) => setDraft({ ...draft, area: e.target.value })}
        >
          <option>{GENERAL}</option>
          {project.areas.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </label>
      <label>
        Optional note
        <textarea
          value={draft.note}
          maxLength={4000}
          rows={3}
          placeholder="What should this photo help document?"
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        />
      </label>
      <div className="button-row">
        <button
          className="button primary"
          onClick={() => {
            save(draft);
            close();
          }}
        >
          Save photo details
        </button>
        <button
          className="button"
          onClick={() => downloadBlob(draft.blob, `photo-${draft.id}.jpg`)}
        >
          <Download size={16} />
          Download
        </button>
        <button
          className="text-button danger"
          onClick={() => {
            remove();
            close();
          }}
        >
          <Trash2 size={16} />
          Remove photo
        </button>
      </div>
    </Modal>
  );
}
