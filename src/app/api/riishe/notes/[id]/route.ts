import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { auditEvent } from "@/lib/riishe/audit";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
  status: z.enum(["NEW", "CONTACTED", "IN_CONVERSATION", "COLLABORATING", "CLOSED"]).optional(),
});

/**
 * PATCH /api/riishe/notes/[id] — edit a private note / set collaboration
 * status. Ownership is enforced by the userId filter (other people's notes
 * are a 404 — no existence leak).
 */
export const PATCH = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await ctx.params;
  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;
  const existing = await db.riisheContactNote.findFirst({ where: { id, userId: user.id } });
  if (!existing) return ERR.notFound();
  const updated = await db.riisheContactNote.update({
    where: { id: existing.id },
    data: {
      ...(r.data.note ? { note: r.data.note } : {}),
      ...(r.data.status ? { status: r.data.status } : {}),
    },
  });
  await auditEvent(user.id, "riishe.note.updated", "RiisheContactNote", updated.id, {
    status: updated.status,
  });
  return ok({ updated: true, status: updated.status });
});

/** DELETE /api/riishe/notes/[id] — remove the owner's own note. */
export const DELETE = handler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await ctx.params;
  const deleted = await db.riisheContactNote.deleteMany({ where: { id, userId: user.id } });
  if (deleted.count === 0) return ERR.notFound();
  await auditEvent(user.id, "riishe.note.deleted", "RiisheContactNote", id, {});
  return ok({ deleted: true });
});
