/**
 * RIISHE GIFTZ quality tools (M36.6) — the GIFTZ Experience & Quality
 * Auditor's ONE real capability over the EXISTING quality-gate service.
 *
 * `giftz.quality.report` is a READ-ONLY, deterministic STATIC analysis of the
 * owner's own stored GIFTZ project files — the exact same path the studio API
 * runs (src/app/api/giftz/quality-gate/route.ts):
 *  - owner-scoped re-read: `findFirst({ id, userId: ctx.userId })` — a typed
 *    `siteRef` is a POINTER, never authorization; missing, deleted,
 *    foreign-owned and otherwise inaccessible sites all receive the SAME
 *    generic not-found refusal (existence-hiding; never reveals whether
 *    another user's site exists). This holds in PERSONAL and ORGANIZATION
 *    workspaces alike: `GiftzSite` has `userId` ownership and no
 *    `organizationId` — ORGANIZATION availability never grants access to
 *    another member's sites and no shared-ownership model is invented.
 *  - file preparation mirrors the route exactly: `listProjectFiles(site.id)`
 *    → keep `encoding === "utf8"` AND `isTextPath(path)` rows → HTML pages
 *    from `.html`, stylesheets from `.css`, `localFiles` = the FULL actual
 *    `rows.map(r => r.path)`;
 *  - palette tokens come only from the site's stored config through the
 *    existing `getPalette()` registry — absent/invalid palette ⇒ the
 *    contrast check stays honestly `not-run`, colors are never guessed;
 *  - the EXISTING deterministic `runQualityGate()` output is passed through
 *    verbatim (overall, summary, pagesChecked, every check's real id/
 *    category/status/detail/capped evidence, and the mandatory `untested[]`
 *    list — never removed, replaced or weakened). No compiled HTML pages ⇒
 *    an honest refusal, never an empty report that looks successful.
 *  - build diagnostics: the newest existing `GiftzBuild` row for the same
 *    site is re-read and its `diagnosticsJson` parsed through the existing
 *    `parseBuildDiagnostics()` — only real stored information is returned
 *    (id, status, trigger, timestamps, summary, checks run, duration,
 *    diagnostic checks). `artifactJson` file CONTENTS are never read or
 *    returned; a missing/unparseable diagnostics record is stated honestly;
 *    a failed or in-progress build stays accurately labelled; an absent
 *    diagnostics record is never promoted into a "successful build" claim.
 *  - design consistency: `applyDesignConsistency()` (the existing pure
 *    lower-level engine) runs ONLY when the stored configuration parses
 *    through the existing `normalizeConfig()` parser AND the site's stored
 *    source prompt contains recognized direction vocabulary (the
 *    `SUPPORTED_DIRECTION_TERMS` allowlist) — otherwise the section returns
 *    `NOT_ASSESED` with the reason. Any suggestion is ADVISORY ONLY; the
 *    adjusted config the engine may compute is NEVER persisted and the site
 *    row is never modified. This is static design evidence — never presented
 *    as browser testing.
 *  - correction-task limitation: this tool NEVER creates an AgentTask, never
 *    edits files and never executes or approves anything. Corrections go
 *    through the existing `giftz.task.create` (AWAITING_APPROVAL) only when
 *    the user explicitly names an owned READY repository that actually
 *    corresponds to the audited project — no site-to-repository relation
 *    exists in the schema, and the report never claims one.
 *  - quota: the EXISTING `giftz-quality-gate:<userId>` rate-limit bucket
 *    (20/min — the same key and limit the studio API route uses) is reused;
 *    the RIISHE path opens NO separate quota loophole.
 *  - zero AI gateway calls, zero persistence, zero lifecycle writes of any
 *    kind. The normal RIISHE tool audit event (registry auditAction) is the
 *    only record — it must never be confused with a persisted GIFTZ quality
 *    report.
 */

import { z } from "zod";

import { db } from "@/lib/db";
import { rateLimit } from "@/lib/api-helpers";
import { isTextPath, listProjectFiles } from "@/lib/giftz/project-files";
import { runQualityGate, type QualityGateReport } from "@/lib/giftz/quality-gate";
import { parseBuildDiagnostics } from "@/lib/giftz/project-build";
import { getPalette } from "@/lib/site-palettes";
import { normalizeConfig } from "@/lib/site-config";
import { applyDesignConsistency, SUPPORTED_DIRECTION_TERMS } from "@/lib/giftz/component-intelligence";
import { defineTool, type RiisheToolDef, type ToolContext } from "@/lib/riishe/tool-contracts";

// ------------------------------------------------------------------ contract

const giftzQualityReportInput = z
  .object({
    siteId: z.string().trim().min(1).max(64).optional(),
    /** M35 typed reference (engine-resolved concrete site id) — a POINTER, never authorization. */
    siteRef: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.siteId ?? v.siteRef), {
    message: "one of siteId or siteRef is required",
  })
  .refine((v) => !(v.siteId && v.siteRef), {
    message: "provide only one of siteId or siteRef",
  });

export type GiftzQualityReportInput = z.infer<typeof giftzQualityReportInput>;

type QualityReportOutcome = Record<string, unknown> & {
  status: "QUALITY_REPORT" | "UNAUTHORIZED" | "NO_COMPILED_PAGES" | "RATE_LIMITED";
};

/** The mandatory static-versus-runtime statement every report carries. */
const STATIC_ANALYSIS_NOTE =
  "This is a deterministic static analysis of the stored GIFTZ project files, supplemented by recorded build diagnostics. It is not proof of live browser behavior.";

const OWNERSHIP_REFUSAL = "No accessible GIFTZ site exists for this request — nothing was analyzed.";
const CORRECTION_TASK_NOTE =
  "This report never creates tasks, never edits files and never executes or approves anything. If you want corrections prepared, explicitly name YOUR READY GIFTZ repository that actually corresponds to this project and use giftz.task.create — the task lands in AWAITING_APPROVAL and stays under the existing human approval boundary. No site-to-repository relation exists in the schema, so the report itself never claims a task targets this site.";

// ------------------------------------------------------------------ executor

async function giftzQualityReportExecute(
  ctx: ToolContext,
  input: GiftzQualityReportInput
): Promise<QualityReportOutcome> {
  // 0. The EXISTING per-user GIFTZ quality-gate quota — same helper, same
  //    key, same limit as the studio API route. No separate RIISHE quota.
  if (!rateLimit(`giftz-quality-gate:${ctx.userId}`, 20, 60_000)) {
    return {
      status: "RATE_LIMITED",
      reason:
        "The GIFTZ quality-gate rate limit (20 per minute, shared with the Website Studio API) is exhausted — try again shortly.",
      limitations: ["The existing studio quota applies unchanged; the RIISHE path opens no separate quota"],
    };
  }

  // 1. Resolve the locator. A siteRef arrives as the engine-resolved CONCRETE
  //    site id (M35 rules: explicit dependency, earlier success, no
  //    self/forward reference, result value present) — it is still only a
  //    pointer; ownership is re-read below with ctx.userId either way.
  const siteId = (input.siteId ?? input.siteRef)!.trim();

  // 2. Owner-scoped re-read — the pointer is never permission. Missing,
  //    deleted and foreign-owned sites are indistinguishable here.
  const site = await db.giftzSite.findFirst({
    where: { id: siteId, userId: ctx.userId },
    select: { id: true, title: true, status: true, config: true, sourcePrompt: true },
  });
  if (!site) {
    return { status: "UNAUTHORIZED", reason: OWNERSHIP_REFUSAL };
  }

  // 3. The exact project-file preparation of the existing quality-gate route.
  const rows = await listProjectFiles(site.id);
  const textRows = rows.filter((r) => r.encoding === "utf8" && isTextPath(r.path));
  const pages = textRows
    .filter((r) => r.path.toLowerCase().endsWith(".html"))
    .map((r) => ({ path: r.path, html: r.content }));
  const stylesheets = textRows
    .filter((r) => r.path.toLowerCase().endsWith(".css"))
    .map((r) => ({ path: r.path, css: r.content }));

  if (pages.length === 0) {
    return {
      status: "NO_COMPILED_PAGES",
      reason:
        "This site has no compiled HTML pages yet — generate or build the site first, then run the quality report. Nothing was analyzed and no empty report was produced.",
      limitations: ["A static quality report without compiled pages would be an empty report pretending to be evidence — it is refused instead"],
    };
  }

  // 4. Palette context from the stored config ONLY (the route's exact
  //    convention): absent/unparseable/non-registry palette ⇒ contrast is
  //    `not-run`, never guessed colors.
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

  // 5. The EXISTING deterministic gate — its output is passed through
  //    verbatim (every check id, category, status, detail, capped evidence
  //    and the mandatory untested[] list).
  const report: QualityGateReport = runQualityGate({
    pages,
    stylesheets,
    localFiles: rows.map((r) => r.path),
    palette,
  });

  // 6. Build diagnostics: the newest EXISTING build row for the same site.
  //    Only real stored information; artifactJson contents are NEVER read;
  //    absent/unparseable diagnostics are stated honestly.
  const build = await db.giftzBuild.findFirst({
    where: { siteId: site.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      trigger: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      diagnosticsJson: true,
    },
  });
  let buildDiagnostics: Record<string, unknown> | null = null;
  if (!build) {
    buildDiagnostics = {
      available: false,
      note: "No build has been recorded for this site — there are no build diagnostics to report. An absent diagnostics record is never treated as a successful build.",
    };
  } else {
    const parsed = parseBuildDiagnostics(build);
    buildDiagnostics = parsed
      ? {
          available: true,
          buildId: build.id,
          status: build.status,
          trigger: build.trigger,
          createdAt: build.createdAt.toISOString(),
          startedAt: build.startedAt?.toISOString() ?? null,
          finishedAt: build.finishedAt?.toISOString() ?? null,
          summary: parsed.summary,
          checksRun: parsed.checksRun,
          durationMs: parsed.durationMs,
          checks: parsed.checks,
          note:
            "Recorded build diagnostics only — no build, deployment or runtime test was started by this report, and artifact file contents are never read here.",
        }
      : {
          available: false,
          buildId: build.id,
          status: build.status,
          trigger: build.trigger,
          createdAt: build.createdAt.toISOString(),
          note:
            `A build row exists (status ${build.status}) but its stored diagnostics could not be parsed — nothing is inferred and the build is NOT reported as successful.`,
        };
  }

  // 7. Design consistency — ONLY where the stored configuration provides
  //    valid evidence: the config must parse through the existing normalizer
  //    AND the site's stored source prompt must contain recognized direction
  //    vocabulary. Otherwise: honest NOT_ASSESSED. Suggestions are advisory;
  //    nothing is persisted.
  let designConsistency: Record<string, unknown>;
  const storedDirection = site.sourcePrompt
    ? SUPPORTED_DIRECTION_TERMS.filter((term) =>
        new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(site.sourcePrompt!.toLowerCase())
      )
    : [];
  const config = site.config ? normalizeConfig(site.config) : null;
  if (!config) {
    designConsistency = {
      assessed: false,
      reason: "The site has no stored SiteConfig that parses through the existing configuration parser — no design-consistency evidence exists, and none is invented.",
    };
  } else if (storedDirection.length === 0) {
    designConsistency = {
      assessed: false,
      reason:
        "The stored source context supplies no recognized visual-direction vocabulary (registered terms like cinematic, luxury, minimal, immersive) — design consistency is NOT_ASSESSED rather than guessed.",
    };
  } else {
    // The site's real enabled animation set (the same projection
    // enforceDesignConsistency uses) checked against the real stored theme.
    const gsapIds = (config.motion.gsap?.animations ?? [])
      .filter((a) => a.enabled)
      .map((a) => `gsap:${a.preset}`);
    const bg = config.backgroundEffects?.enabled ? ["vanta-webgl-background"] : [];
    const result = applyDesignConsistency(
      { category: "existing-site", visualDirection: storedDirection, sections: [] },
      config.theme,
      [...gsapIds, ...bg]
    );
    designConsistency = {
      assessed: true,
      visualDirection: storedDirection,
      warnings: result.warnings,
      maxAnimationIntensity: result.maxAnimationIntensity,
      webglAllowed: result.webglAllowed,
      note:
        "Advisory static design-consistency evidence from the stored configuration only — any suggested animation-intensity adjustment is a recommendation for your review and was NOT applied; the site row and its config are untouched. This is not browser testing.",
    };
  }

  return {
    status: "QUALITY_REPORT",
    site: { id: site.id, title: site.title, status: site.status },
    report,
    buildDiagnostics,
    designConsistency,
    staticAnalysisNote: STATIC_ANALYSIS_NOTE,
    correctionTaskNote: CORRECTION_TASK_NOTE,
    limitations: [
      "Read-only: no GiftzSite, GiftzProjectFile, GiftzBuild, AgentTask or deployment row was created or modified — the normal RIISHE tool audit event is the only record and is not a persisted quality report",
      "Access stays bound to your own GIFTZ resources: GiftzSite is user-owned and has no organization ownership — an ORGANIZATION workspace never grants access to another member's sites",
      "Findings retain their real project-relative evidence paths and check ids; nothing is inferred from missing data points",
      "The quality gate's untested[] list is preserved verbatim — static analysis never claims live browser/device, rendered-contrast or runtime-performance proof",
    ],
    provenance: {
      sources: [
        "Your stored GIFTZ project file rows (listProjectFiles) through the existing quality-gate preparation",
        "The newest recorded GiftzBuild row's diagnostics (parseBuildDiagnostics)",
        ...(config ? ["The stored SiteConfig (existing normalizer) for advisory design-consistency evidence"] : []),
      ],
      method: "existing deterministic runQualityGate over the owner's stored project files — the same path as the Website Studio quality-gate API",
      analyzedAt: new Date().toISOString(),
    },
  };
}

// ------------------------------------------------------------------ registry

/** M36.6 GIFTZ quality tools — merged into the ONE RIISHE registry (tools.ts). */
export const GIFTZ_QUALITY_TOOLS: Record<string, RiisheToolDef<never>> = {
  "giftz.quality.report": defineTool({
    name: "giftz.quality.report",
    title: "Report on your site's quality",
    description:
      "Read-only deterministic STATIC quality report for ONE of YOUR GIFTZ sites, through the existing Website Studio quality-gate path: accessibility/semantic HTML, SEO structure, internal links and local assets, responsive and static-performance signals, the newest recorded build diagnostics and advisory design-consistency evidence. Every finding keeps its real check id and project-relative evidence; the untested[] list is always preserved — this is never live browser or runtime proof. No AI call, no persistence, no build, no task creation.",
    risk: "LOW",
    level: 1,
    category: "discovery",
    inputSchema: giftzQualityReportInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true, // read-only — re-execution cannot duplicate anything
    auditAction: "riishe.tool.giftz_quality_report",
    execute: giftzQualityReportExecute,
    undo: null, // read-only — nothing persists
  }),
};
