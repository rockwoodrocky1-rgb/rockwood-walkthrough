import {
  LIMITS,
  audioExtension,
  reportContentSchema,
  transcriptSchema,
  validateEvidence,
  photoMetaSchema,
  type Session,
  type ReportInput,
} from "../shared/model";
import { dataUrl } from "./media";
import { getSupabase } from "./supabase";
export function explainSavedProcessingError(message: string) {
  if (
    /^(fetch is aborted\.?|the operation was aborted\.?)$/i.test(message.trim())
  )
    return "The previous AI request was interrupted. Your captured audio and photos are still saved in this browser. Retry AI processing or create a manual report.";
  return message;
}
export async function serverRequest(
  path: string,
  init: RequestInit,
  operation: string,
  timeoutMs = 115_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        data?.error || "Processing failed. Your work is preserved.",
      );
    return data;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (
      controller.signal.aborted ||
      name === "TimeoutError" ||
      name === "AbortError"
    )
      throw new Error(
        `${operation} was interrupted or took too long. Your walkthrough is still saved in this browser. Keep the page open and retry, or create a manual report.`,
      );
    if (error instanceof TypeError)
      throw new Error(
        `Could not reach the site to ${operation.charAt(0).toLowerCase() + operation.slice(1)}. Your walkthrough is still saved in this browser. Check your connection and retry, or create a manual report.`,
      );
    if (error instanceof SyntaxError)
      throw new Error(
        "The site returned an unreadable response. Your walkthrough is still saved in this browser. Retry, or create a manual report.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export async function getLiveConfig(): Promise<{ live: boolean }> {
  const data = await serverRequest(
    "/api/config",
    { cache: "no-store" },
    "Check AI availability",
    15_000,
  );
  if (typeof data?.live !== "boolean")
    throw new Error(
      "Could not check AI availability. Your walkthrough is saved in this browser. Retry, or create a manual report.",
    );
  return data;
}
async function request(path: string, body: BodyInit, headers?: HeadersInit) {
  const requestHeaders = new Headers(headers);
  const supabase = getSupabase();
  if (supabase) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session)
      throw new Error("Sign in again before processing this visit.");
    requestHeaders.set("Authorization", `Bearer ${session.access_token}`);
  }
  return serverRequest(
    path,
    { method: "POST", body, headers: requestHeaders },
    path === "/api/transcribe" ? "Transcribe audio" : "Prepare report",
  );
}
export async function transcribe(session: Session) {
  if (!session.audio?.size)
    throw new Error(
      "No finalized audio is available. Add a manual transcript or notes.",
    );
  const form = new FormData();
  form.append(
    "audio",
    session.audio,
    `walkthrough.${audioExtension(session.audio.type) || "bin"}`,
  );
  form.append("duration", String(session.duration));
  const encoded = new Request("http://localhost", {
    method: "POST",
    body: form,
  });
  if ((await encoded.arrayBuffer()).byteLength > LIMITS.requestBytes)
    throw new Error(
      "Audio exceeds the 3 MB request limit. Download the original and add a manual transcript; your recording is preserved.",
    );
  return transcriptSchema.parse(await request("/api/transcribe", form));
}
export async function prepareReport(session: Session) {
  const input: ReportInput = {
    language: session.language ?? "en",
    sessionId: session.id,
    projectId: session.projectId as ReportInput["projectId"],
    notes: session.notes,
    transcript: session.transcript ?? {
      text: "",
      segments: [],
      source: "manual",
    },
    photos: await Promise.all(
      session.photos.map(async (photo) => ({
        ...photoMetaSchema.parse(photo),
        dataUrl: await dataUrl(photo.modelBlob),
      })),
    ),
  };
  const body = JSON.stringify(input);
  if (new Blob([body]).size > LIMITS.requestBytes)
    throw new Error(
      "Report input exceeds the 3 MB limit. Shorten notes or remove photos and retry.",
    );
  const report = reportContentSchema.parse(
    await request("/api/report", body, { "Content-Type": "application/json" }),
  );
  return validateEvidence(report, input);
}

export async function translateReport(
  report: import("../shared/model").ReportContent,
) {
  const config = await getLiveConfig();
  if (!config.live)
    throw new Error(
      "English translation is not connected yet. Your original notes and photos are saved. Please retry once translation is connected.",
    );
  return reportContentSchema.parse(
    await request("/api/translate-report", JSON.stringify(report), {
      "Content-Type": "application/json",
    }),
  );
}
