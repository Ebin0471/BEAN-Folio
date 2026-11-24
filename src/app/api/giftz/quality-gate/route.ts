import { NextRequest } from "next/server";

import { err, handler, ok, rateLimit } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { isTextPath, listProjectFiles } from "@/lib/giftz/project-files";
import {
  runQualityGate,
  type QualityGatePage,
  type QualityGateStylesheet,
} from "@/lib/giftz/quality-gate";
import { getPalette } from "@/lib/site-palettes";

export const dynamic = "force-dynamic";

/**
 * GIFTZ consolidated quality gate (M33.3).
 *
 * Deterministic STATIC report (accessibility / SEO / links / responsive /
 * static performance) over the REAL generated artifact of one of the caller's
 * OWN GIFTZ sites — the compiled project file tree, which covers both
 * generation modes (config sites are compiled to real HTML files by the
 * project compiler; file-mode sites are the agent/user files themselves).
 *
 * The report never claims runtime behaviour: it always ships an explicit
 * `untested` list pointing at the studio browser checks / device QA. It is a
 * read-only analysis — no persistence, no model call, no state change.
 */

/** POST /api/giftz/quality-gate — run the static quality gate for one site. */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);
  if (!rateLimit(`giftz-quality-gate:${user.id}`, 20, 60_000)) {
    return err("Too many requests. Please slow down.", 429);
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return err("Invalid JSON body", 400);
  const siteId = body.siteId;
  if (typeof siteId !== "string" || siteId.length === 0 || siteId.length > 64) {
    return err("siteId is required", 400);
  }

  const site = await db.giftzSite.findUnique({ where: { id: siteId } });
  if (!site || site.userId !== user.id) return err("Site not found", 404);

  const rows = await listProjectFiles(site.id);
  const textRows = rows.filter((r) => r.encoding === "utf8" && isTextPath(r.path));
  const pages: QualityGatePage[] = textRows
    .filter((r) => r.path.toLowerCase().endsWith(".html"))
    .map((r) => ({ path: r.path, html: r.content }));
  const stylesheets: QualityGateStylesheet[] = textRows
    .filter((r) => r.path.toLowerCase().endsWith(".css"))
    .map((r) => ({ path: r.path, css: r.content }));

  if (pages.length === 0) {
    return err(
      "This site has no compiled HTML pages yet — generate or build the site first, then run the quality gate.",
      400,
      "quality-gate-no-pages",
    );
  }

  // Palette context for the contrast check: the site's configured palette, if
  // any. Absent palette → the contrast check reports `not-run` honestly.
  let paletteId = "";
  if (site.config) {
    try {
      const parsed: unknown = JSON.parse(site.config);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const p = (parsed as Record<string, unknown>).palette;
        if (typeof p === "string") paletteId = p;
      }
    } catch {
      // Unparseable draft config — leave paletteId empty (contrast → not-run).
    }
  }
  const paletteDef = getPalette(paletteId);
  const palette = paletteDef
    ? { foreground: paletteDef.tokens.foreground, background: paletteDef.tokens.background }
    : null;

  const report = runQualityGate({
    pages,
    stylesheets,
    localFiles: rows.map((r) => r.path),
    palette,
  });

  return ok({ report });
});
