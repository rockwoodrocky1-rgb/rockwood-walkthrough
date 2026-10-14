import { z } from "zod";
import { transcriptSchema, reportContentSchema } from "./model";

export const processingStatusSchema = z.object({
  id: z.uuid(),
  walkthrough_id: z.string(),
  source_revision: z.number().int().positive(),
  status: z.enum(["queued", "processing", "completed", "failed", "conflict", "cancelled"]),
  phase: z.enum(["queued", "transcribing", "reporting", "complete"]),
  last_error: z.string().nullable(),
  transcript: transcriptSchema.nullable(),
  report: reportContentSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProcessingStatus = z.infer<typeof processingStatusSchema>;
export const processingStatusColumns = "id,walkthrough_id,source_revision,status,phase,last_error,transcript,report,created_at,updated_at";
export const processingPending = (job?: ProcessingStatus | null) =>
  job?.status === "queued" || job?.status === "processing";
