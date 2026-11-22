/**
 * LAXII — structured design brief (Phase 3, spec §2).
 *
 * RIISHE hands creative work to LAXII as a STRUCTURED brief — a versioned,
 * schema-validated object — never merely a shortened natural-language summary.
 * The human-readable paragraph remains available for display, but the banner
 * pipeline compiles its provider prompt DETERMINISTICALLY from these fields.
 *
 * Precedence rule (non-negotiable): the user's explicit request and exact
 * typography always win. Inferred portfolio preferences are guidance only and
 * are labelled as inferred in the compiled prompt. Portfolio context is built
 * exclusively from the signed-in user's own authorised data
 * (src/lib/intelligence/context.ts) — permission "self" is part of the schema
 * so a brief can never silently claim broader consent than it has.
 */

import { z } from "zod";

export const BRIEF_SCHEMA_VERSION = 1;

/** A rectangle in canvas pixels. */
export const rectSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type BriefRect = z.infer<typeof rectSchema>;

export const typographyItemSchema = z.object({
  /** EXACT text to render — never paraphrased, never re-spelled. */
  text: z.string().min(1).max(120),
  /** role headline | subtext | tagline | wordmark | cta */
  role: z.enum(["headline", "subtext", "tagline", "wordmark", "cta"]).default("headline"),
  /** sans | serif | mono — resolved to concrete locally-available fonts at render time. */
  font: z.enum(["sans", "serif", "mono"]).default("sans"),
  /** left | center | right within the safe area (default follows composition). */
  align: z.enum(["left", "center", "right"]).optional(),
  /** Requested text color as #rrggbb (contrast-checked at render time). */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type TypographyItem = z.infer<typeof typographyItemSchema>;

export const revisionSchema = z.object({
  area: z.enum([
    "subject", "background", "composition", "palette", "typography",
    "text-placement", "safe-area", "overall",
  ]),
  instruction: z.string().min(1).max(600),
  at: z.string(), // ISO timestamp
});
export type BriefRevision = z.infer<typeof revisionSchema>;

export const designBriefSchema = z.object({
  schemaVersion: z.literal(BRIEF_SCHEMA_VERSION),
  /** The user's exact creative request, verbatim (16,000-char composer budget). */
  request: z.string().min(1).max(16000),
  profession: z.string().max(200).nullable().default(null),
  targetAudience: z.string().max(400).nullable().default(null),

  /** Authorised portfolio context — own data only. */
  portfolio: z.object({
    permission: z.literal("self"),
    used: z.boolean(),
    /** Short factual notes (name, professions, key projects) — no private drafts without consent. */
    summary: z.array(z.string().max(240)).max(8).default([]),
  }),

  /** Existing visual identity facts (palette words, tone) — inferred guidance. */
  visualIdentity: z.object({
    toneWords: z.array(z.string().max(40)).max(6).default([]),
    notes: z.array(z.string().max(240)).max(4).default([]),
  }).default({ toneWords: [], notes: [] }),

  /** Design direction (RIISHE's professional recommendation — guidance). */
  direction: z.string().max(1200).default(""),

  subject: z.object({
    description: z.string().max(600).default(""),
    /** focalPoint: where the eye should land first. */
    focalPoint: z.string().max(300).default(""),
  }).default({ description: "", focalPoint: "" }),

  background: z.string().max(600).default(""),

  composition: z.object({
    hierarchy: z.string().max(300).default(""),
    /** Text block placement inside the safe area. */
    textPlacement: z.enum(["left", "center", "right"]).default("left"),
    notes: z.array(z.string().max(240)).max(4).default([]),
  }).default({ hierarchy: "", textPlacement: "left", notes: [] }),

  /** Palette as #rrggbb hex list (guidance to the model + text color source). */
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8).default([]),

  typography: z.object({
    items: z.array(typographyItemSchema).max(4).default([]),
    /** Optional deterministic note: e.g. "no additional decorative text". */
    notes: z.array(z.string().max(160)).max(3).default([]),
  }).default({ items: [], notes: [] }),

  /** Canvas truth — must match the authoritative BEAN Folio preset for banners. */
  canvas: z.object({
    presetSlug: z.string().min(1),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }),

  /** Fully-visible safe zone in canvas pixels (critical text/subjects inside). */
  safeArea: rectSchema,

  /** Owner media asset ids (already ownership-checked when loaded). */
  referenceMediaIds: z.array(z.string().min(1)).max(6).default([]),

  /** Elements that must be preserved from references / previous results. */
  preserve: z.array(z.string().max(200)).max(6).default([]),

  /** Elements to avoid (compiled into negative-prompt guidance). */
  avoid: z.array(z.string().max(200)).max(6).default([]),

  export: z.object({
    format: z.enum(["png", "jpeg", "webp"]).default("png"),
    exactDimensions: z.boolean().default(true),
  }).default({ format: "png", exactDimensions: true }),

  /** Bounded user-driven revisions after reviewing a result (max 3). */
  revisions: z.array(revisionSchema).max(3).default([]),

  /** Provenance: "RIISHE" = structured handoff, "USER" = compiled from the studio composer. */
  source: z.union([z.literal("RIISHE"), z.literal("USER")]),
  sourceTaskId: z.string().min(1),
  createdAt: z.string(),
});

export type DesignBrief = z.infer<typeof designBriefSchema>;
export type DesignBriefInput = z.input<typeof designBriefSchema>;

/** Parse + validate. Throws a plain Error with the first issue path on failure. */
export function parseDesignBrief(raw: unknown): DesignBrief {
  const parsed = designBriefSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    throw new Error(`Invalid design brief — ${where}${first?.message ?? "validation failed"}`);
  }
  return parsed.data;
}

/** Bounded revision append (spec: bounded iteration; max 3 enforced by schema too). */
export function appendRevision(brief: DesignBrief, area: BriefRevision["area"], instruction: string): DesignBrief {
  const revision: BriefRevision = { area, instruction: instruction.trim().slice(0, 600), at: new Date().toISOString() };
  return { ...brief, revisions: [...brief.revisions, revision].slice(-3) };
}

// ---------------------------------------------------------------------------
// Deterministic prompt compilation
// ---------------------------------------------------------------------------

function list(items: string[], bullet = "-"): string {
  return items.filter(Boolean).map((s) => `${bullet} ${s}`).join("\n");
}

/**
 * Compile the provider prompt for a brief-driven banner. Deterministic,
 * sectioned, and precedence-ordered: exact user request and exact typography
 * first; inferred guidance explicitly labelled; negative guidance last.
 *
 * When the brief carries typography, the compiled prompt instructs the model
 * to render the background WITHOUT any text — LAXII renders the exact text
 * deterministically afterwards (typography.ts). This is what makes spelling
 * fidelity verifiable instead of hoped for.
 */
export function compileBriefPrompt(brief: DesignBrief): string {
  const parts: string[] = [];

  parts.push(
    [
      "Professional banner production from an approved design brief.",
      `Authoritative creative request from the user (highest priority, follow exactly):`,
      brief.request,
    ].join("\n")
  );

  if (brief.typography.items.length > 0) {
    const lines = brief.typography.items.map((t) => `- role=${t.role} font=${t.font}${t.align ? ` align=${t.align}` : ""}: "${t.text}"`);
    parts.push(
      [
        "CRITICAL — typography is rendered separately in a deterministic pass:",
        "Do NOT paint, draw, spell or render ANY letters, words, numbers, logos with text,",
        "watermarks or typography of any kind in the image. Leave clean, uncluttered space where",
        "text will be placed (see text placement). The exact required text is listed for context only:",
        ...lines,
      ].join("\n")
    );
  }

  const subjectBits = [brief.subject.description, brief.subject.focalPoint && `Focal point: ${brief.subject.focalPoint}`].filter(Boolean);
  if (subjectBits.length) parts.push(`Subject:\n${list(subjectBits)}`);
  if (brief.background) parts.push(`Background / environment:\n- ${brief.background}`);

  const compBits = [
    brief.composition.hierarchy && `Visual hierarchy: ${brief.composition.hierarchy}`,
    ...brief.composition.notes,
  ].filter(Boolean);
  if (compBits.length) parts.push(`Composition:\n${list(compBits)}`);

  if (brief.palette.length) {
    parts.push(`Color palette (use these hues, harmonised): ${brief.palette.join(", ")}`);
  }
  if (brief.direction) parts.push(`Design direction (professional guidance):\n- ${brief.direction}`);

  if (brief.portfolio.used && brief.portfolio.summary.length) {
    parts.push(
      [
        "Inferred portfolio context (guidance only — never overrides the user's request above):",
        list(brief.portfolio.summary),
      ].join("\n")
    );
  }

  if (brief.preserve.length) {
    parts.push(`Preserve in the output (must remain recognizable):\n${list(brief.preserve)}`);
  }
  if (brief.avoid.length) {
    parts.push(`Strictly avoid:\n${list(brief.avoid.map((a) => a))}`);
  }

  parts.push(
    [
      `Output canvas: exactly ${brief.canvas.width}×${brief.canvas.height} px (ultra-wide banner).`,
      `Keep the entire composition — subject, key shapes, color weight — inside the vertical center`,
      `band of the frame with calm margins above and below; keep critical elements inside the`,
      `centered safe zone (${brief.safeArea.width}×${brief.safeArea.height} px).`,
      `Photorealistic lighting, coherent single scene, crisp focus, no frame edges visible,`,
      `full-bleed edge-to-edge composition.`,
    ].join("\n")
  );

  return parts.join("\n\n");
}

/**
 * Compile refinement addenda from ALL revisions (targeted revision flow) —
 * each addendum affects only its named area; the approved composition is
 * preserved outside it. Ordered oldest → newest.
 */
export function compileRevisionAddenda(brief: DesignBrief): string[] {
  const scope: Record<BriefRevision["area"], string> = {
    subject: "Adjust the SUBJECT only (pose/wardrobe/props/likeness context) — keep composition, background and palette.",
    background: "Adjust the BACKGROUND / environment only — keep the subject and all other elements.",
    composition: "Adjust the overall COMPOSITION / layout only — keep the subject's identity and the palette.",
    palette: "Adjust the COLOR PALETTE treatment only — keep subject, layout and all elements.",
    typography: "Typography note (affects the deterministic text pass, not the painted scene).",
    "text-placement": "Text placement note (affects the deterministic text pass, not the painted scene).",
    "safe-area": "Safe-area note: pull critical content further inside the centered safe zone.",
    overall: "General refinement of the whole scene — preserve the approved concept and identity.",
  };
  return brief.revisions.map(
    (r, i) => [
      `Targeted refinement (revision ${i + 1}/${brief.revisions.length}) — ${scope[r.area]}`,
      `Change requested by the user: ${r.instruction}`,
      `Everything not named above must stay as close to the approved composition as possible.`,
    ].join("\n")
  );
}

/** Placement area for the deterministic text layer (per composition rules). */
export function resolveTextPlacement(brief: DesignBrief): "left" | "center" | "right" {
  const withAlign = brief.typography.items.find((t) => t.align);
  return withAlign?.align ?? brief.composition.textPlacement;
}
