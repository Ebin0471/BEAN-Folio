import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit, parseBody } from "@/lib/api-helpers";
import { aiGate } from "@/lib/ai";

import { coverLetterDataSchema, COVER_LETTER_TONES, COVER_LETTER_LENGTHS } from "@/lib/laxii/cover-letter-schema";
import {
  CoverLetterError,
  generateCoverLetter,
  rephraseLetterParagraph,
  duplicateCoverLetter,
  saveCoverLetterEdits,
  listCoverLetters,
  getCoverLetterDetail,
} from "@/lib/laxii/cover-letter-service";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// --------------------------------------------------------------------- GET

/**
 * GET /api/laxii/cover-letter?letterId=…  → one letter (detail)
 * GET /api/laxii/cover-letter             → the user's private letter library
 */
export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const letterId = new URL(req.url).searchParams.get("letterId");
  if (letterId) {
    try {
      return ok(await getCoverLetterDetail(user.id, letterId));
    } catch (e) {
      if (e instanceof CoverLetterError && e.status === 404) return ERR.notFound();
      throw e;
    }
  }
  return ok({ letters: await listCoverLetters(user.id) });
});

// -------------------------------------------------------------------- POST

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("generate"),
    sourceResumeConversationId: z.string().min(1),
    targetRole: z.string().max(160).default(""),
    companyName: z.string().max(160).default(""),
    hiringContactName: z.string().max(160).default(""),
    salutation: z.string().max(120).default("Dear Hiring Manager"),
    date: z.string().max(40).default(""),
    tone: z.enum(COVER_LETTER_TONES).default("formal"),
    length: z.enum(COVER_LETTER_LENGTHS).default("standard"),
    jobDescription: z.string().min(1).max(8000),
  }),
  z.object({
    action: z.literal("rephrase"),
    letterId: z.string().min(1),
    /** "opening" | "body:<index>" | "closing" */
    target: z.string().regex(/^(opening|body:\d{1,2}|closing)$/),
  }),
  z.object({
    action: z.literal("duplicate"),
    letterId: z.string().min(1),
  }),
]);

/**
 * POST /api/laxii/cover-letter — generate / rephrase / duplicate.
 * AI actions pass the shared consent + quota gate (aiGate) and the letter
 * entity/metric guards; a failed guard saves NOTHING (honest failure).
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-cover-letter:${user.id}`, 8, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, postSchema);
  if (r.response) return r.response;
  const body = r.data;

  const gated = await aiGate(user);
  if (gated) return gated;

  try {
    if (body.action === "generate") {
      const result = await generateCoverLetter({
        userId: user.id,
        sourceResumeConversationId: body.sourceResumeConversationId,
        targetRole: body.targetRole,
        companyName: body.companyName,
        hiringContactName: body.hiringContactName,
        salutation: body.salutation,
        date: body.date,
        tone: body.tone,
        length: body.length,
        jobDescription: body.jobDescription,
      });
      return ok(result);
    }
    if (body.action === "rephrase") {
      const result = await rephraseLetterParagraph({ userId: user.id, letterId: body.letterId, target: body.target });
      return ok(result);
    }
    const result = await duplicateCoverLetter({ userId: user.id, letterId: body.letterId });
    return ok(result);
  } catch (e) {
    if (e instanceof CoverLetterError) {
      return err(e.message, e.status >= 500 ? 502 : e.status);
    }
    log.error("laxii.cover_letter.unexpected_failure", { message: String(e instanceof Error ? e.message : e).slice(0, 300) });
    return err("Cover letter generation failed. Please try again.", 502);
  }
});

// ------------------------------------------------------------------- PATCH

const patchSchema = z.object({
  letterId: z.string().min(1),
  data: coverLetterDataSchema,
});

/** PATCH /api/laxii/cover-letter — persist user edits (user edits win). */
export const PATCH = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-cover-letter-save:${user.id}`, 30, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;

  try {
    await saveCoverLetterEdits({ userId: user.id, letterId: r.data.letterId, data: r.data.data });
    return ok({ ok: true });
  } catch (e) {
    if (e instanceof CoverLetterError && e.status === 404) return ERR.notFound();
    if (e instanceof CoverLetterError) return err(e.message, 400);
    throw e;
  }
});
