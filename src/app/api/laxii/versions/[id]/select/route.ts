import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/laxii/versions/[id]/select — make a version the conversation's
 * selected output. Powers the selected preview, undo/redo (re-select an
 * ancestor/descendant) and the parent pointer for follow-up edits.
 * A SYSTEM note is not written — selection changes are lightweight state, the
 * version tree itself remains the history of record.
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx): Promise<NextResponse> => {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const version = await db.laxiiImageVersion.findUnique({
    where: { id },
    include: { conversation: { select: { userId: true } } },
  });
  if (!version || version.conversation.userId !== user.id) return ERR.notFound();

  await db.$transaction([
    db.laxiiImageVersion.updateMany({ where: { conversationId: version.conversationId }, data: { isSelected: false } }),
    db.laxiiImageVersion.update({ where: { id }, data: { isSelected: true } }),
    db.laxiiConversation.update({ where: { id: version.conversationId }, data: { updatedAt: new Date() } }),
  ]);

  return ok({ ok: true, selectedVersionId: id });
});
