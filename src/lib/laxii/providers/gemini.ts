/**
 * LAXII Gemini provider — Google Nano Banana via the official Gemini API.
 *
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/interactions
 * Auth:     x-goog-api-key header (GEMINI_API_KEY) — server-side only, the key
 *           never reaches the browser or any API response.
 *
 * Contract VERIFIED against the live official docs
 * (ai.google.dev/gemini-api/docs/image-generation, 2026):
 *  - input: a plain string, or [{ type: "text", text }, { type: "image",
 *    mime_type, data(base64) }, …] for multimodal briefs
 *  - response_format: { type: "image", aspect_ratio, image_size: "1K"|"2K"|"4K" }
 *  - NATIVE conversation continuation: responses carry an interaction `id`,
 *    and follow-up requests pass `previous_interaction_id` — the model
 *    continues from its own stored state instead of re-sending pixels.
 *  - response images: top-level `output_image` (SDK/REST shape), with a
 *    steps[].content[] walk kept as a compatibility fallback.
 *  - blocked requests: HTTP 400 with error.code "safety"
 *
 * Models (exact current identifiers, env-overridable):
 *  - gemini-nano-banana-2.1  (default workhorse; 1K/2K/4K, 10 object + 4 character refs)
 *  - gemini-3.1-flash-image  (fast tier)
 *  - gemini-3-pro-image      (premium; best text rendering, interleaved output)
 */

import {
  LaxiiProviderError,
  type LaxiiGenerationResult,
  type LaxiiGeneratedImage,
  type LaxiiImageRequest,
  type LaxiiProviderInfo,
} from "../types";
import { withProviderRetries } from "../retry";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TIMEOUT_MS = 180_000;

export function geminiModel(): string {
  return process.env.LAXII_GEMINI_IMAGE_MODEL?.trim() || "gemini-nano-banana-2.1";
}

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

interface GeminiImageBlock {
  mime_type?: string;
  mimeType?: string;
  data?: string;
}

interface GeminiInteraction {
  id?: string;
  output_image?: GeminiImageBlock;
  outputImage?: GeminiImageBlock;
  outputs?: { output_image?: GeminiImageBlock; outputImage?: GeminiImageBlock }[];
  steps?: {
    type?: string;
    content?: (
      | { type?: string; text?: string; image?: GeminiImageBlock }
      | { type?: string; inlineData?: GeminiImageBlock }
    )[];
  }[];
  usageMetadata?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export const geminiProvider: LaxiiProviderInfo = {
  id: "gemini",
  label: "LAXII Prisma — advanced image engine",
  available: false, // replaced at registry build time when GEMINI_API_KEY is set
  model: "gemini-nano-banana-2.1",
  capabilities: {
    generate: {
      supported: true,
      maxReferences: 10,
      maxVariantsPerCall: 1,
      transparent: false,
      sizes: ["1K", "2K", "4K"],
      note: "Native aspect-ratio control up to 4K with SynthID provenance watermark.",
    },
    edit: {
      supported: true,
      maxReferences: 10,
      maxVariantsPerCall: 1,
      transparent: false,
      sizes: ["1K", "2K", "4K"],
      note: "Multi-reference conversational editing with native multi-turn state (previous_interaction_id).",
    },
    variations: { supported: true, maxVariantsPerCall: 1 },
    upscale: {
      supported: true,
      note: "Re-render the image at up to 4K natively on this engine.",
    },
    removeBackground: {
      supported: true,
      transparent: true,
      note: "Generative subject isolation followed by pixel-accurate alpha extraction.",
    },
    expand: { supported: true, note: "Generative canvas extension (outpainting)." },
  },
  aspects: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
};

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new LaxiiProviderError("The advanced image engine is not configured on this deployment.", "auth");
  }
  return key;
}

interface GeminiRequestBody {
  model: string;
  input: string | ({ type: "text"; text: string } | { type: "image"; mime_type: string; data: string })[];
  response_format: { type: "image"; aspect_ratio: string; image_size: string };
  previous_interaction_id?: string;
}

class GeminiStaleStateError extends LaxiiProviderError {
  constructor() {
    super("The stored conversation state for this image has expired.", "stale_state");
    this.name = "GeminiStaleStateError";
  }
}

async function callGemini(body: GeminiRequestBody): Promise<{ interaction: GeminiInteraction; model: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new LaxiiProviderError(
      aborted
        ? "The image engine took too long to respond. Please try again."
        : "Could not reach the image service. Check the network and try again.",
      aborted ? "timeout" : "provider"
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  let payload: (GeminiInteraction & { error?: { code?: string; message?: string; status?: string } }) | Record<string, never> = {};
  try {
    payload = JSON.parse(text) as GeminiInteraction & { error?: { code?: string; message?: string; status?: string } };
  } catch {
    payload = {};
  }

  if (!res.ok) {
    const code = payload.error?.code;
    const msg = payload.error?.message ?? "";
    if (code === "safety" || /safety|blocked/i.test(msg)) {
      throw new LaxiiProviderError(
        "The prompt was blocked by the image engine's safety policy. Try rephrasing it.",
        "safety"
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new LaxiiProviderError("The image engine rejected the configured API key.", "auth");
    }
    if (res.status === 429) {
      throw new LaxiiProviderError("Image engine rate limit reached. Please wait a moment and try again.", "rate_limit");
    }
    // A continuation id that Google no longer stores (retention window passed)
    // or never owned (id from another deployment) must fall back to a
    // stateless re-send — the user's image is still attached to the request.
    if (body.previous_interaction_id && /not found|expired|invalid|no longer/i.test(msg)) {
      throw new GeminiStaleStateError();
    }
    throw new LaxiiProviderError("The image engine could not complete the request. Please try again.", "provider");
  }

  return { interaction: payload as GeminiInteraction, model: body.model };
}

/** Extract generated image blocks from an interaction response (top-level first, steps fallback). */
function extractImages(interaction: GeminiInteraction): { base64: string; mime: string }[] {
  const out: { base64: string; mime: string }[] = [];
  const top = interaction.output_image ?? interaction.outputImage;
  if (top?.data) {
    out.push({ base64: top.data, mime: top.mime_type ?? top.mimeType ?? "image/png" });
  }
  if (out.length === 0) {
    for (const o of interaction.outputs ?? []) {
      const block = o.output_image ?? o.outputImage;
      if (block?.data) out.push({ base64: block.data, mime: block.mime_type ?? block.mimeType ?? "image/png" });
    }
  }
  if (out.length === 0) {
    for (const step of interaction.steps ?? []) {
      if (step.type && step.type !== "model_output") continue;
      for (const part of step.content ?? []) {
        if ("image" in part && part.image?.data) {
          out.push({ base64: part.image.data, mime: part.image.mime_type ?? part.image.mimeType ?? "image/png" });
        } else if ("inlineData" in part && part.inlineData?.data) {
          out.push({ base64: part.inlineData.data, mime: part.inlineData.mime_type ?? part.inlineData.mimeType ?? "image/png" });
        }
      }
    }
  }
  return out;
}

/** Build the stateless multimodal input (text + references + base image). */
function statelessInput(prompt: string, req: LaxiiImageRequest): NonNullable<GeminiRequestBody["input"]> {
  const input: NonNullable<GeminiRequestBody["input"]> = [{ type: "text", text: prompt }];
  for (const ref of req.references ?? []) {
    input.push({
      type: "image",
      mime_type: ref.mime || "image/png",
      data: ref.dataUrl.replace(/^data:[^;]+;base64,/, ""),
    });
  }
  if (req.baseImage) {
    input.push({
      type: "image",
      mime_type: req.baseImage.mime || "image/png",
      data: req.baseImage.dataUrl.replace(/^data:[^;]+;base64,/, ""),
    });
  }
  return input;
}

export async function geminiGenerate(req: LaxiiImageRequest): Promise<LaxiiGenerationResult> {
  const model = geminiModel();
  const imageSize = req.quality ?? "1K";
  const images: LaxiiGeneratedImage[] = [];
  const interactionIds: string[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < req.count; i += 1) {
    const promptWithVariant =
      req.count > 1
        ? `${req.prompt}\n\nVariant ${i + 1} of ${req.count}: explore a distinct composition while keeping the same brief.`
        : req.prompt;

    let interaction: GeminiInteraction;
    let usedNativeContinuation = false;

    if (req.previousInteractionId) {
      // NATIVE conversation continuation: the model continues from its own
      // stored interaction state — no image re-encoding, full multi-turn
      // context (official documented workflow).
      try {
        const call = await withProviderRetries(
          () =>
            callGemini({
              model,
              input: promptWithVariant,
              response_format: { type: "image", aspect_ratio: req.aspect, image_size: imageSize },
              previous_interaction_id: req.previousInteractionId,
            }),
          { label: "gemini interactions (continuation)" }
        );
        interaction = call.interaction;
        usedNativeContinuation = true;
      } catch (e) {
        if (!(e instanceof GeminiStaleStateError)) throw e;
        warnings.push("The engine's stored conversation state had expired — the image was attached statelessly instead.");
        const call = await withProviderRetries(
          () =>
            callGemini({
              model,
              input: statelessInput(promptWithVariant, req),
              response_format: { type: "image", aspect_ratio: req.aspect, image_size: imageSize },
            }),
          { label: "gemini interactions (stateless fallback)" }
        );
        interaction = call.interaction;
      }
    } else {
      const call = await withProviderRetries(
        () =>
          callGemini({
            model,
            input: statelessInput(promptWithVariant, req),
            response_format: { type: "image", aspect_ratio: req.aspect, image_size: imageSize },
          }),
        { label: "gemini interactions" }
      );
      interaction = call.interaction;
    }

    const found = extractImages(interaction);
    if (found.length === 0) {
      throw new LaxiiProviderError(
        "The image engine returned no image for this request. Nothing was saved — please try again.",
        "provider"
      );
    }
    const first = found[0];
    images.push({ bytes: Buffer.from(first.base64, "base64"), mime: first.mime, width: 0, height: 0 });
    // The interaction id is REQUIRED for true multi-turn continuation —
    // index-aligned with the produced image.
    interactionIds.push(usedNativeContinuation ? (req.previousInteractionId as string) : (interaction.id ?? ""));
    if (found.length > 1) warnings.push("The engine returned additional output images; the first was used.");
  }

  const ids = interactionIds.filter(Boolean);
  return {
    images,
    provider: "gemini",
    model,
    warnings,
    ...(ids.length === images.length ? { interactionIds: ids } : {}),
  };
}
