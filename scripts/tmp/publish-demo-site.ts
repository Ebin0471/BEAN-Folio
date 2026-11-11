// Publish a site for maya-edits using the REAL defaultConfig (same code path
// as the WebsiteBuilder's first render), with the demo user's avatar + cover.
import { db } from "../../src/lib/db";
import { normalizeConfig, defaultConfig } from "../../src/lib/site-config";

async function main() {
  const user = await db.user.findUnique({ where: { username: "maya-edits" }, select: { id: true } });
  if (!user) throw new Error("maya-edits not found");
  const [cover, avatar] = await Promise.all([
    db.mediaAsset.findFirst({ where: { ownerId: user.id, kind: "IMAGE" }, select: { id: true }, orderBy: { createdAt: "desc" } }),
    db.user.findUnique({ where: { username: "maya-edits" }, select: { avatarMediaId: true } }),
  ]);

  // The builder's real starting point: defaultConfig("atelier") — a complete,
  // schema-valid site. Personalize name/tagline + attach the avatar/cover.
  const raw = defaultConfig("atelier") as Record<string, unknown>;
  raw.name = "Maya Okonkwo";
  raw.tagline = "Video editor — cinematic cuts, honest color";
  raw.logoMediaId = null;
  raw.coverMediaId = cover?.id ?? null;
  const cfg = normalizeConfig(raw);
  if (!cfg) throw new Error("normalizeConfig returned null even for defaultConfig");

  const existing = await db.siteDesign.findUnique({ where: { userId: user.id } });
  const data = {
    draftConfig: JSON.stringify(cfg),
    publishedConfig: JSON.stringify(cfg),
    status: "PUBLISHED",
    ...(existing?.publishedAt ? {} : { publishedAt: new Date() }),
  };
  if (existing) await db.siteDesign.update({ where: { userId: user.id }, data });
  else await db.siteDesign.create({ data: { userId: user.id, ...data } });
  console.log("published; cover:", cover?.id, "avatar:", avatar?.avatarMediaId);
}
main().finally(() => db.$disconnect())
