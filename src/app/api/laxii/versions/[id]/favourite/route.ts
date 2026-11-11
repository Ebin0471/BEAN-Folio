import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/laxii/versions/[id]/favourite — toggle the favourite flag. */
export const POST = handler(async (_req: NextRequest, { params }: Ctx): Promise<NextResponse> => {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const version = await db.laxiiImageVersion.findUnique({
    where: { id },
    include: { conversation: { select: { userId: true } } },
  });
  if (!version || version.conversation.userId !== user.id) return ERR.notFound();

  const updated = await db.laxiiImageVersion.update({
    where: { id },
    data: { isFavourite: !version.isFavourite },
  });

  return ok({ ok: true, isFavourite: updated.isFavourite });
});
