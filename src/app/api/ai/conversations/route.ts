import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/ai/conversations — the user's own AI conversations, most recent first. */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const rows = await db.aiConversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 30,
    select: { id: true, title: true, updatedAt: true },
  });

  return ok({
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt.toISOString(),
    })),
  });
});
