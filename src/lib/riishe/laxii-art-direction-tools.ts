/**
 * RIISHE LAXII art-direction tools (M36.7) — the LAXII Art Director's ONE
 * real capability over the EXISTING LAXII services, registries and
 * quality-evaluation results.
 *
 * `laxii.art.direction` is a READ-ONLY, deterministic, advisory art-direction
 * and output-review capability — NOT a new image-generation system, NOT a
 * second pipeline, NOT a brief editor:
 *  - direction classification runs the EXISTING deterministic seven-direction
 *    classifier (src/lib/laxii/art-direction.ts — detectArtDirection). Weak or
 *    ambiguous signals return an honest unresolved direction; a confident
 *    direction is never invented when the source words do not support one.
 *  - style recommendations reference ONLY real registered STYLE_PRESETS slugs
 *    (src/lib/laxii/styles.ts) through an explicit documented mapping; the
 *    server-side `promptFragment` is never exposed (public metadata only).
 *  - typography recommendations come from the EXISTING provisioned-font
 *    recommender (src/lib/laxii/font-assets.ts recommendBannerFontPairing)
 *    driven ONLY by explicit tone/audience/purpose values. User-selected
 *    typography in a brief is reported as authoritative and is never silently
 *    overridden. Multilingual glyph coverage is never claimed beyond what the
 *    recommender itself states.
 *  - palette, subject, composition, canvas and safe-area data are the brief's
 *    OWN stored fields, passed through verbatim. An absent palette is stated
 *    honestly — hex values are never invented.
 *  - an optional brand-kit proposal (src/lib/brand-kit.ts) is produced ONLY
 *    from explicit user-supplied attributes (no psychometric inference, no
 *    silent substitution); unknown explicit ids remain REJECTIONS surfaced via
 *    the existing brandKitRejection conversion — never replacements.
 *  - for an explicitly identified generation job, the ALREADY-RECORDED
 *    quality report stored by the real banner pipeline in the completed
 *    LaxiiMessage.metaJson is read, structurally validated, and returned with
 *    the EXISTING refinementDirectives() mapping. Nothing is re-generated, no
 *    measurement invented, no missing report promoted into a verdict: RUNNING
 *    and FAILED jobs are labelled truthfully, a DONE job without a readable
 *    report states that quality evidence is unavailable, and malformed
 *    metadata is refused rather than guessed at. Raw metaJson, provider
 *    internals and binary image data are never returned.
 *  - an optional proposed revision is compiled IN MEMORY with the EXISTING
 *    appendRevision()/compileRevisionAddenda() functions and returned as a
 *    clearly-labelled PREVIEW. The write path reviseBriefTask() is never
 *    called: no AgentTask, no resultJson, no status change, no database row
 *    of any kind is created or updated. The existing three-revision maximum
 *    is honoured honestly. Saving a revision remains an explicit user action
 *    in the existing LAXII workflow.
 *  - ownership: briefs load through the EXISTING owner-scoped
 *    loadBriefTask(ctx.userId, taskId); jobs read through an owner-scoped
 *    message query (`conversation: { userId: ctx.userId }`). Typed
 *    `briefTaskRef`/`jobRef` references are POINTERS, never authorization —
 *    ownership is re-read with ctx.userId on every execution. Foreign-owned,
 *    missing, deleted and unparseable records all receive the SAME generic
 *    refusal (existence-hiding), in PERSONAL and ORGANIZATION workspaces
 *    alike: LAXII records are user-owned and ORGANIZATION availability never
 *    grants access to another member's private briefs, jobs or media.
 *  - zero AI gateway calls, zero provider generation, zero image spending,
 *    zero persistence, zero builds/deployments, zero task creation. The
 *    normal RIISHE tool audit event (registry auditAction) is the only
 *    record. No new rate-limit bucket is opened: the tool performs only
 *    bounded deterministic reads (the laxii.job.status read-only precedent).
 */

import { z } from "zod";

import { db } from "@/lib/db";
import {
  detectArtDirection,
  artDirections,
  type ArtDirectionId,
} from "@/lib/laxii/art-direction";
import {
  appendRevision,
  compileRevisionAddenda,
  type BriefRevision,
  type DesignBrief,
} from "@/lib/laxii/design-brief";
import { STYLE_PRESETS } from "@/lib/laxii/styles";
import { recommendBannerFontPairing } from "@/lib/laxii/font-assets";
import {
  buildBrandKitProposal,
  brandKitRejection,
  BrandKitFieldError,
  type BrandKitRawInput,
} from "@/lib/brand-kit";
import { refinementDirectives, type QualityReport } from "@/lib/laxii/quality";
import { loadBriefTask } from "@/lib/intelligence/delegation";
import { defineTool, type RiisheToolDef, type ToolContext } from "@/lib/riishe/tool-contracts";

// ------------------------------------------------------------------ contract

const laxiiArtDirectionInput = z
  .object({
    /** Existing OWNED structured brief task (direct id). */
    briefTaskId: z.string().trim().min(1).max(64).optional(),
    /** M35 typed reference (engine-resolved concrete brief task id) — a POINTER, never authorization. */
    briefTaskRef: z.string().trim().min(1).max(40).optional(),
    /** M35 typed reference (engine-resolved concrete generation message id) — a POINTER, never authorization. */
    jobRef: z.string().trim().min(1).max(40).optional(),
    /** Direct generation message id (the durable LAXII job). */
    messageId: z.string().trim().min(1).max(64).optional(),
    /** Explicit fresh request for an advisory-only direction proposal (no brief or task is created). */
    request: z.string().trim().min(1).max(2000).optional(),
    /** Explicit tone words — used ONLY with an explicit request; never inferred. */
    toneWords: z.array(z.string().trim().min(1).max(40)).max(6).optional(),
    /** Explicit audience description — used ONLY with an explicit request. */
    audience: z.string().trim().min(1).max(200).optional(),
    /** Explicit purpose description — used ONLY with an explicit request. */
    purpose: z.string().trim().min(1).max(200).optional(),
    /**
     * Optional targeted revision PREVIEW (in-memory only — never persisted).
     * Requires an existing owned structured brief; uses ONLY the existing
     * schema revision areas and the existing instruction bound (600 chars).
     */
    proposedRevision: z
      .object({
        area: z.enum([
          "subject", "background", "composition", "palette", "typography",
          "text-placement", "safe-area", "overall",
        ]),
        instruction: z.string().trim().min(1).max(600),
      })
      .optional(),
    /**
     * Optional explicit brand-kit attributes for an additional registry-backed
     * proposal. ONLY schema-supported explicit attributes are accepted and
     * passed through — unknown ids remain rejections, never substitutions;
     * nothing is inferred and nothing is applied or persisted.
     */
    brandKitContext: z
      .object({
        brandName: z.string().trim().min(1).max(80).optional(),
        sector: z.string().trim().min(1).max(120).optional(),
        languages: z.array(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)).max(6).optional(),
        paletteDirection: z.string().trim().min(1).max(48).optional(),
        fontOverride: z
          .object({
            heading: z.string().trim().min(1).max(48),
            body: z.string().trim().min(1).max(48),
            accent: z.string().trim().min(1).max(48).optional(),
            weights: z.array(z.number().int().min(100).max(900)).max(6).optional(),
          })
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => Boolean(v.briefTaskId ?? v.briefTaskRef ?? v.jobRef ?? v.messageId ?? v.request), {
    message: "one of briefTaskId, briefTaskRef, jobRef, messageId or request is required",
  })
  .refine((v) => !(v.briefTaskId && v.briefTaskRef), {
    message: "provide only one of briefTaskId or briefTaskRef",
  })
  .refine((v) => !(v.jobRef && v.messageId), {
    message: "provide only one of jobRef or messageId",
  })
  .refine(
    (v) => !(Boolean(v.briefTaskId ?? v.briefTaskRef) && Boolean(v.jobRef ?? v.messageId)),
    { message: "a request may not simultaneously identify a brief and a job" }
  )
  .refine(
    (v) => !(v.request && (v.briefTaskId || v.briefTaskRef || v.jobRef || v.messageId)),
    { message: "an explicit request cannot be combined with a brief or job source — provide exactly one source" }
  )
  .refine(
    (v) => v.toneWords === undefined && v.audience === undefined && v.purpose === undefined ? true : Boolean(v.request),
    { message: "toneWords, audience and purpose are explicit request context and require an explicit request source" }
  )
  .refine(
    (v) => v.proposedRevision === undefined ? true : Boolean(v.briefTaskId ?? v.briefTaskRef),
    { message: "a proposed revision preview requires an existing owned brief (briefTaskId or briefTaskRef)" }
  )
  .refine(
    (v) => v.brandKitContext === undefined ? true : Boolean(v.request),
    { message: "brandKitContext supplies explicit attributes for an advisory proposal and requires an explicit request source" }
  );

export type LaxiiArtDirectionInput = z.infer<typeof laxiiArtDirectionInput>;

// ------------------------------------------------------------------ helpers

/** The ONE generic ownership refusal — identical wording for every inaccessible record kind. */
const OWNERSHIP_REFUSAL =
  "No accessible LAXII record exists for this request — nothing was analyzed.";

type ArtDirectionOutcome = Record<string, unknown> & {
  status: "ART_DIRECTION" | "JOB_REVIEW" | "UNAUTHORIZED";
};

/**
 * Explicit, documented mapping from the seven classifier directions to real
 * registered STYLE_PRESETS slugs. Every slug is verified against the live
 * registry by tests; a slug that ever disappeared from STYLE_PRESETS is
 * filtered out at runtime rather than recommended as a ghost.
 */
const DIRECTION_STYLE_MAP: Record<ArtDirectionId, string[]> = {
  "photorealistic-photography": ["professional-photography", "corporate-headshot", "editorial-fashion"],
  cinematic: ["cinematic-portrait", "movie-poster"],
  "commercial-advertising": ["product-photography"],
  "luxury-editorial": ["luxury-minimal", "portfolio-cover"],
  "graphic-design": ["business-banner", "portfolio-cover"],
  "3d-render": ["3d-character"],
  "illustration-concept-art": ["anime", "fantasy-art"],
};

/**
 * Structural validation of a STORED quality report (produced by the real
 * pipeline, persisted by the existing worker). Returns null when the record
 * does not parse into the honest report shape — the caller then refuses to
 * infer a verdict instead of guessing.
 */
function validateStoredQualityReport(raw: unknown): QualityReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.overall !== "pass" && r.overall !== "warn" && r.overall !== "fail") return null;
  if (r.evaluator !== "deterministic" && r.evaluator !== "deterministic+ai-review") return null;
  if (typeof r.evaluatedAt !== "string" || r.evaluatedAt.length === 0) return null;
  if (!Array.isArray(r.findings) || r.findings.length > 200) return null;
  const areas = new Set(["technical", "visual", "typography", "compliance"]);
  const statuses = new Set(["pass", "warn", "fail"]);
  for (const f of r.findings) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return null;
    const finding = f as Record<string, unknown>;
    if (typeof finding.id !== "string" || finding.id.length === 0 || finding.id.length > 120) return null;
    if (typeof finding.area !== "string" || !areas.has(finding.area)) return null;
    if (typeof finding.status !== "string" || !statuses.has(finding.status)) return null;
    if (typeof finding.check !== "string" || finding.check.length === 0 || finding.check.length > 600) return null;
    if (finding.measured !== undefined && (typeof finding.measured !== "string" || finding.measured.length > 600)) return null;
    if (finding.note !== undefined && (typeof finding.note !== "string" || finding.note.length > 600)) return null;
  }
  if (r.aiReview !== undefined) {
    const ai = r.aiReview;
    if (!ai || typeof ai !== "object" || Array.isArray(ai)) return null;
    const review = ai as Record<string, unknown>;
    if (review.ran !== true) return null;
    if (typeof review.note !== "string" || review.note.length === 0 || review.note.length > 600) return null;
    if (!Array.isArray(review.findings) || review.findings.length > 8) return null;
    for (const item of review.findings) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const f = item as Record<string, unknown>;
      if (typeof f.area !== "string" || f.area.length === 0 || f.area.length > 40) return null;
      if (f.severity !== "minor" && f.severity !== "major") return null;
      if (typeof f.note !== "string" || f.note.length === 0 || f.note.length > 300) return null;
    }
  }
  return raw as QualityReport;
}

/** Public style metadata only — the server-side promptFragment is never shipped. */
function publicPreset(slug: string) {
  const preset = STYLE_PRESETS.find((s) => s.slug === slug);
  if (!preset) return null;
  return {
    slug: preset.slug,
    label: preset.label,
    blurb: preset.blurb,
    defaultAspect: preset.defaultAspect,
    referenceBehavior: preset.referenceBehavior,
  };
}

/** Registry-backed style recommendations for one resolved direction (bounded, honest basis). */
function styleRecommendationsFor(directionId: ArtDirectionId | null): {
  recommendations: Record<string, unknown>[];
  limitation: string | null;
} {
  if (!directionId) {
    return {
      recommendations: [],
      limitation:
        "No art direction could be resolved from the source words, so no style preset is recommended — a confident match is never invented when the evidence does not support one.",
    };
  }
  const recommendations: Record<string, unknown>[] = [];
  for (const slug of DIRECTION_STYLE_MAP[directionId]) {
    if (recommendations.length >= 3) break;
    const preset = publicPreset(slug);
    // A slug that ever disappeared from STYLE_PRESETS is filtered out at
    // runtime rather than recommended as a ghost (tests pin every current slug).
    if (preset) recommendations.push({ ...preset, basis: `registered style preset mapped to the detected "${directionId}" art direction` });
  }
  return { recommendations, limitation: null };
}

// ------------------------------------------------------------------ executor

async function laxiiArtDirectionExecute(
  ctx: ToolContext,
  input: LaxiiArtDirectionInput
): Promise<ArtDirectionOutcome> {
  // ---- 0. Resolve exactly one source. Typed refs arrive as engine-resolved
  //         concrete ids (M35 rules); they remain pointers — ownership is
  //         re-read with ctx.userId below either way.
  const hasBrief = Boolean(input.briefTaskId ?? input.briefTaskRef);
  const hasJob = Boolean(input.jobRef ?? input.messageId);

  if (hasJob) {
    return reviewGenerationJob(ctx, input);
  }
  return proposeDirection(ctx, input, hasBrief);
}

// ---------------------------------------------------------- path B: job review

/**
 * Read-only review of ONE explicitly identified generation job: the stored
 * state plus the ALREADY-RECORDED pipeline quality report, honestly labelled.
 * The image provider is never called, the worker is never restarted and the
 * quality pipeline is never re-run here.
 */
async function reviewGenerationJob(
  ctx: ToolContext,
  input: LaxiiArtDirectionInput
): Promise<ArtDirectionOutcome> {
  const messageId = (input.messageId ?? input.jobRef)!.trim();

  // Owner-scoped read through the OWNING conversation — the pointer is never
  // permission. Only report-relevant fields are selected: no binary image
  // data, no version media, no provider internals.
  const msg = await db.laxiiMessage.findFirst({
    where: { id: messageId, conversation: { userId: ctx.userId } },
    select: { id: true, conversationId: true, role: true, operation: true, status: true, error: true, metaJson: true },
  });
  if (!msg) {
    return { status: "UNAUTHORIZED", reason: OWNERSHIP_REFUSAL };
  }

  const limitations = [
    "Read-only: no LaxiiMessage, LaxiiImageVersion, conversation or media row was created or modified — the normal RIISHE tool audit event is the only record",
    "The provider is never called, the worker is never restarted and the quality pipeline is never re-run by this review",
    "Raw message metadata, provider internals and binary image data are never returned",
    "Access stays bound to your own LAXII records: conversations and messages are user-owned and an ORGANIZATION workspace never grants access to another member's jobs",
  ];

  // RUNNING: the pipeline has not produced its verdict — never fabricate one.
  if (msg.status === "RUNNING") {
    return {
      status: "JOB_REVIEW",
      job: { messageId: msg.id, conversationId: msg.conversationId, operation: msg.operation, status: msg.status },
      qualityEvidence: {
        available: false,
        reason:
          "The generation is still RUNNING — no completed quality verdict exists yet. Poll laxii.job.status or the studio thread; this review never invents findings for an unfinished job.",
      },
      limitations,
      provenance: {
        sources: ["The stored LaxiiMessage row (status/operation) through an owner-scoped read"],
        method: "read-only review of the recorded job state and stored quality evidence — nothing re-generated",
        reviewedAt: new Date().toISOString(),
      },
    };
  }

  // FAILED: the recorded failure is the truth; no quality findings exist.
  if (msg.status === "FAILED") {
    return {
      status: "JOB_REVIEW",
      job: { messageId: msg.id, conversationId: msg.conversationId, operation: msg.operation, status: msg.status, error: msg.error },
      qualityEvidence: {
        available: false,
        reason:
          "The generation FAILED — the recorded error is reported above and no quality verdict is invented. Use laxii.job.status for the outcome details or start a fresh generation through the existing approved flow.",
      },
      limitations,
      provenance: {
        sources: ["The stored LaxiiMessage row (status/error) through an owner-scoped read"],
        method: "read-only review of the recorded job state and stored quality evidence — nothing re-generated",
        reviewedAt: new Date().toISOString(),
      },
    };
  }

  // DONE: the stored quality report (recorded by the real pipeline) is the
  // only admissible evidence. Absent or malformed reports degrade honestly.
  let storedRaw: unknown = null;
  try {
    const meta: unknown = msg.metaJson ? JSON.parse(msg.metaJson) : null;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      storedRaw = (meta as Record<string, unknown>).qualityReport ?? null;
    }
  } catch {
    storedRaw = null; // malformed metadata — refused below, never guessed at
  }

  const report = validateStoredQualityReport(storedRaw);
  if (!report) {
    return {
      status: "JOB_REVIEW",
      job: { messageId: msg.id, conversationId: msg.conversationId, operation: msg.operation, status: msg.status },
      qualityEvidence: {
        available: false,
        reason:
          "The job is DONE but no structurally valid quality report is stored on it — quality evidence is unavailable and no verdict is inferred. Plain generations and older jobs may not carry a pipeline quality report; re-running the pipeline to manufacture evidence is out of scope for a read-only review.",
      },
      limitations,
      provenance: {
        sources: ["The stored LaxiiMessage row (status/operation/metaJson qualityReport) through an owner-scoped read"],
        method: "read-only review of the recorded job state and stored quality evidence — nothing re-generated",
        reviewedAt: new Date().toISOString(),
      },
    };
  }

  // Valid stored report: return its ACTUAL findings verbatim plus the
  // EXISTING refinement-directive mapping over the validated report. AI-review
  // findings stay explicitly advisory (the report's own note is preserved).
  const directives = refinementDirectives(report);
  return {
    status: "JOB_REVIEW",
    job: { messageId: msg.id, conversationId: msg.conversationId, operation: msg.operation, status: msg.status },
    qualityEvidence: {
      available: true,
      report,
      evaluatorNote:
        report.evaluator === "deterministic+ai-review"
          ? "The recorded report combines deterministic measurements with an optional AI visual review; the AI-review findings inside the report are ADVISORY and non-deterministic — judge with your own eyes before exporting."
          : "The recorded report carries deterministic measurements only — no AI visual review ran for this job.",
      aiReviewNote: report.aiReview?.note ?? null,
      refinementDirectives: directives,
      refinementDirectivesNote:
        directives.length > 0
          ? "Actionable refinement directives derived from the stored failed/warning findings via the existing refinementDirectives() mapping. These are advisory suggestions for your next approved generation — nothing was applied or scheduled."
          : "No failed or warning findings were recorded, so no refinement directive applies.",
    },
    limitations,
    provenance: {
      sources: ["The stored quality report recorded by the real LAXII pipeline in the completed job's metadata"],
      method: "read-only review of the recorded job state and stored quality evidence — nothing re-generated",
      reviewedAt: new Date().toISOString(),
    },
  };
}

// --------------------------------------------- paths A/C: direction proposal

/**
 * Advisory direction proposal from an OWNED structured brief or an explicit
 * fresh request. Deterministic-first: the existing classifier, the real
 * registries and the brief's own stored fields only.
 */
async function proposeDirection(
  ctx: ToolContext,
  input: LaxiiArtDirectionInput,
  isBriefSource: boolean
): Promise<ArtDirectionOutcome> {
  let brief: DesignBrief | null = null;
  let briefTaskId: string | null = null;
  let briefStatus: string | null = null;

  if (isBriefSource) {
    const taskId = (input.briefTaskId ?? input.briefTaskRef)!.trim();
    // The EXISTING owner-scoped loader — missing, foreign-owned and
    // unparseable briefs all return null and receive the SAME generic refusal.
    const loaded = await loadBriefTask(ctx.userId, taskId);
    if (!loaded) {
      return { status: "UNAUTHORIZED", reason: OWNERSHIP_REFUSAL };
    }
    brief = loaded.brief;
    briefTaskId = loaded.id;
    briefStatus = loaded.status;
  }

  const limitations: string[] = [
    "Read-only and advisory: no brief task, AgentTask, LaxiiMessage, media asset or configuration was created or modified — the normal RIISHE tool audit event is the only record",
    "Recommendations identify their basis explicitly; production always runs through the existing approved flow (laxii.banner.produce stays MEDIUM / level 2 with explicit owner approval)",
    ...(brief
      ? [
          "The brief's stored fields are passed through verbatim; nothing is inferred into them",
        ]
      : [
          "Only the values you supplied in this request were used — no portfolio, visual identity or other stored context was loaded",
        ]),
  ];

  // ---- 1. Direction: the EXISTING deterministic classifier over the source
  //         words (the brief's authoritative request, or the explicit request).
  const sourceText = brief ? brief.request : input.request!;
  const direction = detectArtDirection(sourceText);

  const directionBlock: Record<string, unknown> = direction
    ? {
        resolved: true,
        id: direction.id,
        label: direction.label,
        directive: direction.directive,
        basis: brief
          ? "deterministic classification of the brief's stored request (existing seven-direction classifier)"
          : "deterministic classification of your explicit request (existing seven-direction classifier)",
      }
    : {
        resolved: false,
        note:
          "The source words carry no confident art-direction signal — the deterministic classifier returned no direction, and none was invented. The seven recognisable directions are: " +
          artDirections().map((d) => d.id).join(", ") +
          ". Name one of them explicitly (or use stronger vocabulary) and re-run for a resolved direction.",
      };

  // ---- 2. Registered style recommendations (real slugs only, public metadata).
  const styles = styleRecommendationsFor(direction ? direction.id : null);

  // ---- 3. Typography: the EXISTING provisioned-font recommender, driven by
  //         explicit values only. For a brief: the brief's own tone words and
  //         audience (a brief carries no purpose field, so none is invented).
  const pairing = recommendBannerFontPairing(
    brief
      ? {
          ...(brief.visualIdentity.toneWords.length > 0 ? { toneWords: brief.visualIdentity.toneWords } : {}),
          ...(brief.targetAudience ? { audience: brief.targetAudience } : {}),
        }
      : {
          ...(input.toneWords && input.toneWords.length > 0 ? { toneWords: input.toneWords } : {}),
          ...(input.audience ? { audience: input.audience } : {}),
          ...(input.purpose ? { purpose: input.purpose } : {}),
        }
  );
  const userTypography = brief && brief.typography.items.length > 0 ? brief.typography.items : null;
  const typographyBlock: Record<string, unknown> = {
    recommendation: pairing,
    basis: brief
      ? `the existing provisioned-font recommender driven by the brief's explicit tone words and audience${brief.visualIdentity.toneWords.length === 0 && !brief.targetAudience ? " (the brief states neither — the recommender's honest default pairing is shown and says so)" : ""}`
      : `the existing provisioned-font recommender driven only by the tone words, audience and purpose you supplied${!input.toneWords?.length && !input.audience && !input.purpose ? " (none were supplied — the default pairing is shown and says so)" : ""}`,
    userSelectedAuthoritative:
      userTypography
        ? {
            note:
              "The brief's exact typography below is the user's selection and stays authoritative — the recommendation above is advisory and never silently overrides it.",
            items: userTypography,
          }
        : null,
  };

  // ---- 4. Palette: the brief's stored hex values verbatim; an absent palette
  //         is stated honestly — colors are never invented.
  const paletteBlock: Record<string, unknown> = brief
    ? brief.palette.length > 0
      ? {
          provided: true,
          colors: brief.palette,
          basis: "the brief's stored palette values, verbatim",
        }
      : {
          provided: false,
          note: "The brief carries no explicit palette — no colors are invented here.",
        }
    : {
        provided: false,
        note:
          "The explicit request supplies no palette values, and none are invented. Provide exact hex values (or a brief through laxii.banner.brief) for grounded color direction.",
      };

  // ---- 5. Composition and canvas: the brief's stored fields verbatim (brief
  //         path only). The request path honestly reports what it does not have.
  const compositionBlock: Record<string, unknown> = brief
    ? {
        subject: brief.subject,
        background: brief.background,
        composition: brief.composition,
        canvas: brief.canvas,
        safeArea: brief.safeArea,
        preserve: brief.preserve,
        avoid: brief.avoid,
        basis: "the brief's stored fields, verbatim",
      }
    : {
        note:
          "No structured composition fields exist for an explicit request — subject, focal point, background, safe area and canvas come from a structured brief. Prepare one through laxii.banner.brief for grounded composition planning; nothing was created here.",
      };

  // ---- 6. Optional in-memory revision PREVIEW (brief path only, enforced by
  //         the schema). The existing appendRevision()/compileRevisionAddenda()
  //         compile the preview; NOTHING is persisted.
  let revisionPreview: Record<string, unknown> | null = null;
  if (brief && input.proposedRevision) {
    if (brief.revisions.length >= 3) {
      revisionPreview = {
        produced: false,
        reason:
          "This brief already carries the maximum of 3 targeted revisions — the existing limit is honoured and no fourth revision is prepared. Generate with what you have or start a new brief through the existing LAXII workflow.",
      };
    } else {
      const previewBrief = appendRevision(brief, input.proposedRevision.area, input.proposedRevision.instruction);
      const addenda = compileRevisionAddenda(previewBrief);
      const revision: BriefRevision = previewBrief.revisions[previewBrief.revisions.length - 1];
      revisionPreview = {
        produced: true,
        preview: true,
        revision: { area: revision.area, instruction: revision.instruction, at: revision.at },
        compiledAddendum: addenda[addenda.length - 1],
        scopeNote:
          "The compiled addendum affects ONLY the named revision area — everything outside it stays as approved. This is an IN-MEMORY PREVIEW: the brief task, its resultJson and its status are untouched, no database row was written, and the existing write path (reviseBriefTask) was not called. Saving a revision remains an explicit action in the existing LAXII workflow.",
      };
    }
  }

  // ---- 7. Optional brand-kit proposal — ONLY explicit, schema-supported
  //         attributes from the request context; unknown ids remain
  //         rejections surfaced through the existing conversion helper.
  let brandKit: Record<string, unknown> | null = null;
  if (input.brandKitContext) {
    const raw: BrandKitRawInput = {
      ...(input.brandKitContext.brandName ? { brandName: input.brandKitContext.brandName } : {}),
      ...(input.brandKitContext.sector ? { sector: input.brandKitContext.sector } : {}),
      ...(input.brandKitContext.languages ? { languages: input.brandKitContext.languages } : {}),
      ...(input.brandKitContext.paletteDirection ? { paletteDirection: input.brandKitContext.paletteDirection } : {}),
      ...(input.brandKitContext.fontOverride ? { fontOverride: input.brandKitContext.fontOverride } : {}),
      ...(input.toneWords && input.toneWords.length > 0 ? { toneAdjectives: input.toneWords } : {}),
      ...(input.audience ? { audience: input.audience } : {}),
    };
    try {
      const proposal = buildBrandKitProposal(raw);
      brandKit = {
        ok: true,
        proposal,
        basis: "the existing brand-kit engine over the explicit attributes you supplied — registry-backed proposal only, nothing applied or persisted",
      };
    } catch (e) {
      if (e instanceof BrandKitFieldError) {
        brandKit = {
          ok: false,
          rejection: brandKitRejection(e),
          basis:
            "the existing brand-kit engine rejected an explicit attribute — unknown ids are rejections, never silently substituted",
        };
      } else {
        throw e;
      }
    }
  }

  return {
    status: "ART_DIRECTION",
    source: brief
      ? { kind: "brief", briefTaskId, briefTaskStatus: briefStatus }
      : { kind: "request" },
    ...(brief
      ? {
          brief: {
            request: brief.request,
            profession: brief.profession,
            targetAudience: brief.targetAudience,
            toneWords: brief.visualIdentity.toneWords,
            storedDirection: brief.direction,
            revisionsCount: brief.revisions.length,
          },
        }
      : {}),
    direction: directionBlock,
    styleRecommendations: styles.recommendations,
    ...(styles.limitation ? { styleLimitation: styles.limitation } : {}),
    typographyRecommendation: typographyBlock,
    palette: paletteBlock,
    compositionEvidence: compositionBlock,
    ...(revisionPreview ? { revisionPreview } : {}),
    ...(brandKit ? { brandKit } : {}),
    limitations,
    provenance: {
      sources: brief
        ? [
            "Your stored structured brief (loadBriefTask — owner-scoped) through the existing parser",
            "The existing deterministic art-direction classifier (detectArtDirection)",
            "The existing registered style registry (STYLE_PRESETS public metadata only)",
            "The existing provisioned-font recommender (recommendBannerFontPairing)",
          ]
        : [
            "The explicit request values you supplied in this call",
            "The existing deterministic art-direction classifier (detectArtDirection)",
            "The existing registered style registry (STYLE_PRESETS public metadata only)",
            "The existing provisioned-font recommender (recommendBannerFontPairing)",
          ],
      method: "deterministic advisory art direction over existing LAXII registries and stored brief data — no generation, no persistence",
      analyzedAt: new Date().toISOString(),
    },
  };
}

// ------------------------------------------------------------------ registry

/** M36.7 LAXII art-direction tools — merged into the ONE RIISHE registry (tools.ts). */
export const LAXII_ART_DIRECTION_TOOLS: Record<string, RiisheToolDef<never>> = {
  "laxii.art.direction": defineTool({
    name: "laxii.art.direction",
    title: "Advise on art direction or review a recorded job",
    description:
      "Read-only advisory art direction over the EXISTING LAXII services: classify a brief or explicit request into one of seven professional directions, recommend real registered style presets and provisioned typography pairings, preserve the brief's exact palette and composition data, review the ALREADY-RECORDED quality report of one of your generation jobs, and prepare an optional IN-MEMORY revision preview for your own brief. Nothing is generated, applied, saved or approved — production still runs through the existing approved banner flow.",
    risk: "LOW",
    level: 1,
    category: "content",
    inputSchema: laxiiArtDirectionInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true, // read-only — re-execution cannot duplicate anything
    auditAction: "riishe.tool.art_direction",
    execute: laxiiArtDirectionExecute,
    undo: null, // read-only — nothing persists
  }),
};
