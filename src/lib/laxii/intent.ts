/**
 * LAXII — Conversational Creative Intelligence (Phase 3).
 *
 * LAXII must understand a CONVERSATION, not treat every message as an
 * unrelated generation request. This service:
 *   1. classifies the user's intent (structured data, not keyword guessing —
 *      an LLM classifier runs first, deterministic rules remain the honest
 *      fallback when the text gateway is unavailable),
 *   2. resolves version references ("make the SECOND one brighter" → the
 *      2nd version of the latest result),
 *   3. compiles the change-scope into an edit instruction with explicit
 *      preservation directives so follow-ups modify exactly what was asked,
 *   4. builds the compact conversation-context brief that stateless
 *      providers receive (providers with native conversation state, like
 *      Gemini's previous_interaction_id, get the real thing instead).
 *
 * The classifier NEVER changes pixels or routes around capability checks —
 * it only decides WHAT the engine should do; the router still refuses what
 * the selected provider cannot honestly deliver.
 */

import { aiComplete, parseJsonFromText, AiProviderError } from "@/lib/ai";

import type { LaxiiOperation } from "./types";

export type LaxiiIntentKind =
  | "NEW_IMAGE"
  | "EDIT_CURRENT"
  | "REGION_EDIT"
  | "REPLACE_OBJECT"
  | "REMOVE_OBJECT"
  | "CHANGE_BACKGROUND"
  | "CHANGE_CLOTHING"
  | "CHANGE_LIGHTING"
  | "CHANGE_COLOR"
  | "CHANGE_COMPOSITION"
  | "EXTEND_CANVAS"
  | "VARIATIONS"
  | "UPSCALE"
  | "REMOVE_BACKGROUND"
  | "COMBINE_REFERENCES"
  | "EDIT_VERSION"
  | "UNKNOWN";

export interface LaxiiIntent {
  kind: LaxiiIntentKind;
  /** Normalized engine operation the intent resolves to. */
  operation: LaxiiOperation;
  /** 1-based reference to a specific earlier version ("the second one"). */
  versionHint: number | null;
  /** Requested output count when phrased in words ("give me four versions"). */
  countHint: number | null;
  /** Short machine-readable description of the requested change. */
  changeScope: string;
  /** What the edit must preserve (subject identity, framing, …). */
  preserve: string[];
  confidence: number;
  source: "llm" | "rules";
}

export interface IntentTurnSummary {
  userText: string;
  operation: string | null;
}

export interface IntentContext {
  prompt: string;
  conversationKind: string; // IMAGE | BANNER | AVATAR
  hasParentImage: boolean;
  /** How many versions the latest assistant result produced (1–4). */
  lastResultVersions: number;
  referenceCount: number;
  /** Recent turns oldest→newest (already capped by the caller). */
  recentTurns: IntentTurnSummary[];
}

const INTENT_KINDS: LaxiiIntentKind[] = [
  "NEW_IMAGE",
  "EDIT_CURRENT",
  "REGION_EDIT",
  "REPLACE_OBJECT",
  "REMOVE_OBJECT",
  "CHANGE_BACKGROUND",
  "CHANGE_CLOTHING",
  "CHANGE_LIGHTING",
  "CHANGE_COLOR",
  "CHANGE_COMPOSITION",
  "EXTEND_CANVAS",
  "VARIATIONS",
  "UPSCALE",
  "REMOVE_BACKGROUND",
  "COMBINE_REFERENCES",
  "EDIT_VERSION",
  "UNKNOWN",
];

/** Engine operation each intent normalizes to. */
function operationForKind(kind: LaxiiIntentKind): LaxiiOperation {
  switch (kind) {
    case "VARIATIONS":
      return "VARIATIONS";
    case "UPSCALE":
      return "UPSCALE";
    case "REMOVE_BACKGROUND":
      return "REMOVE_BACKGROUND";
    case "EXTEND_CANVAS":
      return "EXPAND";
    case "NEW_IMAGE":
    case "COMBINE_REFERENCES":
    case "UNKNOWN":
      return "GENERATE";
    default:
      // EDIT_CURRENT / REGION_EDIT / REPLACE_OBJECT / REMOVE_OBJECT /
      // CHANGE_BACKGROUND / CHANGE_CLOTHING / CHANGE_LIGHTING /
      // CHANGE_COLOR / CHANGE_COMPOSITION / EDIT_VERSION
      return "EDIT";
  }
}

const ORDINALS: Record<string, number> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  fifth: 5,
  "5th": 5,
};

/** Parse "the second one" / "version 2" / "the 3rd image" → 1-based index. */
export function parseVersionHint(prompt: string): number | null {
  const word = prompt.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/i);
  if (word) return ORDINALS[word[1].toLowerCase()] ?? null;
  const numeric = prompt.match(/\b(?:version|option|variant|image|one)\s*#?\s*(\d)\b/i);
  if (numeric) {
    const n = Number(numeric[1]);
    if (n >= 1 && n <= 9) return n;
  }
  return null;
}

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

/** Parse "give me four different versions" / "3 variations" → 2–5. */
export function parseCountHint(prompt: string): number | null {
  const m = prompt.match(
    /\b(one|two|three|four|five|2|3|4|5)\s+(?:different\s+|fresh\s+|new\s+)?(?:versions?|variations?|options?|takes?|alternatives?|renders?|images?)\b/i
  );
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const n = COUNT_WORDS[raw] ?? Number(raw);
  return n >= 2 && n <= 5 ? Math.min(n, 4) : null;
}

const RULES: { pattern: RegExp; kind: LaxiiIntentKind }[] = [
  { pattern: /\b(variations?|another version|different versions?|more versions?|alternatives?|other versions?|give me (two|three|four|2|3|4)|re-?roll|try again with variety)\b/i, kind: "VARIATIONS" },
  { pattern: /\b(upscale|up-?scale|higher resolution|sharpen|sharper|more detail(ed)?|enhance (the )?(quality|detail|resolution))\b/i, kind: "UPSCALE" },
  { pattern: /\b(remove|delete|erase|cut out|drop)\s+(the\s+)?background\b|\btransparent background\b|\bno background\b|\bisolate (the|him|her|them|it)\b/i, kind: "REMOVE_BACKGROUND" },
  { pattern: /\b(extend|widen|expand|outpaint|make (it|the (canvas|image|scene)) (wider|taller|bigger canvas))\b/i, kind: "EXTEND_CANVAS" },
  { pattern: /\b(background|backdrop|scenery behind|scene behind)\b/i, kind: "CHANGE_BACKGROUND" },
  { pattern: /\b(remove|delete|erase|get rid of|take out)\b/i, kind: "REMOVE_OBJECT" },
  { pattern: /\b(outfit|clothes|clothing|suit|jacket|shirt|dress|tuxedo|hoodie|wear|wearing|dress(ed)? in|costume|attire)\b/i, kind: "CHANGE_CLOTHING" },
  { pattern: /\b(replace|swap|change|add|put|give)\b/i, kind: "REPLACE_OBJECT" },
  { pattern: /\b(lighting|light|brighter|darker|dim|moody|dramatic light|golden hour|neon light|glow|shadow)\b/i, kind: "CHANGE_LIGHTING" },
  { pattern: /\b(colou?r|tone|grading|palette|black[- ]and[- ]white|saturat|vibrant|warmer|cooler|tint)\b/i, kind: "CHANGE_COLOR" },
  { pattern: /\b(zoom|crop|closer|wider angle|angle|framing|composition|reposition|repose|pose|tilt|perspective)\b/i, kind: "CHANGE_COMPOSITION" },
  { pattern: /\b(combine|merge|blend|mix)\b.*\b(images?|photos?|pictures?|references?|them|both|all)\b/i, kind: "COMBINE_REFERENCES" },
];

/** Deterministic fallback classifier — always available, zero external deps. */
function classifyByRules(ctx: IntentContext): LaxiiIntent {
  const prompt = ctx.prompt.trim();
  const versionHint = parseVersionHint(prompt);

  if (prompt) {
    for (const rule of RULES) {
      if (rule.pattern.test(prompt)) {
        // A specific version reference on top of an edit intent → EDIT_VERSION
        // (continue from that version), resolved server-side against the
        // latest result's versions.
        if (versionHint && operationForKind(rule.kind) === "EDIT") {
          return { kind: "EDIT_VERSION", operation: "EDIT", versionHint, countHint: parseCountHint(prompt), changeScope: prompt, preserve: ["subject identity", "overall style"], confidence: 0.6, source: "rules" };
        }
        return { kind: rule.kind, operation: operationForKind(rule.kind), versionHint, countHint: parseCountHint(prompt), changeScope: prompt, preserve: defaultPreserve(rule.kind), confidence: 0.55, source: "rules" };
      }
    }
  }

  if (ctx.hasParentImage) {
    return { kind: "EDIT_CURRENT", operation: "EDIT", versionHint, countHint: parseCountHint(prompt), changeScope: prompt || "refine the current image", preserve: ["subject identity", "composition", "style"], confidence: 0.5, source: "rules" };
  }
  if (ctx.referenceCount > 0) {
    return { kind: "COMBINE_REFERENCES", operation: "GENERATE", versionHint: null, countHint: parseCountHint(prompt), changeScope: prompt || "compose from the attached references", preserve: [], confidence: 0.5, source: "rules" };
  }
  return { kind: prompt ? "NEW_IMAGE" : "UNKNOWN", operation: "GENERATE", versionHint: null, countHint: parseCountHint(prompt), changeScope: prompt, preserve: [], confidence: 0.5, source: "rules" };
}

function defaultPreserve(kind: LaxiiIntentKind): string[] {
  switch (kind) {
    case "CHANGE_BACKGROUND":
      return ["the subject exactly as-is (pixels, pose, clothing, identity)"];
    case "CHANGE_CLOTHING":
      return ["face, hair, body proportions, pose and identity"];
    case "CHANGE_LIGHTING":
    case "CHANGE_COLOR":
      return ["subject identity, composition and framing"];
    case "REMOVE_OBJECT":
      return ["everything except the removed object"];
    case "REPLACE_OBJECT":
      return ["subject identity and overall composition"];
    case "UPSCALE":
      return ["every pixel of content exactly as-is"];
    default:
      return ["subject identity", "composition", "style"];
  }
}

const CLASSIFIER_SYSTEM = `You are the intent classifier inside LAXII, a conversational AI image studio.
Classify the user's LATEST message into exactly one intent kind:

- NEW_IMAGE: an unrelated new creation.
- COMBINE_REFERENCES: create a new image by combining/using the attached reference images.
- EDIT_CURRENT: modify the currently selected image.
- EDIT_VERSION: modify a SPECIFIC earlier version referenced in words ("the second one", "version 3").
- REPLACE_OBJECT / REMOVE_OBJECT: add/swap vs. delete something in the current image.
- CHANGE_BACKGROUND / CHANGE_CLOTHING / CHANGE_LIGHTING / CHANGE_COLOR / CHANGE_COMPOSITION / REGION_EDIT: scoped edits of the current image.
- EXTEND_CANVAS: outpaint / expand the canvas.
- VARIATIONS: several genuinely different takes of the current image.
- UPSCALE: fidelity/detail increase only.
- REMOVE_BACKGROUND: isolate the subject on a clean background.
- UNKNOWN: unclear; the engine will fall back safely.

Return ONLY compact JSON, no prose:
{"kind":"<KIND>","version_hint":null|<1-based number>,"count_hint":null|<2-4 when the user asks for several versions in words>,"change_scope":"<short phrase>","preserve":["<what must stay unchanged>"],"confidence":<0..1>}`;

interface ClassifierJson {
  kind?: string;
  version_hint?: number | null;
  count_hint?: number | null;
  change_scope?: string;
  preserve?: string[];
  confidence?: number;
}

/**
 * Classify one conversational turn. The LLM classifier runs first (fast,
 * low temperature); ANY failure — gateway down, timeout, malformed JSON,
 * unknown kind — falls back to the deterministic rules classifier. The
 * result is structured intent data either way; keyword matching is the
 * safety net, never the primary path.
 */
export async function classifyLaxiiIntent(ctx: IntentContext): Promise<LaxiiIntent> {
  const fallback = classifyByRules(ctx);
  const prompt = ctx.prompt.trim();
  if (!prompt) return fallback;

  const conversationLines = ctx.recentTurns
    .slice(-6)
    .map((t, i) => `${i + 1}. user: "${t.userText.slice(0, 120)}" → assistant: ${t.operation ?? "result"}`)
    .join("\n");

  const situation = [
    `Conversation kind: ${ctx.conversationKind}.`,
    `A selected image exists for editing: ${ctx.hasParentImage ? "YES" : "NO"}.`,
    `The latest result produced ${ctx.lastResultVersions} version(s).`,
    `Attached reference images: ${ctx.referenceCount}.`,
    conversationLines ? `Recent turns:\n${conversationLines}` : "This is the first turn.",
    `Latest user message: "${prompt.slice(0, 500)}"`,
  ].join("\n");

  try {
    const { text } = await aiComplete(CLASSIFIER_SYSTEM, [{ role: "user", content: situation }], {
      temperature: 0.1,
      timeoutMs: 12_000,
    });
    const parsed = parseJsonFromText<ClassifierJson>(text);
    if (!parsed || !parsed.kind) return fallback;
    const kind = parsed.kind.toUpperCase() as LaxiiIntentKind;
    if (!INTENT_KINDS.includes(kind)) return fallback;

    const operation = operationForKind(kind);
    const llmHint =
      typeof parsed.version_hint === "number" && parsed.version_hint >= 1 && parsed.version_hint <= 9
        ? Math.floor(parsed.version_hint)
        : null;
    const versionHint = llmHint ?? (operation === "EDIT" ? parseVersionHint(prompt) : null);
    const countHint =
      typeof parsed.count_hint === "number" && parsed.count_hint >= 2 && parsed.count_hint <= 4
        ? Math.floor(parsed.count_hint)
        : parseCountHint(prompt);
    if (versionHint && operation === "EDIT" && kind !== "EDIT_VERSION") {
      // Referencing a version by words IS the version-continuation intent.
      return {
        kind: "EDIT_VERSION",
        operation: "EDIT",
        versionHint,
        countHint,
        changeScope: parsed.change_scope?.slice(0, 300) || prompt,
        preserve: Array.isArray(parsed.preserve) ? parsed.preserve.slice(0, 5).map(String) : defaultPreserve(kind),
        confidence: Math.min(Math.max(parsed.confidence ?? 0.75, 0), 1),
        source: "llm",
      };
    }
    return {
      kind,
      operation,
      versionHint,
      countHint,
      changeScope: parsed.change_scope?.slice(0, 300) || prompt,
      preserve: Array.isArray(parsed.preserve) ? parsed.preserve.slice(0, 5).map(String) : defaultPreserve(kind),
      confidence: Math.min(Math.max(parsed.confidence ?? 0.75, 0), 1),
      source: "llm",
    };
  } catch (e) {
    if (!(e instanceof AiProviderError)) {
      console.error("[laxii] intent classifier failure:", e instanceof Error ? e.message : e);
    }
    return fallback;
  }
}

/**
 * Compile the intent into the final edit instruction: the user's words plus
 * explicit preservation directives, so the provider changes ONLY what was
 * asked and never silently reinterprets the rest of the image.
 */
export function compileEditInstruction(intent: LaxiiIntent, userPrompt: string): string {
  const preserve = intent.preserve.length > 0 ? intent.preserve.join("; ") : "subject identity, composition and overall style";
  const scope = intent.changeScope || userPrompt || "apply the requested refinement";

  const kindDirectives: Partial<Record<LaxiiIntentKind, string>> = {
    CHANGE_BACKGROUND: "Replace ONLY the background/environment. The subject must stay pixel-faithful: same identity, pose, clothing and edges. Do not regenerate the subject.",
    CHANGE_CLOTHING: "Change only the clothing/outfit as described. Keep the face, hair, body proportions, pose and identity identical to the original.",
    CHANGE_LIGHTING: "Adjust only the lighting as described. Keep the subject, composition, framing and content unchanged.",
    CHANGE_COLOR: "Adjust only the colours/grading as described. Keep the subject, composition and all elements unchanged.",
    REPLACE_OBJECT: "Replace/add the described element naturally — match the original perspective, lighting direction, shadows and grain so it looks native to the photo.",
    REMOVE_OBJECT: "Remove the described element and fill the area plausibly with the surrounding scene. Change nothing else.",
    REGION_EDIT: "Apply the change only within the described region. Preserve all unselected regions as closely as the model permits.",
    UPSCALE: "Increase detail and fidelity only — no reinterpretation.",
    EDIT_VERSION: "Continue editing from the referenced earlier version.",
  };

  const directive = kindDirectives[intent.kind];
  return [
    directive ? `Edit the current image. ${directive}` : "Edit the current image as described.",
    `Requested change: ${scope}`,
    `Strictly preserve: ${preserve}.`,
    "Do not reinterpret or restyle anything the user did not ask to change.",
  ].join("\n");
}

/**
 * Build the compact conversation-context brief appended statelessly for
 * providers without native conversation state. Deliberately SHORT (context,
 * not a transcript) and never a replacement for the user's actual
 * instruction. Providers WITH native state (Gemini interactions) skip this.
 */
export function buildConversationContext(
  turns: IntentTurnSummary[],
  currentImage: { prompt: string | null; operation: string | null; lineageDepth: number } | null
): string | undefined {
  const lines: string[] = [];
  const recent = turns.slice(-5);
  if (recent.length > 0) {
    lines.push("Conversation so far:");
    recent.forEach((t, i) => {
      lines.push(`${i + 1}. User asked: "${t.userText.slice(0, 100)}" → you produced a ${t.operation?.toLowerCase() ?? "generation"} result.`);
    });
  }
  if (currentImage) {
    lines.push(
      `The image being edited is the user's currently selected version (generation #${currentImage.lineageDepth + 1} in its lineage)` +
        (currentImage.prompt ? `, originally created from: "${currentImage.prompt.slice(0, 160)}"` : "") +
        (currentImage.operation && currentImage.operation !== "GENERATE" ? `, last modified via ${currentImage.operation.toLowerCase()}` : "") +
        "."
    );
  }
  const text = lines.join("\n").trim();
  return text.length > 0 ? text : undefined;
}
