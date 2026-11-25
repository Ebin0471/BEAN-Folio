/**
 * LAXII Cover Letter Studio — M33.5-D document schema.
 *
 * A cover letter is a DOCUMENT, not a resume summary. Validated shape per
 * spec §6.1. Honesty rules encoded in the schema itself:
 *  - `companyName` / `hiringContactName` are empty unless user-supplied or
 *    clearly extracted AND confirmed — the service never fills them;
 *  - `salutation` defaults to a neutral greeting labelled as a placeholder;
 *  - `aiTouched[]` provenance keys ("opening", "body:0", "closing") mark
 *    exactly which paragraphs the AI wrote/reworded — user edits are NOT
 *    labelled AI-generated;
 *  - body paragraphs are selectable text, never an image.
 */

import { z } from "zod";

export const COVER_LETTER_SCHEMA_VERSION = 1 as const;
export const COVER_LETTER_TONES = ["formal", "confident", "warm", "direct", "creative", "academic"] as const;
export type CoverLetterTone = (typeof COVER_LETTER_TONES)[number];
export const COVER_LETTER_LENGTHS = ["concise", "standard", "detailed"] as const;
export type CoverLetterLength = (typeof COVER_LETTER_LENGTHS)[number];

export const coverLetterBasicsSchema = z.object({
  name: z.string().max(120).default(""),
  email: z.string().max(160).default(""),
  phone: z.string().max(60).default(""),
  location: z.string().max(160).default(""),
  website: z.string().max(240).default(""),
});

export const coverLetterDataSchema = z.object({
  schemaVersion: z.literal(COVER_LETTER_SCHEMA_VERSION).default(COVER_LETTER_SCHEMA_VERSION),
  basics: coverLetterBasicsSchema.default({ name: "", email: "", phone: "", location: "", website: "" }),
  /** User-editable name for the library (e.g. "Acme — Senior PM — Nov 2026"). */
  label: z.string().max(120).default(""),
  targetRole: z.string().max(160).default(""),
  /** Empty unless user supplied or clearly extracted AND confirmed. */
  companyName: z.string().max(160).default(""),
  hiringContactName: z.string().max(160).default(""),
  /** User-selected or deterministic generation date — clearly editable. */
  date: z.string().max(40).default(""),
  salutation: z.string().max(120).default("Dear Hiring Manager"),
  opening: z.string().max(2000).default(""),
  bodyParagraphs: z.array(z.string().max(2400)).max(6).default([]),
  closing: z.string().max(600).default(""),
  signatureName: z.string().max(120).default(""),
  tone: z.enum(COVER_LETTER_TONES).default("formal"),
  /** Provenance: paragraph keys the AI produced/reworded. */
  aiTouched: z.array(z.string().max(12)).max(8).default([]),
  /** Linked resume conversation (owner-checked on every use). */
  sourceResumeConversationId: z.string().max(64).default(""),
  /** sha256 of the target JD when one was used (full text NOT stored by default). */
  jobDescriptionHash: z.string().max(64).default(""),
  /** Computed on save/generate; advisory only. */
  wordCount: z.number().int().nonnegative().default(0),
});

export type CoverLetterData = z.infer<typeof coverLetterDataSchema>;

export function emptyCoverLetter(): CoverLetterData {
  return coverLetterDataSchema.parse({});
}

/** Words across opening + body + closing (the letter proper). */
export function letterWordCount(data: CoverLetterData): number {
  const text = [data.opening, ...data.bodyParagraphs, data.closing].join(" ").trim();
  return text.length === 0 ? 0 : text.split(/\s+/).length;
}

/** Target body length per preset (guidance for the AI, not hard limits). */
export const LENGTH_TARGETS: Record<CoverLetterLength, { min: number; max: number; note: string }> = {
  concise: { min: 120, max: 180, note: "Three short paragraphs maximum — say the essential thing and stop." },
  standard: { min: 200, max: 300, note: "A focused one-page letter." },
  detailed: { min: 320, max: 450, note: "A fuller one-page letter — still no resume repetition." },
};

export const TONE_GUIDANCE: Record<CoverLetterTone, string> = {
  formal: "Formal, precise register; no contractions; measured enthusiasm.",
  confident: "Confident and direct; lead with the strongest relevant evidence.",
  warm: "Warm and human; collegial tone without fake familiarity.",
  direct: "Plain, economical sentences; zero filler; respect the reader's time.",
  creative: "A distinctive voice for design-forward roles — vivid but strictly factual.",
  academic: "Academic register: research interests, teaching and scholarly contributions, soberly stated.",
};

/** Paragraph provenance keys. */
export function letterParagraphKeys(data: CoverLetterData): string[] {
  return ["opening", ...data.bodyParagraphs.map((_, i) => `body:${i}`), "closing"];
}
