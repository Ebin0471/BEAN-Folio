import type { LaxiiRequest, ProviderCapabilities } from "./types";
import { LaxiiError } from "./types";
import { runRequestWithProvider, type ProgressFn, type RunOutcome } from "./engine";
import { resolveProvider, providerRegistry, type ProviderDescriptor } from "./providers/capabilities";

/**
 * LAXII creative-studio router facade (§Phase 2D of the spec) — the common
 * provider-independent interface the conversational studio drives:
 *
 *   generateImage()      — text-to-image (optionally reference-conditioned)
 *   editImage()          — instruction-based image-to-image editing
 *   generateVariations() — N genuine generative variations of an image
 *   continueEditing()    — multi-turn: edit the previously produced image again
 *   upscaleImage()       — resolution increase (native when available, else Lanczos)
 *   removeBackground()   — subject cutout (MODNet matte; native when available)
 *   getCapabilities()    — what the selected provider can genuinely do
 *
 * Every method routes through the SAME engine pipelines the Profile Studio
 * uses — one engine, two front doors. Providers are resolved through the
 * router (managed | diffusers | gemini | openai); changing providers never
 * changes this interface or the frontend.
 */

const noopProgress: ProgressFn = () => undefined;

/** Run a fully-validated request, resolving the provider per request preference. */
async function run(req: LaxiiRequest, onProgress: ProgressFn = noopProgress): Promise<RunOutcome> {
  const provider = await resolveProvider(req.provider);
  return runRequestWithProvider(req, provider, onProgress);
}

export const laxii = {
  /** Text-to-image. `req.instructions` is the prompt; `req.refs` conditions when supported. */
  generateImage(req: LaxiiRequest, onProgress?: ProgressFn): Promise<RunOutcome> {
    return run({ ...req, kind: "GENERATE" }, onProgress);
  },

  /** Instruction-based edit of `req.source`. `req.refs` adds extra references where supported. */
  editImage(req: LaxiiRequest, onProgress?: ProgressFn): Promise<RunOutcome> {
    return run({ ...req, kind: "EDIT" }, onProgress);
  },

  /** N genuine generative variations of `req.source`. */
  generateVariations(req: LaxiiRequest, onProgress?: ProgressFn): Promise<RunOutcome> {
    return run({ ...req, kind: "VARIATIONS" }, onProgress);
  },

  /**
   * Multi-turn continuation: edit the PREVIOUS image again. The previous
   * image MUST be provided as `req.source` — never the latest text alone
   * (§Phase 3: "Never use only the latest text prompt if the task requires
   * the previous generated image").
   */
  continueEditing(req: LaxiiRequest, onProgress?: ProgressFn): Promise<RunOutcome> {
    if (!req.source) {
      return Promise.reject(new LaxiiError("Continuing an edit needs the previous image"));
    }
    return run({ ...req, kind: "EDIT" }, onProgress);
  },

  /** Upscale `req.source` by req.factor (2|4) — local Lanczos; native when the provider offers it. */
  upscaleImage(req: LaxiiRequest, onProgress?: ProgressFn): Promise<RunOutcome> {
    return run({ ...req, kind: "UPSCALE" }, onProgress);
  },

  /** Subject cutout → transparent PNG via the local MODNet matte. */
  removeBackground(req: LaxiiRequest, onProgress?: ProgressFn): Promise<RunOutcome> {
    return run({ ...req, kind: "REMOVE_BG" }, onProgress);
  },

  /** Canvas expansion (generative outpainting) to req.size. */
  expandCanvas(req: LaxiiRequest, onProgress?: ProgressFn): Promise<RunOutcome> {
    return run({ ...req, kind: "OUTPAINT" }, onProgress);
  },

  /** Capability registry (availability probed server-side at call time). */
  async getCapabilities(): Promise<ProviderDescriptor[]> {
    return providerRegistry();
  },
};

export type { ProviderCapabilities };
