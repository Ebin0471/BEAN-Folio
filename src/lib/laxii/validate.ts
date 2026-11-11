/**
 * LAXII — output validation pipeline (P7 quality gate).
 *
 * EVERY image a provider returns passes through validateGeneratedImage()
 * before it is persisted or shown. A result that is not a decodable image of
 * plausible dimensions is treated as a provider failure — never silently
 * replaced, never shown as success (rules: no fake generations, no misleading
 * resolution claims).
 */

import { imageDimensions } from "@/lib/media";
import { LaxiiProviderError } from "./types";

const MIN_EDGE = 256;

/** Decode intrinsic dimensions (PNG/JPEG/WEBP/GIF) from a buffer. */
export function probeImage(bytes: Buffer): { mime: string; width: number; height: number } | null {
  if (bytes.length < 16) return null;
  let mime: string | null = null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) mime = "image/png";
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = "image/jpeg";
  else if (bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP")
    mime = "image/webp";
  else if (bytes.slice(0, 4).toString("ascii") === "GIF8") mime = "image/gif";
  if (!mime) return null;
  const dims = imageDimensions(bytes);
  if (!dims || dims.width <= 0 || dims.height <= 0) return null;
  return { mime, width: dims.width, height: dims.height };
}

/**
 * Validate one provider output. Throws LaxiiProviderError (invalid_output)
 * with a user-safe message when the bytes are not a real, decodable image.
 */
export function validateGeneratedImage(bytes: Buffer, context: string): {
  mime: string;
  width: number;
  height: number;
} {
  const probe = probeImage(bytes);
  if (!probe) {
    throw new LaxiiProviderError(
      "The image provider returned data that is not a valid image. Nothing was saved — please try again.",
      "invalid_output"
    );
  }
  if (probe.width < MIN_EDGE || probe.height < MIN_EDGE) {
    throw new LaxiiProviderError(
      `The image provider returned an unexpectedly small image (${probe.width}×${probe.height}). Nothing was saved — please try again.`,
      "invalid_output"
    );
  }
  if (bytes.length < 1024) {
    throw new LaxiiProviderError(
      "The image provider returned truncated image data. Nothing was saved — please try again.",
      "invalid_output"
    );
  }
  if (probe.mime === "image/gif") {
    // LAXII outputs still images; a GIF payload would decode but is not the
    // contract with any provider — treat as invalid rather than surprise.
    throw new LaxiiProviderError(
      "The image provider returned an unsupported image format. Nothing was saved — please try again.",
      "invalid_output"
    );
  }
  return probe;
}

/** Detect whether a PNG actually carries an alpha channel (true transparency). */
export function pngHasAlpha(bytes: Buffer): boolean {
  if (bytes.length < 33) return false;
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return false;
  const colorType = bytes[25];
  return colorType === 4 || colorType === 6; // grayscale+alpha or RGBA
}
