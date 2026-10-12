import { z } from "zod";
export const languageSchema = z.enum(["en", "es"]);
export type Language = z.infer<typeof languageSchema>;
export const participantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z
    .string()
    .trim()
    .max(32)
    .regex(/^\+?[0-9 ().-]+$/)
    .transform((value) => value.replace(/[ ().-]/g, ""))
    .refine((value) => /^\+?[0-9]{7,15}$/.test(value)),
});
export type Participant = z.infer<typeof participantSchema>;
