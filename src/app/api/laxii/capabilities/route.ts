import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";

import { laxiiCapabilities } from "@/lib/laxii/router";
import { BANNER_PRESETS } from "@/lib/laxii/banner-presets";
import { AVATAR_PRESETS } from "@/lib/laxii/avatar-presets";
import { publicStylePresets } from "@/lib/laxii/styles";
import { RESUME_TYPES } from "@/lib/laxii/resume-schema";
import { resumeProfessionOptions } from "@/lib/laxii/resume-professions";

export const dynamic = "force-dynamic";

/**
 * GET /api/laxii/capabilities — capability registry + banner presets +
 * avatar style presets + resume types. The studio UI renders ONLY the actions
 * this endpoint reports as supported for the active provider (P8: UI offers
 * what the provider actually delivers). No credentials or model keys are ever
 * included, and avatar style prompt fragments stay server-side.
 */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const caps = laxiiCapabilities();
  return ok({
    ...caps,
    // Providers without credentials are listed but flagged unavailable so the
    // UI can explain WHY an engine is not selectable (no fake substitution).
    limits: { burstPerMinute: 6, dailyImages: 80 },
    // Conversational creative intelligence (Phase 3): the studio can send
    // operation "AUTO" and the server classifies the intent + resolves the
    // referenced version server-side.
    conversational: {
      enabled: true,
      defaultOperation: "AUTO",
      intents: [
        "new image", "edit current", "edit a referenced version", "replace object",
        "remove object", "change background", "change clothing", "change lighting",
        "change colours", "change composition", "extend canvas", "variations",
        "upscale", "remove background", "combine references",
      ],
    },
    // Style Registry (Phase 5) — compiled creative directives stay server-side.
    styles: publicStylePresets(),
    bannerPresets: BANNER_PRESETS,
    avatarPresets: AVATAR_PRESETS.map((p) => ({
      slug: p.slug,
      label: p.label,
      blurb: p.blurb,
      defaultAspect: p.defaultAspect,
    })),
    resumeTypes: RESUME_TYPES.map((t) => ({ slug: t.slug, label: t.label, blurb: t.blurb })),
    // Universal profession families (26) for the resume builder.
    resumeProfessions: resumeProfessionOptions(),
  });
});
