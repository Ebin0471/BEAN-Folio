import { NextRequest } from "next/server";

import { err, handler, ok, parseBodySized, rateLimit } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import {
  BrandKitFieldError,
  brandKitInputSchema,
  brandKitRejection,
  buildBrandKitProposal,
} from "@/lib/brand-kit";

export const dynamic = "force-dynamic";

/**
 * GIFTZ brand kit — explicit-attributes → validated proposal (M33.1).
 *
 * Pure proposal engine: no persistence, no side effects, no model call. The
 * proposal becomes reality only when the user applies it through the existing
 * site/banner save flows (approval boundary unchanged). Unknown explicit ids
 * (font/palette) are REJECTED with suggestions — never silently substituted.
 */

/** POST /api/giftz/brand-kit — compute a brand-kit proposal. */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);
  if (!rateLimit(`giftz-brand-kit:${user.id}`, 30, 60_000)) {
    return err("Too many requests. Please slow down.", 429);
  }

  const parsed = await parseBodySized(req, brandKitInputSchema, 16_000);
  if (parsed.response) return parsed.response;

  try {
    const proposal = buildBrandKitProposal(parsed.data);
    return ok({ proposal });
  } catch (error) {
    if (error instanceof BrandKitFieldError) {
      const rejection = brandKitRejection(error);
      return err(
        `Invalid input — ${rejection.field}: ${rejection.reason} Valid options include: ${rejection.suggestions.join(", ")}.`,
        400,
        "brand-kit-rejected",
      );
    }
    throw error;
  }
});
