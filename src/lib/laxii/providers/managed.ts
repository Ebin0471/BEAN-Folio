/**
 * LAXII managed provider — the z-ai gateway (server-side only).
 *
 * Real endpoints: `images.generations.create({ prompt, size })` for
 * text-to-image and `images.generations.edit({ prompt, image, size })` for
 * reference-guided generation/editing. Both return base64 image payloads.
 *
 * Constraints of this provider (reflected honestly in the capability table):
 *  - 7 fixed output sizes (no arbitrary dimensions, no native >1440px edge)
 *  - one image per call (variants are separate calls)
 *  - one reference image per edit call (multi-reference is composed into a
 *    contact sheet upstream — a real pixel composite, not a fake)
 *  - no native transparency output and no native upscale; those operations
 *    are delivered through the engine's real downstream pipelines or marked
 *    unsupported — never faked.
 */

import ZAI from "z-ai-web-dev-sdk";

import {
  LaxiiProviderError,
  type LaxiiAspect,
  type LaxiiGenerationResult,
  type LaxiiGeneratedImage,
  type LaxiiImageRequest,
  type LaxiiProviderInfo,
} from "../types";
import { log } from "@/lib/logger";

const TIMEOUT_MS = 240_000;

/**
 * Engine prompt ceiling — VERIFIED against the live gateway (2026-11-22):
 * 2,399 characters accepted, 2,601 rejected in-band (HTTP 200 with an error
 * payload the SDK crashes on). The LAXII product budget is 16,000 characters
 * and the user's exact words are always stored verbatim in the conversation;
 * only the COMPILED prompt sent to the engine is fitted to this ceiling, cut
 * at a sentence boundary, with an honest warning recorded on the job.
 */
const ENGINE_PROMPT_MAX = 2400;

/** Fit a compiled prompt to the engine ceiling (sentence-boundary cut). */
export function fitEnginePrompt(prompt: string, warnings: string[]): string {
  if (prompt.length <= ENGINE_PROMPT_MAX) return prompt;
  const head = prompt.slice(0, ENGINE_PROMPT_MAX);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"), head.lastIndexOf("。 "));
  const fitted = (cut > ENGINE_PROMPT_MAX * 0.5 ? head.slice(0, cut + 1) : head).trimEnd();
  warnings.push(
    `The engine received the first ${fitted.length.toLocaleString()} of ${prompt.length.toLocaleString()} compiled prompt characters (the image gateway rejects longer prompts) — the full prompt is preserved verbatim in the conversation.`
  );
  return fitted;
}

type ManagedSize = "1024x1024" | "768x1344" | "864x1152" | "1344x768" | "1152x864" | "1536x864" | "864x1536" | "2016x864";

const globalForLaxii = globalThis as unknown as { __laxiiZai?: Awaited<ReturnType<typeof ZAI.create>> };

async function getZai() {
  if (!globalForLaxii.__laxiiZai) {
    globalForLaxii.__laxiiZai = await ZAI.create();
  }
  return globalForLaxii.__laxiiZai;
}

/**
 * Render size for an aspect. The gateway requires both edges to be
 * multiples of 32 within 512–2880px and ≤ 2^22 total pixels (verified
 * against the live contract), so the wide/tall ratios use exact-ratio
 * renders (1536x864 = 16:9, 864x1536 = 9:16, 2016x864 = 21:9) and the
 * 4:3-family ratios render at 864x1152/1152x864 before a deterministic
 * center-crop enforces the exact aspect.
 */
function renderSizeFor(aspect: LaxiiAspect): ManagedSize {
  switch (aspect) {
    case "1:1":
      return "1024x1024";
    case "3:4":
    case "2:3": // rendered 3:4, center-cropped to 2:3 downstream
    case "4:5": // rendered 3:4, center-cropped to 4:5
      return "864x1152";
    case "4:3":
    case "3:2":
    case "5:4":
      return "1152x864";
    case "9:16":
      return "864x1536"; // exact 9:16 — no crop needed
    case "16:9":
      return "1536x864"; // exact 16:9 — no crop needed
    case "21:9":
      return "2016x864"; // exact 21:9 — no crop needed
  }
}

export const managedProvider: LaxiiProviderInfo = {
  id: "managed",
  label: "LAXII Core — managed engine",
  available: true, // the sandbox gateway is always configured server-side
  model: "managed-image-1",
  capabilities: {
    generate: {
      supported: true,
      maxReferences: 3,
      maxVariantsPerCall: 1,
      transparent: false,
      sizes: ["1024x1024", "864x1152", "1152x864", "864x1536", "1536x864", "2016x864", "768x1344", "1344x768"],
      note: "Renders at up to 2016px on the long edge (exact 16:9/9:16/21:9 supported).",
    },
    edit: {
      supported: true,
      maxReferences: 3,
      maxVariantsPerCall: 1,
      transparent: false,
      sizes: ["1024x1024", "864x1152", "1152x864", "864x1536", "1536x864", "2016x864", "768x1344", "1344x768"],
      note: "Reference-guided re-rendering; keeps the reference composition.",
    },
    variations: { supported: true, maxVariantsPerCall: 1 },
    upscale: {
      supported: true,
      note: "Detail-preserving re-render at the provider's largest size — not a native 4K upscale.",
    },
    removeBackground: {
      supported: true,
      transparent: true,
      note: "Generative subject isolation followed by pixel-accurate alpha extraction.",
    },
    expand: {
      supported: true,
      note: "Canvas extension by compositing and generative outpainting.",
    },
  },
  aspects: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
};

async function callManaged(body: {
  prompt: string;
  image?: string;
  size: ManagedSize;
}): Promise<string> {
  const zai = await getZai();
  // Gateway contract (verified): the edit endpoint takes `images: [{ url }]` —
  // an array of data URLs. The bundled .d.ts still declares a legacy
  // `image?: string` field, so the edit body is cast deliberately; the SDK
  // forwards the payload as-is.
  const payload = (
    body.image
      ? { prompt: body.prompt, size: body.size, images: [{ url: body.image }] }
      : { prompt: body.prompt, size: body.size }
  ) as never;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let result: { data?: { base64?: string }[]; content_filter?: unknown[] } | null = null;
    try {
      result = (await Promise.race([
        body.image
          ? zai.images.generations.edit(payload)
          : // The SDK .d.ts size union is outdated (missing exact-ratio renders
            // verified against the live contract) — cast deliberately, same as edit.
            zai.images.generations.create({ prompt: body.prompt, size: body.size } as never),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new LaxiiProviderError("The image engine took too long to respond.", "timeout")), TIMEOUT_MS);
        }),
      ])) as { data?: { base64?: string }[]; content_filter?: unknown[] } | null;
    } catch (e) {
      // SDK-internal crashes (e.g. the gateway returning an error body the SDK
      // does not expect) must surface as honest PROVIDER failures with the
      // standard safe message — never as raw TypeErrors.
      if (e instanceof LaxiiProviderError) throw e;
      log.error("laxii.provider.managed_failed", { message: String(e instanceof Error ? e.message : e).slice(0, 300) });
      throw new LaxiiProviderError(
        "The image engine could not complete the request. Please try again.",
        "provider"
      );
    }

    const base64 = result?.data?.[0]?.base64;
    if (!base64) {
      // Distinguish a safety filter hit (documented response shape) from other
      // empty responses so users get an accurate, honest message.
      if (result && "content_filter" in result && Array.isArray(result.content_filter) && result.content_filter.length > 0) {
        throw new LaxiiProviderError(
          "The prompt was blocked by the provider's content policy. Try rephrasing it.",
          "safety"
        );
      }
      throw new LaxiiProviderError(
        "The image engine returned no image. Nothing was saved — please try again.",
        "provider"
      );
    }
    return base64;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function managedGenerate(req: LaxiiImageRequest): Promise<LaxiiGenerationResult> {
  const size = renderSizeFor(req.aspect);
  const warnings: string[] = [];
  const images: LaxiiGeneratedImage[] = [];

  // Variants are independent calls (this provider yields one image per call).
  for (let i = 0; i < req.count; i += 1) {
    const variationNote =
      req.count > 1 ? `\n\nVariant ${i + 1} of ${req.count}: explore a distinct composition while keeping the same brief.` : "";
    const prompt = fitEnginePrompt(req.prompt + variationNote, warnings);
    let dataUrl: string | undefined;
    if (req.operation === "GENERATE" && req.references && req.references.length > 0) {
      dataUrl = req.references[0].dataUrl; // reference-guided generation
    } else if (req.baseImage) {
      dataUrl = req.baseImage.dataUrl;
    }
    const base64 = await callManaged({ prompt, image: dataUrl, size });
    images.push({ bytes: Buffer.from(base64, "base64"), mime: "image/png", width: 0, height: 0 });
  }
  return { images, provider: "managed", model: managedProvider.model, warnings };
}
