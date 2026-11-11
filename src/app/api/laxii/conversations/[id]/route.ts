import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";

import { conversationDetail, LaxiiServiceError } from "@/lib/laxii/service";
import { sweepStaleLaxiiJobs } from "@/lib/laxii/jobs";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/laxii/conversations/[id] — full thread (messages + versions). */
export const GET = handler(async (_req: NextRequest, { params }: Ctx): Promise<NextResponse> => {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  try {
    // Jobs whose worker died (server restart) never spin forever: RUNNING
    // messages past the stale window are honestly failed before serving.
    // Ownership first — sweep only the requester's own conversation.
    const owned = await db.laxiiConversation.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (owned) await sweepStaleLaxiiJobs(id);
    const detail = await conversationDetail(user.id, id);
    return ok(detail);
  } catch (e) {
    if (e instanceof LaxiiServiceError) return err(e.message, e.status);
    throw e;
  }
});

const patchSchema = z.object({ title: z.string().trim().min(1).max(80) });

/** PATCH /api/laxii/conversations/[id] — rename. */
export const PATCH = handler(async (req: NextRequest, { params }: Ctx): Promise<NextResponse> => {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const conversation = await db.laxiiConversation.findFirst({ where: { id, userId: user.id } });
  if (!conversation) return ERR.notFound();

  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;

  await db.laxiiConversation.update({ where: { id }, data: { title: r.data.title } });
  return ok({ ok: true });
});

/** DELETE /api/laxii/conversations/[id] — delete the thread (cascades). */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx): Promise<NextResponse> => {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const conversation = await db.laxiiConversation.findFirst({ where: { id, userId: user.id } });
  if (!conversation) return ERR.notFound();

  await db.laxiiConversation.delete({ where: { id } });
  return ok({ ok: true });
});
