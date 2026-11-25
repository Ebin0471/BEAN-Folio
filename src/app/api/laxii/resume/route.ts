import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit, parseBody } from "@/lib/api-helpers";
import { aiGate } from "@/lib/ai";

import {
  resumeDataSchema,
  resumeFactsSchema,
  RESUME_SECTIONS,
  type ResumeSectionKey,
} from "@/lib/laxii/resume-schema";
import {
  ResumeServiceError,
  RevisionServiceError,
  generateResume,
  tailorResume,
  rephraseSection,
  saveResumeEdits,
  getResumeDetail,
  listResumes,
  createTailoredCopy,
} from "@/lib/laxii/resume-service";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// --------------------------------------------------------------------- GET

/**
 * GET /api/laxii/resume?conversationId=…  → one resume (detail)
 * GET /api/laxii/resume                   → the user's resume library
 */
export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const conversationId = new URL(req.url).searchParams.get("conversationId");
  if (conversationId) {
    try {
      return ok(await getResumeDetail(user.id, conversationId));
    } catch (e) {
      if (e instanceof ResumeServiceError && e.status === 404) return ERR.notFound();
      throw e;
    }
  }
  return ok({ resumes: await listResumes(user.id) });
});

// -------------------------------------------------------------------- POST

const factsShape = {
  basics: z.object({
    name: z.string().min(1).max(120),
    label: z.string().max(120).default(""),
    email: z.string().max(160).default(""),
    phone: z.string().max(60).default(""),
    website: z.string().max(240).default(""),
    location: z.string().max(160).default(""),
    summary: z.string().max(2000).default(""),
  }),
  work: z.array(z.any()).max(15).default([]),
  education: z.array(z.any()).max(10).default([]),
  skills: z.array(z.any()).max(40).default([]),
  projects: z.array(z.any()).max(10).default([]),
  certificates: z.array(z.any()).max(15).default([]),
  awards: z.array(z.any()).max(10).default([]),
  // Profession-specific sections (publications, licences…) — re-validated by
  // resumeFactsSchema in the service path.
  custom: z.array(z.any()).max(8).default([]),
};

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("generate"),
    conversationId: z.string().min(1).optional(),
    facts: z.object(factsShape),
    resumeType: z.string().default("ats"),
    targetTitle: z.string().max(160).default(""),
    jobDescription: z.string().max(8000).default(""),
    // Universal profession family (26) — adapts sections/labels/guidance.
    profession: z.string().max(60).optional(),
    // Text extracted from an uploaded resume — user-provided source material.
    sourceText: z.string().max(10000).optional(),
  }),
  z.object({
    action: z.literal("tailor"),
    conversationId: z.string().min(1),
    jobDescription: z.string().min(1).max(8000),
    targetTitle: z.string().max(160).optional(),
  }),
  z.object({
    // M33.5-C: create a job-specific COPY — the master resume is untouched.
    action: z.literal("tailor_copy"),
    conversationId: z.string().min(1),
    jobDescription: z.string().min(1).max(8000),
    targetTitle: z.string().max(160).optional(),
    // Full JD text stored ONLY with this explicit opt-in (privacy notice in UI).
    saveFullJobDescription: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("rephrase"),
    conversationId: z.string().min(1),
    section: z.enum(RESUME_SECTIONS),
  }),
]);

/**
 * POST /api/laxii/resume — document actions (never routed through the image
 * engine). generate: AI draft from facts. tailor: re-emphasis against a job
 * description. rephrase: wording-only improvement of one section.
 *
 * Every AI action passes the shared consent + quota gate (aiGate) so resume
 * generation is accounted in the same honest quota pool as RIISHE/Code Giftz.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-resume:${user.id}`, 6, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, postSchema);
  if (r.response) return r.response;
  const body = r.data;

  const gated = await aiGate(user);
  if (gated) return gated;

  try {
    if (body.action === "generate") {
      const factsParsed = resumeFactsSchema.safeParse(body.facts);
      if (!factsParsed.success) {
        const first = factsParsed.error.issues[0];
        const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
        return err(`Invalid resume facts — ${where}${first?.message ?? "validation failed"}`, 400);
      }
      const result = await generateResume({
        userId: user.id,
        conversationId: body.conversationId,
        facts: factsParsed.data,
        resumeType: body.resumeType,
        targetTitle: body.targetTitle,
        jobDescription: body.jobDescription,
        ...(body.profession ? { profession: body.profession } : {}),
        ...(body.sourceText ? { sourceText: body.sourceText } : {}),
      });
      return ok(result);
    }

    if (body.action === "tailor") {
      const result = await tailorResume({
        userId: user.id,
        conversationId: body.conversationId,
        jobDescription: body.jobDescription,
        targetTitle: body.targetTitle,
      });
      return ok(result);
    }

    if (body.action === "tailor_copy") {
      const result = await createTailoredCopy({
        userId: user.id,
        conversationId: body.conversationId,
        jobDescription: body.jobDescription,
        targetTitle: body.targetTitle,
        ...(typeof body.saveFullJobDescription === "boolean" ? { saveFullJobDescription: body.saveFullJobDescription } : {}),
      });
      return ok(result);
    }

    const result = await rephraseSection({
      userId: user.id,
      conversationId: body.conversationId,
      section: body.section as ResumeSectionKey,
    });
    return ok(result);
  } catch (e) {
    if (e instanceof ResumeServiceError) {
      return err(e.message, e.status >= 500 ? 502 : e.status);
    }
    log.error("laxii.resume.unexpected_failure", { message: String(e instanceof Error ? e.message : e).slice(0, 300) });
    return err("Resume generation failed. Please try again.", 502);
  }
});

// ------------------------------------------------------------------- PATCH

const patchSchema = z.object({
  conversationId: z.string().min(1),
  data: resumeDataSchema,
  template: z.enum(["classic", "modern", "minimal", "creative"]).optional(),
  resumeType: z.string().optional(),
});

/** PATCH /api/laxii/resume — save manual user edits / template switch. */
export const PATCH = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-resume-save:${user.id}`, 30, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;

  try {
    await saveResumeEdits({
      userId: user.id,
      conversationId: r.data.conversationId,
      data: r.data.data,
      template: r.data.template,
      resumeType: r.data.resumeType,
    });
    return ok({ ok: true });
  } catch (e) {
    if (e instanceof ResumeServiceError && e.status === 404) return ERR.notFound();
    if (e instanceof ResumeServiceError) return err(e.message, 400);
    throw e;
  }
});
