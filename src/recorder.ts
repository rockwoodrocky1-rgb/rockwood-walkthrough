import { createId } from "./id";
import {
  LIMITS,
  GENERAL,
  chooseAudioMime,
  RecordingClock,
  type Session,
  type Photo,
} from "../shared/model";
import { saveSession, saveChunk, clearChunks } from "./storage";
import { imageBlobs } from "./media";
export type CaptureState =
  | "starting"
  | "recording"
  | "paused"
  | "finishing"
  | "error";
export class WalkthroughRecorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private clock = new RecordingClock();
  private chunks: Blob[] = [];
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private interval?: ReturnType<typeof setInterval>;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private hasSignal = false;
  private meterRan = false;
  private savedBytes = 0;
  private state: CaptureState = "starting";
  private completing = false;
  private storageError = "";
  public session: Session;
  constructor(
    initial: Session,
    private video: HTMLVideoElement,
    private update: (
      state: CaptureState,
      session: Session,
      seconds: number,
      level: number,
      message?: string,
    ) => void,
    private done: (session: Session) => void,
  ) {
    this.session = {
      ...initial,
      photos: [...initial.photos],
      status: "recording",
      error: undefined,
    };
  }
  private emit(message?: string) {
    this.update(
      this.state,
      { ...this.session, photos: [...this.session.photos] },
      this.clock.seconds(),
      this.level(),
      message,
    );
  }
  private level() {
    if (
      !this.analyser ||
      this.state !== "recording" ||
      this.context?.state !== "running"
    )
      return 0;
    this.meterRan = true;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const n of data) sum += ((n - 128) / 128) ** 2;
    const rms = Math.sqrt(sum / data.length);
    if (rms > 0.008) this.hasSignal = true;
    return Math.min(1, rms * 9);
  }
  private persist() {
    const snapshot = {
      ...this.session,
      duration: this.clock.seconds(),
      photos: [...this.session.photos],
    };
    this.queue = this.queue
      .then(() => saveSession(snapshot))
      .catch(() => {
        this.storageError =
          "Device storage could not save this walkthrough. Keep this page open, finish, and download your audio/photos before leaving.";
        this.pause(this.storageError);
      });
  }
  async start() {
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Camera access needs HTTPS or localhost. Use a secure phone URL, or add photos and typed notes.",
        );
      if (typeof MediaRecorder === "undefined")
        throw new Error(
          "Audio recording is not supported here. Try a current Safari or Chrome browser, or add photos and typed notes.",
        );
      const mime = chooseAudioMime((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      if (!mime)
        throw new Error(
          "No supported audio recording format. Use photo upload and typed notes in this browser.",
        );
      await saveSession(this.session);
      if (this.disposed) return;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "OverconstrainedError")
          this.stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
          });
        else throw e;
      }
      if (this.disposed) {
        this.release();
        return;
      }
      if (
        !this.stream.getAudioTracks().length ||
        !this.stream.getVideoTracks().length
      )
        throw new Error(
          "A working camera and microphone are required. You can use photo upload and typed notes instead.",
        );
      this.video.srcObject = this.stream;
      await this.video.play();
      const audioOnly = new MediaStream(this.stream.getAudioTracks());
      if (audioOnly.getVideoTracks().length !== 0)
        throw new Error("Recorder must contain audio only.");
      this.recorder = new MediaRecorder(audioOnly, {
        mimeType: mime,
        audioBitsPerSecond: LIMITS.audioBitsPerSecond,
      });
      this.session.mime = this.recorder.mimeType || mime;
      this.recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        const sequence = this.chunks.length;
        this.chunks.push(event.data);
        this.savedBytes += event.data.size;
        this.queue = this.queue
          .then(() => saveChunk(this.session.id, sequence, event.data))
          .catch(() => {
            this.storageError =
              "Audio could not be saved to device storage. Keep this page open and download it after Done.";
            this.pause(this.storageError);
          });
        this.persist();
        if (
          this.savedBytes >= LIMITS.requestBytes - 120_000 &&
          !this.completing
        ) {
          this.session.error =
            "Recording stopped near the upload limit. All captured content is retained.";
          this.finish();
        }
      };
      this.recorder.onerror = () => {
        this.session.error =
          "Recording was interrupted by the browser. Available audio has been retained; listen before processing.";
        this.finish();
      };
      this.recorder.onstop = () => {
        void this.complete();
      };
      for (const track of this.stream.getTracks()) {
        track.onended = () => {
          if (!this.completing) {
            this.session.error =
              "A camera or microphone disconnected. Available content is retained.";
            this.finish();
          }
        };
        track.onmute = () => {
          if (!this.completing)
            this.pause(
              "A camera or microphone was interrupted. Check your device before resuming.",
            );
        };
      }
      try {
        this.context = new AudioContext();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 256;
        this.context.createMediaStreamSource(audioOnly).connect(this.analyser);
        void this.context.resume().catch(() => {});
      } catch {
        /* Meter is progressive enhancement; audio recording remains independent. */
      }
      if (this.disposed) {
        this.release();
        return;
      }
      this.recorder.start(1000);
      this.clock.resume();
      this.state = "recording";
      this.persist();
      this.emit();
      this.interval = setInterval(() => {
        this.emit();
        if (this.clock.seconds() >= LIMITS.seconds && !this.completing) {
          this.session.error =
            "Five-minute prototype limit reached. Your walkthrough has been kept.";
          this.finish();
        }
      }, 200);
      document.addEventListener("visibilitychange", this.onVisibility);
    } catch (error) {
      this.release();
      if (this.disposed) return;
      this.state = "error";
      let message =
        error instanceof Error ? error.message : "Could not start capture.";
      if (error instanceof DOMException) {
        const messages: Record<string, string> = {
          NotAllowedError:
            "Camera or microphone permission was denied. Allow access in your browser site settings and retry, or add photos and typed notes.",
          NotFoundError:
            "No camera or microphone was found. Connect both devices or use photo upload and typed notes.",
          NotReadableError:
            "The camera or microphone is busy. Close other apps using it, then retry.",
        };
        message = messages[error.name] || message;
      }
      this.session.status = "interrupted";
      this.session.error = message;
      this.emit(message);
      void saveSession(this.session).catch(() => {});
    }
  }
  private onVisibility = () => {
    if (document.hidden)
      this.pause(
        "Paused because the page was hidden. Keep this page open while recording; resume when ready.",
      );
  };
  pause(message?: string) {
    if (this.state === "recording" && this.recorder?.state === "recording") {
      this.recorder.pause();
      this.clock.pause();
      this.state = "paused";
      this.persist();
      this.emit(message);
    }
  }
  resume() {
    if (this.state !== "paused" || this.disposed) return;
    if (
      this.stream?.getTracks().some((t) => t.readyState === "ended" || t.muted)
    ) {
      this.emit(
        "A device is still unavailable. Finish this walkthrough to preserve your work.",
      );
      return;
    }
    if (this.storageError) {
      this.emit(this.storageError);
      return;
    }
    this.recorder?.resume();
    this.clock.resume();
    this.state = "recording";
    void this.context?.resume();
    this.emit("");
  }
  async photo(area: string) {
    if (this.state !== "recording")
      throw new Error("Resume recording before taking a photo.");
    if (this.session.photos.length >= LIMITS.photos)
      throw new Error("Twelve-photo limit reached.");
    if (this.video.readyState < 2)
      throw new Error("Wait for the live camera image before taking a photo.");
    const meta = {
      id: createId(),
      sessionId: this.session.id,
      projectId: this.session.projectId,
      area: area || GENERAL,
      capturedAt: new Date().toISOString(),
      elapsed: this.clock.seconds(),
      note: "",
      origin: "camera" as const,
    };
    const blobs = await imageBlobs(
      this.video,
      this.video.videoWidth,
      this.video.videoHeight,
    );
    if (this.completing) throw new Error("Capture has finished.");
    this.session.photos = [...this.session.photos, { ...meta, ...blobs }];
    this.persist();
    this.emit();
  }
  editPhoto(photo: Photo) {
    this.session.photos = this.session.photos.map((p) =>
      p.id === photo.id ? photo : p,
    );
    this.persist();
    this.emit();
  }
  removePhoto(id: string) {
    this.session.photos = this.session.photos.filter((p) => p.id !== id);
    this.persist();
    this.emit();
  }
  setNotes(notes: string) {
    this.session.notes = notes;
    this.persist();
  }
  finish() {
    if (this.completing) return;
    this.completing = true;
    this.clock.pause();
    this.state = "finishing";
    this.emit();
    if (this.recorder && this.recorder.state !== "inactive")
      this.recorder.stop();
    else void this.complete();
  }
  private async complete() {
    this.clock.pause();
    this.completing = true;
    this.release();
    await this.queue;
    const audio = new Blob(this.chunks, { type: this.session.mime });
    this.session = {
      ...this.session,
      status: "saved",
      duration: Math.min(this.clock.seconds(), LIMITS.seconds),
      audio,
      lowAudio: this.meterRan && !this.hasSignal,
      error: this.storageError || this.session.error,
    };
    try {
      await saveSession(this.session);
      await clearChunks(this.session.id);
    } catch {
      this.session.error =
        "Device storage is unavailable. Keep this page open and download your capture before leaving.";
    }
    if (!this.disposed) this.done(this.session);
  }
  private release() {
    clearInterval(this.interval);
    document.removeEventListener("visibilitychange", this.onVisibility);
    for (const t of this.stream?.getTracks() || []) {
      t.onended = null;
      t.onmute = null;
      t.stop();
    }
    if (this.context && this.context.state !== "closed")
      void this.context.close();
    this.video.srcObject = null;
  }
  dispose() {
    this.disposed = true;
    this.clock.pause();
    if (this.recorder && this.recorder.state !== "inactive")
      this.recorder.stop();
    this.release();
  }
}
