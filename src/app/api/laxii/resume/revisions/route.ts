import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit, parseBody } from "@/lib/api-helpers";

import {
  ResumeServiceError,
  RevisionServiceError,
  listRevisions,
  getRevisionDetail,
  saveRevision,
  setRevisionPin,
  restoreRevision,
} from "@/lib/laxii/resume-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET  /api/laxii/resume/revisions?conversationId=…                 → list (bounded, no document bodies)
 * GET  /api/laxii/resume/revisions?conversationId=…&revisionId=…    → one revision (full document) for compare
 * POST /api/laxii/resume/revisions  { action: "save" | "pin" | "restore" }
 *
 * M33.5-C — explicit revision history. Restore snapshots the CURRENT state
 * first (inside the same transaction), so restoring never silently erases a
 * newer document. Owner-scoped on every branch.
 */
export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-resume-revisions-read:${user.id}`, 60, 60_000)) return ERR.rateLimited();

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) return err("conversationId is required.", 400);
  const revisionId = url.searchParams.get("revisionId");

  try {
    if (revisionId) {
      return ok(await getRevisionDetail(user.id, conversationId, revisionId));
    }
    return ok({ revisions: await listRevisions(user.id, conversationId) });
  } catch (e) {
    if ((e instanceof RevisionServiceError || e instanceof ResumeServiceError) && e.status === 404) return ERR.notFound();
    if (e instanceof RevisionServiceError || e instanceof ResumeServiceError) return err(e.message, 400);
    throw e;
  }
});

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    conversationId: z.string().min(1),
    label: z.string().max(80).optional(),
  }),
  z.object({
    action: z.literal("pin"),
    conversationId: z.string().min(1),
    revisionId: z.string().min(1),
    pinned: z.boolean().default(true),
  }),
  z.object({
    action: z.literal("restore"),
    conversationId: z.string().min(1),
    revisionId: z.string().min(1),
  }),
]);

export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-resume-revisions-write:${user.id}`, 20, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, postSchema);
  if (r.response) return r.response;
  const body = r.data;

  try {
    if (body.action === "save") {
      return ok({ revision: await saveRevision({ userId: user.id, conversationId: body.conversationId, ...(body.label ? { label: body.label } : {}) }) });
    }
    if (body.action === "pin") {
      await setRevisionPin({ userId: user.id, conversationId: body.conversationId, revisionId: body.revisionId, pinned: body.pinned });
      return ok({ ok: true });
    }
    const result = await restoreRevision({ userId: user.id, conversationId: body.conversationId, revisionId: body.revisionId });
    return ok(result);
  } catch (e) {
    if ((e instanceof RevisionServiceError || e instanceof ResumeServiceError) && e.status === 404) return ERR.notFound();
    if (e instanceof RevisionServiceError || e instanceof ResumeServiceError) return err(e.message, 400);
    throw e;
  }
});
