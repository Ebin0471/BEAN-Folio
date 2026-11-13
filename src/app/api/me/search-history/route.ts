import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/** GET /api/me/search-history — the signed-in user's private recent searches (max 40, newest first). */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const rows = await db.searchQuery.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { id: true, query: true, scope: true, createdAt: true },
  });

  // Deduped view: newest occurrence per query string.
  const seen = new Set<string>();
  const items = rows
    .filter((r) => {
      const key = r.query.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({ id: r.id, query: r.query, scope: r.scope, createdAt: r.createdAt.toISOString() }));

  return ok({ items });
});

/** DELETE /api/me/search-history — clear the entire history (privacy control). */
export const DELETE = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  await db.searchQuery.deleteMany({ where: { userId: user.id } });
  return ok({ cleared: true });
});
