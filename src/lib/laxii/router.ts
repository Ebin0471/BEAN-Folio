/**
 * LAXII engine — provider router and capability registry.
 *
 * Selection: LAXII_DEFAULT_PROVIDER (managed | gemini | openai). A provider is
 * only usable when its credentials are present; otherwise the engine falls
 * back to the managed gateway. Callers can pin a provider per request; the
 * engine refuses pinned-but-unconfigured providers instead of silently
 * substituting (the user must always know which engine produced an image).
 *
 * Every operation runs through: capability check → real provider call →
 * output validation → deterministic post-processing (aspect crop,
 * transparency extraction) — in that order. No stage may fake a result.
 */

import {
  LaxiiCapabilityError,
  LaxiiProviderError,
  requireCapability,
  type LaxiiAspect,
  type LaxiiGeneratedImage,
  type LaxiiGenerationResult,
  type LaxiiImageRequest,
  type LaxiiOperation,
  type LaxiiProviderId,
  type LaxiiProviderInfo,
} from "./types";
import { managedGenerate, managedProvider } from "./providers/managed";
import { geminiConfigured, geminiGenerate, geminiModel, geminiProvider } from "./providers/gemini";
import { openaiConfigured, openaiGenerate, openaiModel, openaiProvider } from "./providers/openai";
import { diffusersConfigured, diffusersGenerate, diffusersModel, diffusersProvider } from "./providers/diffusers";
import { cropToAspect, extractTransparency, composeReferenceSheet, prepareExpandCanvas, type ExactAspect } from "./image-ops";
import { validateGeneratedImage } from "./validate";
import { isTransientProviderError, recordProviderFailure, recordProviderSuccess } from "@/lib/intelligence/circuit";
import { laxiiRegistryId } from "@/lib/intelligence/registry";

function buildRegistry(): LaxiiProviderInfo[] {
  const gemini: LaxiiProviderInfo = {
    ...geminiProvider,
    available: geminiConfigured(),
    model: geminiModel(),
  };
  const openai: LaxiiProviderInfo = {
    ...openaiProvider,
    available: openaiConfigured(),
    model: openaiModel(),
  };
  const diffusers: LaxiiProviderInfo = {
    ...diffusersProvider,
    available: diffusersConfigured(),
    model: diffusersModel(),
  };
  return [managedProvider, gemini, openai, diffusers];
}

/**
 * LAXII V1 — the single user-facing image engine.
 *
 * Product identity rule: every user-facing surface offers exactly ONE image
 * engine, "LAXII V1", which is backed by the managed gateway provider
 * (server-side; no user-selectable backend). Alternate provider integrations
 * (gemini/openai/diffusers) remain internal plumbing — they are never offered
 * as engine choices, and user requests that pin them are refused (never
 * silently rerouted).
 */
export const LAXII_V1_PROVIDER: LaxiiProviderId = "managed";

export const LAXII_V1_UNAVAILABLE_MESSAGE =
  "LAXII V1 is not configured on this deployment, so image generation is unavailable. Nothing was generated — no other engine was used.";

/** The single user-facing engine descriptor (drives the studio UI + status). */
export function laxiiV1Engine(): {
  id: "laxii-v1";
  label: "LAXII V1";
  provider: LaxiiProviderId;
  model: string;
  available: boolean;
  note: string;
} {
  const managed = managedProvider;
  const available = managedProvider.available;
  return {
    id: "laxii-v1",
    label: "LAXII V1",
    provider: managed.id,
    model: managed.model,
    available,
    note: available
      ? "The managed image engine renders on BEAN's servers — no key or setup required."
      : LAXII_V1_UNAVAILABLE_MESSAGE,
  };
}

/** Public capability registry (drives the UI: only offer supported actions). */
export function laxiiCapabilities(): {
  defaultProvider: LaxiiProviderId;
  providers: LaxiiProviderInfo[];
  engine: ReturnType<typeof laxiiV1Engine>;
} {
  const providers = buildRegistry();
  const engine = laxiiV1Engine();
  return {
    // The user-facing engine is always LAXII V1 (managed gateway) — the
    // default below must match what resolveProvider() actually dispatches to.
    defaultProvider: LAXII_V1_PROVIDER,
    providers,
    engine,
  };
}

/**
 * Resolve the provider for one engine run.
 *
 * User-facing rule (LAXII V1): requests that arrive with an explicit engine
 * pin must target the managed gateway ("LAXII V1"'s backing provider). Any
 * other pinned id is REFUSED — never silently rerouted to another model.
 * Unpinned requests resolve to the managed gateway first (the LAXII V1
 * engine); internal callers that pass no pin can never fall through to an
 * alternate provider while the managed engine is available.
 */
function resolveProvider(pinned?: LaxiiProviderId): LaxiiProviderInfo {
  const providers = buildRegistry();
  if (pinned) {
    if (pinned !== LAXII_V1_PROVIDER) {
      throw new LaxiiCapabilityError(
        "LAXII V1 is the only available image engine. The requested engine is not offered — nothing was generated."
      );
    }
    const found = providers.find((p) => p.id === pinned);
    if (!found) throw new LaxiiCapabilityError(`Unknown image provider "${pinned}".`);
    if (!found.available) {
      throw new LaxiiCapabilityError(LAXII_V1_UNAVAILABLE_MESSAGE);
    }
    return found;
  }
  const managed = providers.find((p) => p.id === LAXII_V1_PROVIDER);
  if (managed?.available) return managed;
  // Managed gateway unavailable AND no pin: refuse honestly instead of
  // silently producing the image with a different model than promised.
  throw new LaxiiCapabilityError(LAXII_V1_UNAVAILABLE_MESSAGE);
}

const OPERATION_PROMPTS: Record<"VARIATIONS" | "UPSCALE" | "REMOVE_BACKGROUND" | "EXPAND", string> = {
  VARIATIONS:
    "Create a fresh variation of this image: keep the subject, style and overall composition recognizable, but change the composition details (lighting, color accents, angle, mood) enough to feel like a genuinely different take.",
  UPSCALE:
    "Recreate this exact image with enhanced detail, sharpness and clarity at a higher resolution. Preserve the composition, subject identity, colors and every element exactly as they are — do not add, remove or move anything. This is a fidelity upgrade, not a reinterpretation.",
  REMOVE_BACKGROUND:
    "Isolate the main subject of this image and replace the entire background with a single uniform pure white background (#FFFFFF). Keep the subject's edges crisp and complete — include every part of the subject, change nothing about the subject itself. No shadows, no ground, no props, no gradient — only the subject on flat white.",
  EXPAND:
    "The framed area of this canvas contains the original image; the surrounding transparent margins are empty. Extend the scene outward naturally: continue the environment, lighting, colors and style seamlessly into the margins so the result looks like one coherent, wider original photograph. Never distort, stretch or duplicate the original framed content.",
};

/** Estimated per-image API cost in USD (documented estimates, not billing data). */
function estimateUnitCost(provider: LaxiiProviderId, model: string, quality?: string): number {
  if (provider === "managed" || provider === "diffusers") return 0; // managed gateway + local hardware: no metered API cost
  if (provider === "gemini") {
    const q = quality ?? "1K";
    if (model.startsWith("gemini-3-pro-image")) return q === "4K" ? 0.24 : 0.134;
    if (model.startsWith("gemini-3.1-flash-image")) return q === "4K" ? 0.151 : q === "2K" ? 0.101 : 0.067;
    return q === "4K" ? 0.113 : q === "2K" ? 0.0504 : 0.0336; // nano-banana-2.1 family
  }
  // openai (approximate per-image list-price estimate by fidelity tier)
  const tier = quality === "4K" || quality === "2K" ? "high" : "medium";
  if (model.includes("mini")) return tier === "high" ? 0.036 : 0.011;
  return tier === "high" ? 0.167 : 0.042;
}

export interface EngineRunOptions {
  provider?: LaxiiProviderId;
  quality?: "1K" | "2K" | "4K";
}

/**
 * Run one LAXII operation end-to-end. Returns validated images with their
 * true pixel dimensions plus an honest cost estimate.
 */
export async function runLaxiiOperation(
  req: LaxiiImageRequest,
  opts: EngineRunOptions = {}
): Promise<LaxiiGenerationResult & { estimatedCostUsd: number; durationMs: number }> {
  const provider = resolveProvider(opts.provider);
  const cap = requireCapability(provider, req.operation);
  const warnings: string[] = [];

  // Validate reference budget before spending provider quota.
  const refs = req.references ?? [];
  if (cap.maxReferences !== undefined && refs.length > cap.maxReferences) {
    throw new LaxiiCapabilityError(
      `${provider.label} accepts at most ${cap.maxReferences} reference image${cap.maxReferences === 1 ? "" : "s"} per request.`
    );
  }

  let providerReq: LaxiiImageRequest = { ...req, quality: opts.quality ?? req.quality };

  // Managed provider takes ONE image per call — compose multi-reference briefs
  // into a single contact sheet (a real composite the model can read).
  if (provider.id === "managed" && refs.length > 1) {
    const primary = refs[0];
    const sheet = await composeReferenceSheet(refs.map((r) => r.dataUrl));
    if (req.baseImage) {
      providerReq = { ...providerReq, baseImage: { ...req.baseImage }, references: [{ ...primary, dataUrl: sheet, label: "reference sheet" }] };
    } else {
      providerReq = { ...providerReq, references: [{ dataUrl: sheet, mime: "image/png", label: "reference sheet" }] };
    }
    warnings.push("References were combined into a single contact sheet for this engine.");
  }

  // Operation-specific prompt assembly.
  let prompt = req.prompt;
  let baseImage = providerReq.baseImage;
  let transparentRequest = Boolean(req.transparent) && Boolean(cap.transparent);

  if (req.operation === "VARIATIONS") {
    prompt = `${OPERATION_PROMPTS.VARIATIONS}\n\n${req.prompt || ""}`.trim();
  } else if (req.operation === "UPSCALE") {
    prompt = `${OPERATION_PROMPTS.UPSCALE}\n\n${req.prompt || ""}`.trim();
  } else if (req.operation === "REMOVE_BACKGROUND") {
    prompt = OPERATION_PROMPTS.REMOVE_BACKGROUND;
    transparentRequest = true;
  } else if (req.operation === "EXPAND") {
    if (!baseImage) throw new LaxiiCapabilityError("Canvas expansion needs a source image.");
    const prepared = await prepareExpandCanvas(
      Buffer.from(baseImage.dataUrl.replace(/^data:[^;]+;base64,/, ""), "base64"),
      req.aspect as ExactAspect
    );
    baseImage = { dataUrl: prepared.dataUrl, mime: "image/png", label: "canvas to extend" };
    prompt = OPERATION_PROMPTS.EXPAND;
  } else if (req.operation === "GENERATE" && (providerReq.references?.length ?? 0) > 0) {
    // Reference-guided generation: tell the model HOW to read the reference
    // (composition / subject placement / lighting / palette) so the output
    // preserves the reference's intent without copying proprietary artwork.
    prompt = [
      req.prompt,
      "Use the attached reference image as the creative guide: match its composition, subject placement, lighting direction, colour palette and overall visual style. Preserve the intent of the reference — never reproduce its exact artwork verbatim, and never copy watermarks or logos.",
    ].filter(Boolean).join("\n\n");
  }

  const effectiveReq: LaxiiImageRequest = {
    ...providerReq,
    baseImage,
    prompt,
    transparent: transparentRequest || undefined,
    previousInteractionId: provider.id === "gemini" ? req.previousInteractionId : undefined,
  };

  // Stateless providers get the compact conversation-context brief; Gemini
  // with a live interaction id continues from NATIVE state instead — the
  // context block must never double-apply on top of a real conversation.
  const usesNativeState = provider.id === "gemini" && Boolean(req.previousInteractionId);
  if (req.conversationContext && !usesNativeState) {
    effectiveReq.prompt = `${effectiveReq.prompt}\n\nConversation context (for continuity only — the user's request above is authoritative):\n${req.conversationContext}`;
  }

  const dispatch =
    provider.id === "gemini"
      ? geminiGenerate
      : provider.id === "openai"
        ? openaiGenerate
        : provider.id === "diffusers"
          ? diffusersGenerate
          : managedGenerate;
  const startedAt = Date.now();
  let result;
  try {
    result = await dispatch(effectiveReq);
  } catch (e) {
    // Report provider health to the BEAN Intelligence gateway (transient
    // failures only — safety/auth/config problems never trip the circuit).
    recordProviderFailure(
      laxiiRegistryId(provider.id),
      e instanceof Error ? e.message : String(e),
      isTransientProviderError(e)
    );
    throw e;
  }
  recordProviderSuccess(laxiiRegistryId(provider.id));
  const durationMs = Date.now() - startedAt;

  // Post-processing: validation + deterministic aspect enforcement.
  const images: LaxiiGeneratedImage[] = [];
  for (const img of result.images) {
    const probe = validateGeneratedImage(img.bytes, req.operation);
    let bytes = img.bytes;
    let width = probe.width;
    let height = probe.height;
    let mime = probe.mime;

    if (transparentRequest) {
      const alpha = await extractTransparency(bytes);
      if (!alpha) {
        throw new LaxiiProviderError(
          "Subject isolation did not produce a clean cutout this time. Nothing was saved — please try again.",
          "invalid_output"
        );
      }
      bytes = alpha.bytes;
      width = alpha.width;
      height = alpha.height;
      mime = "image/png";
      warnings.push(`Transparency extracted (subject coverage ${(alpha.subjectCoverage * 100).toFixed(1)}%).`);
    } else if (width > 0 && height > 0) {
      const actual = (width / height).toFixed(3);
      const wanted = (Number(req.aspect.split(":")[0]) / Number(req.aspect.split(":")[1])).toFixed(3);
      if (actual !== wanted) {
        const cropped = await cropToAspect(bytes, req.aspect as ExactAspect);
        bytes = cropped.bytes;
        width = cropped.width;
        height = cropped.height;
        warnings.push(`Rendered at the provider's closest native size, then center-cropped to exactly ${req.aspect}.`);
      }
    }

    images.push({ bytes, mime, width, height });
  }

  const unit = estimateUnitCost(provider.id, result.model, opts.quality ?? req.quality);
  return {
    images,
    provider: provider.id,
    model: result.model,
    warnings: [...warnings, ...result.warnings],
    estimatedCostUsd: Number((unit * images.length).toFixed(4)),
    durationMs,
    ...(result.interactionIds ? { interactionIds: result.interactionIds } : {}),
  };
}
