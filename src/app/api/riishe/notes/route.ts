import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { auditEvent } from "@/lib/riishe/audit";
import { listNotes } from "@/lib/riishe/reports";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  username: z.string().trim().min(1).max(40),
  note: z.string().trim().min(1).max(500),
  status: z.enum(["NEW", "CONTACTED", "IN_CONVERSATION", "COLLABORATING", "CLOSED"]).optional(),
});

/** GET /api/riishe/notes — the owner's private contact notes. */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const notes = await listNotes(user.id);
  return ok({ notes });
});

/** POST /api/riishe/notes — save a private note about a person (strict ownership). */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const r = await parseBody(req, createSchema);
  if (r.response) return r.response;
  const person = await db.user.findFirst({
    where: { username: r.data.username.trim().toLowerCase(), deletedAt: null },
  });
  if (!person) return err("No creator with that username was found.", 404);
  const note = await db.riisheContactNote.create({
    data: {
      userId: user.id,
      personId: person.id,
      note: r.data.note,
      status: r.data.status ?? "NEW",
    },
  });
  await auditEvent(user.id, "riishe.note.created", "RiisheContactNote", note.id, {
    personUsername: person.username ?? "",
  });
  return ok({
    note: {
      id: note.id,
      personId: note.personId,
      person: { name: person.name, username: person.username ?? "" },
      status: note.status,
      note: note.note,
      createdAt: note.createdAt.toISOString(),
    },
  });
});
