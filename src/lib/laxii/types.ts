/**
 * LAXII — conversational AI image studio.
 * Shared provider-agnostic types and the capability registry.
 *
 * Architecture rule: product code NEVER imports a provider SDK directly —
 * everything goes through LaxiiEngine (router.ts) with these types, so the
 * active provider can be swapped by env config without touching callers.
 * A provider that cannot honestly deliver an operation must declare it
 * unsupported in its capability entry; the engine refuses the request instead
 * of silently degrading it (no fake generations, ever).
 */

export type LaxiiProviderId = "managed" | "gemini" | "openai" | "diffusers";

export const LAXII_OPERATIONS = [
  "GENERATE",
  "EDIT",
  "VARIATIONS",
  "UPSCALE",
  "REMOVE_BACKGROUND",
  "EXPAND",
  "BANNER",
] as const;
export type LaxiiOperation = (typeof LAXII_OPERATIONS)[number];

/**
 * Chat-facing REQUEST operations. "REMOVE_BG" and "OUTPAINT" are conversational
 * aliases of the engine operations REMOVE_BACKGROUND and EXPAND: the planner
 * records the user-facing term on the message while normalizing the actual
 * engine call (see conversations.ts planTurn → engineOperation).
 */
export type LaxiiRequestOperation = LaxiiOperation | "REMOVE_BG" | "OUTPAINT";

/**
 * Client-facing operation set. "AUTO" is the conversational default: the
 * server classifies the user's intent (Phase 3) and normalizes it to a real
 * engine operation BEFORE anything reaches the provider registry.
 */
export type LaxiiClientOperation = LaxiiOperation | "AUTO";

/** Aspect ratios every provider request is normalized to. */
export const LAXII_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export type LaxiiAspect = (typeof LAXII_ASPECTS)[number];

export interface LaxiiReferenceImage {
  /** Data URL (data:image/...;base64,…) of a reference image. */
  dataUrl: string;
  mime: string;
  /** Optional short hint describing the role of this reference. */
  label?: string;
}

export interface LaxiiImageRequest {
  operation: LaxiiOperation;
  prompt: string;
  /** Reference images (style/product/composition) — provider-dependent limits. */
  references?: LaxiiReferenceImage[];
  /** Base image for edit-style operations (data URL). */
  baseImage?: LaxiiReferenceImage;
  aspect: LaxiiAspect;
  /** Number of distinct outputs requested (variants). */
  count: number;
  /** Transparent PNG requested (provider-dependent). */
  transparent?: boolean;
  /** Provider-native resolution bucket for providers that support it. */
  quality?: "1K" | "2K" | "4K";
  /**
   * Gemini Interactions API: continue natively from a stored interaction id
   * (true multi-turn state) instead of re-sending pixels. Providers that do
   * not support native conversation state must ignore this field.
   */
  previousInteractionId?: string;
  /**
   * Compact conversation-context brief appended statelessly for providers
   * without native conversation state (managed / openai / diffusers, and
   * gemini when its interaction state has expired). Never a substitute for
   * the user's actual instruction.
   */
  conversationContext?: string;
}

export interface LaxiiGeneratedImage {
  /** Raw bytes of the generated image. */
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
}

export interface LaxiiGenerationResult {
  images: LaxiiGeneratedImage[];
  provider: LaxiiProviderId;
  /** Exact model id the provider reported/used. */
  model: string;
  warnings: string[];
  /**
   * Per-image provider interaction/conversation identifiers (index-aligned
   * with `images`). Enables native multi-turn continuation on providers that
   * support it (Gemini Interactions API). Absent for stateless providers.
   */
  interactionIds?: string[];
}

export interface LaxiiProviderCapability {
  supported: boolean;
  /** Max reference images accepted per request. */
  maxReferences?: number;
  /** Max output images per request (0/absent = single output per call). */
  maxVariantsPerCall?: number;
  /** Transparent background support. */
  transparent?: boolean;
  /** Native resolution buckets. */
  sizes?: string[];
  /** Human explanation surfaced in the UI when unsupported. */
  note?: string;
}

export interface LaxiiProviderInfo {
  id: LaxiiProviderId;
  label: string;
  /** Whether this provider is usable right now (credentials present). */
  available: boolean;
  /** Default model id (env-overridable). */
  model: string;
  capabilities: {
    generate: LaxiiProviderCapability;
    edit: LaxiiProviderCapability;
    variations: LaxiiProviderCapability;
    upscale: LaxiiProviderCapability;
    removeBackground: LaxiiProviderCapability;
    expand: LaxiiProviderCapability;
  };
  aspects: readonly LaxiiAspect[];
}

export class LaxiiProviderError extends Error {
  /** Machine-readable cause: timeout | safety | auth | rate_limit | provider | invalid_output */
  reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "LaxiiProviderError";
    this.reason = reason;
  }
}

export class LaxiiCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaxiiCapabilityError";
  }
}

/**
 * User-safe operational error for the LAXII engine. The message is written to
 * be shown to the user verbatim — routes map it to a 400 response. Restored:
 * engine/pipeline/conversations modules and their routes import it; its
 * removal from this module left those imports unresolvable at runtime (all
 * consumers were written against this contract).
 */
export class LaxiiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaxiiError";
  }
}

/** Provider claim of support, checked before dispatch. */
export function requireCapability(info: LaxiiProviderInfo, op: LaxiiOperation): LaxiiProviderCapability {
  const key =
    op === "GENERATE"
      ? "generate"
      : op === "EDIT"
        ? "edit"
        : op === "VARIATIONS"
          ? "variations"
          : op === "UPSCALE"
            ? "upscale"
            : op === "REMOVE_BACKGROUND"
              ? "removeBackground"
              : "expand";
  const cap = info.capabilities[key];
  if (!cap || !cap.supported) {
    throw new LaxiiCapabilityError(
      cap?.note ?? `The active image provider does not support "${op.toLowerCase()}".`
    );
  }
  return cap;
}
