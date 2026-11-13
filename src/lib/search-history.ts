import { db } from "@/lib/db";

/**
 * Search history (privacy-controlled): signed-in users get their queries
 * recorded privately; they can view + clear them at any time. Anonymous
 * viewers are never recorded.
 */
export async function recordSearch(userId: string | null | undefined, query: string, scope: string): Promise<void> {
  if (!userId) return;
  const q = query.trim().slice(0, 80);
  if (!q) return;
  // Keep history bounded: drop the oldest rows past 40 entries.
  await db
    .$transaction(async (tx) => {
      const count = await tx.searchQuery.count({ where: { userId } });
      await tx.searchQuery.create({ data: { userId, query: q, scope } });
      if (count >= 40) {
        const oldest = await tx.searchQuery.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          skip: 40,
          take: count,
          select: { id: true },
        });
        if (oldest.length > 0) {
          await tx.searchQuery.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
        }
      }
    })
    .catch(() => undefined);
}
