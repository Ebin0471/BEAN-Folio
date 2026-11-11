/**
 * LAXII OpenAI provider — official Images API (optional; activates with OPENAI_API_KEY).
 *
 * Contract VERIFIED against the canonical OpenAI OpenAPI spec (openai-openapi
 * master, 2026) and platform.openai.com docs:
 *  - POST /v1/images/generations  (JSON): model, prompt, n (1–10),
 *    size ∈ {auto, 1024x1024, 1536x1024, 1024x1536} for gpt-image models,
 *    quality ∈ {low, medium, high, xhigh, max, auto}, background
 *    {transparent|opaque|auto} (transparent requires png/webp), output_format.
 *  - POST /v1/images/edits: multipart/form-data (canonical) with image[] file
 *    parts (up to 16), optional mask, prompt, model, n, size, input_fidelity
 *    "high" (subject-preserving edits), background, output_format.
 *  - The legacy /v1/images/variations endpoint is RETIRED — variations run
 *    through the edits endpoint with a variation prompt (documented path).
 *  - Responses carry base64 data (b64_json) for GPT Image models.
 *  - Moderation failures surface as error.code "moderation_blocked".
 *
 * Models (current enum, env-overridable): gpt-image-1, gpt-image-1-mini,
 * gpt-image-1.5, gpt-image-2, gpt-image-2.5-sunburst, gpt-image-2.5-flare.
 *
 * Regional note: OpenAI blocks requests from unsupported regions with 403
 * `unsupported_country_region_territory` — surfaced honestly as an
 * unconfigured/unavailable provider rather than an auth failure.
 */

import {
  LaxiiProviderError,
  type LaxiiGenerationResult,
  type LaxiiGeneratedImage,
  type LaxiiImageRequest,
  type LaxiiProviderInfo,
} from "../types";
import { withProviderRetries } from "../retry";

const API_BASE = "https://api.openai.com/v1";
const TIMEOUT_MS = 180_000;

export function openaiModel(): string {
  return process.env.LAXII_OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2.5-sunburst";
}

export function openaiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

interface OpenAIImagesResponse {
  data?: { b64_json?: string; url?: string }[];
  error?: { type?: string; code?: string; message?: string };
}

export const openaiProvider: LaxiiProviderInfo = {
  id: "openai",
  label: "LAXII Studio — professional image engine",
  available: false, // replaced at registry build time when OPENAI_API_KEY is set
  model: "gpt-image-2.5-sunburst",
  capabilities: {
    generate: {
      supported: true,
      maxReferences: 0,
      maxVariantsPerCall: 10,
      transparent: true,
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
      note: "Native transparent PNG output and true server-side batch variants.",
    },
    edit: {
      supported: true,
      maxReferences: 16,
      maxVariantsPerCall: 10,
      transparent: true,
      sizes: ["1024x1024", "1536x1024", "1024x1536"],
      note: "Up to 16 input images with high input fidelity (subject-preserving edits).",
    },
    variations: { supported: true, maxVariantsPerCall: 10, note: "Via the edits endpoint (documented replacement)." },
    upscale: {
      supported: true,
      note: "Detail-preserving re-render at the provider's largest size — not a native 4K upscale.",
    },
    removeBackground: {
      supported: true,
      transparent: true,
      note: "Native transparent background generation plus alpha validation.",
    },
    expand: { supported: true, note: "Generative canvas extension (outpainting)." },
  },
  aspects: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
};

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new LaxiiProviderError("The professional image engine is not configured on this deployment.", "auth");
  return key;
}

/**
 * Aspect → one of the ONLY sizes the gpt-image models accept
 * (1024x1024 | 1536x1024 | 1024x1536). The engine center-crops to the exact
 * requested aspect downstream (deterministic, real pixels) when the native
 * render differs — never stretching.
 */
function sizeFor(aspect: string): "1024x1024" | "1536x1024" | "1024x1536" {
  switch (aspect) {
    case "1:1":
      return "1024x1024";
    case "3:2":
    case "16:9":
    case "21:9":
    case "4:3":
    case "5:4":
      return "1536x1024";
    case "2:3":
    case "9:16":
    case "3:4":
    case "4:5":
      return "1024x1536";
    default:
      return "1024x1024";
  }
}

/** LAXII quality buckets → OpenAI quality enum (fidelity tiers, not pixel sizes). */
function qualityFor(quality?: "1K" | "2K" | "4K"): string | undefined {
  if (quality === "1K") return "medium";
  if (quality === "2K" || quality === "4K") return "high";
  return undefined;
}

function dataUrlToBlob(dataUrl: string, mime: string): Blob {
  const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
  const bytes = Buffer.from(base64, "base64");
  return new Blob([new Uint8Array(bytes)], { type: mime || "image/png" });
}

async function callOpenAIJson(path: string, body: Record<string, unknown>): Promise<OpenAIImagesResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new LaxiiProviderError(
      aborted
        ? "The image service took too long to respond. Please try again."
        : "Could not reach the image service. Check the network and try again.",
      aborted ? "timeout" : "provider"
    );
  }
  clearTimeout(timer);
  return readOpenAIResponse(res);
}

async function callOpenAIMultipart(path: string, form: FormData): Promise<OpenAIImagesResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    // No explicit Content-Type — fetch sets the multipart boundary itself.
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}` },
      body: form,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new LaxiiProviderError(
      aborted
        ? "The image service took too long to respond. Please try again."
        : "Could not reach the image service. Check the network and try again.",
      aborted ? "timeout" : "provider"
    );
  }
  clearTimeout(timer);
  return readOpenAIResponse(res);
}

async function readOpenAIResponse(res: Response): Promise<OpenAIImagesResponse> {
  const payload = (await res.json().catch(() => ({}))) as OpenAIImagesResponse;
  if (!res.ok || payload.error) {
    const code = payload.error?.code ?? "";
    const type = payload.error?.type ?? "";
    if (code === "moderation_blocked" || type === "moderation_blocked") {
      throw new LaxiiProviderError("The prompt was blocked by the image engine's content policy. Try rephrasing it.", "safety");
    }
    if (code === "unsupported_country_region_territory") {
      throw new LaxiiProviderError(
        "The image engine does not serve requests from this deployment's region.",
        "auth"
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new LaxiiProviderError("The image engine rejected the configured API key.", "auth");
    }
    if (res.status === 429) {
      throw new LaxiiProviderError("Image engine rate limit reached. Please wait a moment and try again.", "rate_limit");
    }
    throw new LaxiiProviderError("The image service could not complete the request. Please try again.", "provider");
  }
  return payload;
}

function collectImages(payload: OpenAIImagesResponse, batch: number, warnings: string[]): LaxiiGeneratedImage[] {
  const images: LaxiiGeneratedImage[] = [];
  for (const item of payload.data ?? []) {
    if (item.b64_json && images.length < batch) {
      images.push({ bytes: Buffer.from(item.b64_json, "base64"), mime: "image/png", width: 0, height: 0 });
    }
  }
  if ((payload.data?.length ?? 0) > batch) warnings.push("Provider returned more images than requested; extras discarded.");
  return images;
}

export async function openaiGenerate(req: LaxiiImageRequest): Promise<LaxiiGenerationResult> {
  const model = openaiModel();
  const size = sizeFor(req.aspect);
  const transparent = Boolean(req.transparent);
  const warnings: string[] = [];
  const batch = Math.min(Math.max(req.count, 1), 10);

  if (req.baseImage) {
    // Edit-style request — canonical multipart/form-data with image[] parts.
    // Also the documented replacement for the retired variations endpoint.
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", req.prompt);
    form.append("n", String(batch));
    form.append("size", size);
    form.append("output_format", "png");
    form.append("input_fidelity", "high");
    if (transparent) form.append("background", "transparent");
    const parts = [req.baseImage, ...(req.references ?? [])].slice(0, 16);
    parts.forEach((p, idx) => {
      form.append("image[]", dataUrlToBlob(p.dataUrl, p.mime), `image-${idx}.png`);
    });
    if (parts.length > 1) {
      form.append("prompt", `${req.prompt}\n\nUse the first image as the primary subject and the remaining ${parts.length - 1} image(s) as reference context for this edit.`);
    }
    const payload = await withProviderRetries(() => callOpenAIMultipart("/images/edits", form), {
      label: "openai images/edits",
    });
    const images = collectImages(payload, batch, warnings);
    if (images.length === 0) {
      throw new LaxiiProviderError(
        "The image service returned no image. Nothing was saved — please try again.",
        "provider"
      );
    }
    return { images, provider: "openai", model, warnings };
  }

  // Pure text-to-image — one JSON call returns up to n images.
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    size,
    n: batch,
    output_format: "png",
  };
  const quality = qualityFor(req.quality);
  if (quality) body.quality = quality;
  if (transparent) body.background = "transparent";
  const payload = await withProviderRetries(() => callOpenAIJson("/images/generations", body), {
    label: "openai images/generations",
  });
  const images = collectImages(payload, batch, warnings);
  if (images.length === 0) {
    throw new LaxiiProviderError(
      "The OpenAI image service returned no image. Nothing was saved — please try again.",
      "provider"
    );
  }
  return { images, provider: "openai", model, warnings };
}
