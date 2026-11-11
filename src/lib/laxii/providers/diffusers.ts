/**
 * LAXII local Diffusers provider — OPTIONAL local inference backend.
 *
 * This deployment ships NO local model runtime; the provider activates only
 * when LAXII_DIFFUSERS_URL points at a running Diffusers inference server
 * implementing the minimal REST contract below. When unconfigured, the
 * provider reports itself unavailable and the router refuses pinned requests
 * instead of substituting another engine — local processing is an explicit
 * user choice (privacy), never a silent fallback target.
 *
 * Server contract (documented, minimal, ComfyUI/Ollama deliberately NOT used):
 *   GET  {base}/health   → 200 {"status":"ok", "model": "..."}
 *   POST {base}/generate → { prompt, negative_prompt?, width, height,
 *                            num_images (1–4), steps?, guidance_scale?,
 *                            init_image? (data URL, img2img), strength? }
 *                        ← { images: [{ base64: "…", mime?: "image/png" }] }
 *
 * Capability honesty: text-to-image and img2img editing are supported;
 * upscale / background removal / canvas expansion are NOT advertised as AI
 * features here because stock Diffusers pipelines do not perform them — the
 * router refuses those operations on this provider instead of faking them.
 */

import {
  LaxiiProviderError,
  type LaxiiGenerationResult,
  type LaxiiGeneratedImage,
  type LaxiiImageRequest,
  type LaxiiProviderInfo,
} from "../types";

const TIMEOUT_MS = 600_000; // local GPUs can be slow — generous, still bounded

export function diffusersBaseUrl(): string {
  return process.env.LAXII_DIFFUSERS_URL?.trim().replace(/\/+$/, "") ?? "";
}

export function diffusersModel(): string {
  return process.env.LAXII_DIFFUSERS_MODEL?.trim() || "local-diffusers";
}

export function diffusersConfigured(): boolean {
  return Boolean(diffusersBaseUrl());
}

export const diffusersProvider: LaxiiProviderInfo = {
  id: "diffusers",
  label: "LAXII Local — self-hosted engine",
  available: false, // replaced at registry build time when LAXII_DIFFUSERS_URL is set
  model: "local-diffusers",
  capabilities: {
    generate: {
      supported: true,
      maxReferences: 0,
      maxVariantsPerCall: 4,
      transparent: false,
      note: "Local text-to-image on your own hardware — images never leave this machine.",
    },
    edit: {
      supported: true,
      maxReferences: 0,
      maxVariantsPerCall: 4,
      transparent: false,
      note: "Local img2img editing with adjustable strength; identity preservation is approximate.",
    },
    variations: {
      supported: true,
      maxVariantsPerCall: 4,
      note: "Local img2img re-rolls at low strength for genuine variations.",
    },
    upscale: { supported: false, note: "The local pipeline here does not include a super-resolution model." },
    removeBackground: { supported: false, note: "Not available on the local pipeline." },
    expand: { supported: false, note: "Not available on the local pipeline." },
  },
  aspects: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
};

/** Aspect → concrete local render size (multiple of 64, 512–1536 per edge). */
function sizeFor(aspect: string): { width: number; height: number } {
  const [aw, ah] = aspect.split(":").map(Number);
  const ratio = aw / ah;
  let width = Math.round(Math.sqrt(1024 * 1024 * ratio) / 64) * 64;
  let height = Math.round((width / ratio) / 64) * 64;
  width = Math.min(1536, Math.max(512, width));
  height = Math.min(1536, Math.max(512, height));
  return { width, height };
}

interface DiffusersResponse {
  images?: { base64?: string; b64?: string; mime?: string }[];
  error?: string;
}

export async function diffusersGenerate(req: LaxiiImageRequest): Promise<LaxiiGenerationResult> {
  const base = diffusersBaseUrl();
  if (!base) throw new LaxiiProviderError("The local image engine is not configured on this deployment.", "auth");

  const { width, height } = sizeFor(req.aspect);
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    width,
    height,
    num_images: Math.min(Math.max(req.count, 1), 4),
  };
  if (process.env.LAXII_DIFFUSERS_NEGATIVE?.trim()) {
    body.negative_prompt = process.env.LAXII_DIFFUSERS_NEGATIVE.trim();
  }
  if (req.baseImage) {
    body.init_image = req.baseImage.dataUrl;
    // Editing strength: fidelity for edits, more freedom for variations.
    body.strength = req.operation === "VARIATIONS" ? 0.65 : 0.5;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = process.env.LAXII_DIFFUSERS_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    res = await fetch(`${base}/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new LaxiiProviderError(
      aborted
        ? "The local image server took too long to respond. Please try again."
        : "Could not reach the local image server. Verify it is running and reachable.",
      aborted ? "timeout" : "provider"
    );
  }
  clearTimeout(timer);

  const payload = (await res.json().catch(() => ({}))) as DiffusersResponse;
  if (!res.ok || payload.error) {
    if (res.status === 401 || res.status === 403) {
      throw new LaxiiProviderError("The local image server rejected the configured access token.", "auth");
    }
    if (res.status === 429) {
      throw new LaxiiProviderError("The local image server is busy. Please wait a moment and try again.", "rate_limit");
    }
    throw new LaxiiProviderError(
      `The local image server could not complete the request.${payload.error ? ` (${payload.error})` : ""}`,
      "provider"
    );
  }

  const images: LaxiiGeneratedImage[] = (payload.images ?? [])
    .map((img) => img.base64 ?? img.b64 ?? "")
    .filter(Boolean)
    .map((b64) => ({ bytes: Buffer.from(b64, "base64"), mime: "image/png", width: 0, height: 0 }));

  if (images.length === 0) {
    throw new LaxiiProviderError(
      "The local image server returned no image. Nothing was saved — please try again.",
      "provider"
    );
  }
  return { images, provider: "diffusers", model: diffusersModel(), warnings: [] };
}
