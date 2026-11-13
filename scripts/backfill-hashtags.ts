/**
 * One-time backfill: populate Hashtag / PostHashtag dictionary rows from the
 * existing Post.hashtags JSON mirrors. Idempotent — only PUBLIC, PUBLISHED
 * posts count (mirrors syncPostHashtags semantics). Safe to re-run.
 *
 * Run: bun scripts/backfill-hashtags.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const posts = await db.post.findMany({
    where: { status: "PUBLISHED", visibility: "PUBLIC" },
    select: { id: true, hashtags: true },
    take: 10_000,
  });

  let synced = 0;
  for (const post of posts) {
    let tags: string[] = [];
    try {
      const v = JSON.parse(post.hashtags);
      if (Array.isArray(v)) tags = v.filter((x): x is string => typeof x === "string");
    } catch {
      continue;
    }
    if (tags.length === 0) continue;
    for (const tag of tags) {
      const row = await db.hashtag.upsert({
        where: { name: tag },
        create: { name: tag, postCount: 1, lastUsedAt: new Date() },
        update: { lastUsedAt: new Date() },
      });
      const existing = await db.postHashtag.findUnique({
        where: { postId_hashtagId: { postId: post.id, hashtagId: row.id } },
      });
      if (!existing) {
        await db.postHashtag.create({ data: { postId: post.id, hashtagId: row.id } });
        await db.hashtag.update({ where: { id: row.id }, data: { postCount: { increment: 1 } } });
        synced++;
      }
    }
  }

  const total = await db.hashtag.count();
  console.log(JSON.stringify({ event: "backfill-hashtags", posts: posts.length, links: synced, totalTags: total }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
