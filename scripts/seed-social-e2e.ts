/**
 * E2E test accounts + content seeder (REAL accounts, isDemo: false — these
 * flow through every public surface, unlike the demo fixtures).
 *
 * Creates: alice / bob / carol (password: socialtest1) with text, image and
 * video posts, a private account (dave) and a follow graph + engagement so
 * the Discover feed, notifications and DMs have real data to render.
 *
 * Run: bun scripts/seed-social-e2e.ts
 */
import { randomBytes, scrypt as _scrypt } from "crypto";
import { promisify } from "util";
import { copyFileSync, mkdirSync, existsSync, statSync, writeFileSync, readdirSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const scrypt = promisify(_scrypt) as (p: string, s: string, k: number) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

const ASSETS = path.join(process.cwd(), "scripts", "seed-assets");
const UPLOADS = path.join(process.cwd(), "uploads");

let assetCounter = 100000;
async function importImage(ownerId: string, file: string, mime = "image/png"): Promise<string> {
  const src = path.join(ASSETS, file);
  if (!existsSync(src)) throw new Error(`Missing seed asset: ${file}`);
  mkdirSync(UPLOADS, { recursive: true });
  assetCounter += 1;
  const name = `e2e-${assetCounter}-${file}`;
  copyFileSync(src, path.join(UPLOADS, name));
  return db.mediaAsset.create({
    data: {
      ownerId,
      kind: "IMAGE",
      filename: file,
      mime,
      size: statSync(src).size,
      status: "READY",
      storagePath: path.join("uploads", name),
    },
  }).then((a) => a.id);
}

async function makeVideoAsset(ownerId: string): Promise<string> {
  mkdirSync(UPLOADS, { recursive: true });
  const name = `e2e-clip-${randomBytes(4).toString("hex")}.mp4`;
  const dest = path.join(UPLOADS, name);
  // A tiny valid-enough mp4 placeholder (streaming route serves bytes as-is).
  const bytes = Buffer.alloc(1024, 0);
  writeFileSync(dest, bytes);
  return db.mediaAsset.create({
    data: {
      ownerId,
      kind: "VIDEO",
      filename: name,
      mime: "video/mp4",
      size: bytes.length,
      status: "READY",
      storagePath: path.join("uploads", name),
    },
  }).then((a) => a.id);
}

async function main() {
  const PASSWORD = "socialtest1";
  const existing = await db.user.findFirst({ where: { username: "alice" } });
  if (existing) {
    console.log(JSON.stringify({ event: "seed-social-e2e", skipped: "already seeded" }));
    return;
  }

  const passwordHash = await hashPassword(PASSWORD);

  const alice = await db.user.create({
    data: {
      email: "alice@beanfolio.test",
      passwordHash,
      name: "Alice Chen",
      username: "alice",
      headline: "Motion designer · reels and titles",
      bio: "Cutting frames since forever. Open to collaborations.",
      location: "Berlin",
      onboarded: true,
      profileVisibility: "PUBLIC",
    },
  });
  const bob = await db.user.create({
    data: {
      email: "bob@beanfolio.test",
      passwordHash,
      name: "Bob Rivera",
      username: "bob",
      headline: "Product designer · systems",
      location: "Berlin",
      onboarded: true,
      profileVisibility: "PUBLIC",
    },
  });
  const carol = await db.user.create({
    data: {
      email: "carol@beanfolio.test",
      passwordHash,
      name: "Carol Osei",
      username: "carol",
      headline: "Photographer · portraits",
      location: "Lagos",
      onboarded: true,
      profileVisibility: "PUBLIC",
    },
  });
  const dave = await db.user.create({
    data: {
      email: "dave@beanfolio.test",
      passwordHash,
      name: "Dave Kim",
      username: "dave",
      headline: "Private account",
      onboarded: true,
      profileVisibility: "PRIVATE",
    },
  });

  // Avatars
  const assets = existsSync(ASSETS) ? readdirSync(ASSETS).filter((f) => f.endsWith(".png")).slice(0, 6) : [];
  if (assets[0]) await db.user.update({ where: { id: alice.id }, data: { avatarMediaId: await importImage(alice.id, assets[0]) } });
  if (assets[1]) await db.user.update({ where: { id: bob.id }, data: { avatarMediaId: await importImage(bob.id, assets[1]) } });
  if (assets[2]) await db.user.update({ where: { id: carol.id }, data: { avatarMediaId: await importImage(carol.id, assets[2]) } });

  // Follow graph: alice→bob, bob→alice, carol→alice, dave→(request) alice
  await db.follow.createMany({
    data: [
      { followerId: alice.id, followingId: bob.id, status: "ACTIVE", respondedAt: new Date() },
      { followerId: bob.id, followingId: alice.id, status: "ACTIVE", respondedAt: new Date() },
      { followerId: carol.id, followingId: alice.id, status: "ACTIVE", respondedAt: new Date() },
      { followerId: dave.id, followingId: alice.id, status: "PENDING" },
    ],
  });

  // Alice's posts: text (announcement), image carousel, video reel
  const aImg1 = assets[3] ? await importImage(alice.id, assets[3]) : await importImage(alice.id, assets[0]);
  const aImg2 = assets[4] ? await importImage(alice.id, assets[4]) : aImg1;
  await db.post.create({
    data: {
      authorId: alice.id,
      body: "New title sequence for a documentary is live — full breakdown soon! #motiondesign #aftereffects",
      hashtags: JSON.stringify(["motiondesign", "aftereffects"]),
      kind: "ANNOUNCEMENT",
      location: "Berlin",
      profession: "motion-designer",
      mediaKind: "TEXT",
      media: {},
    },
  });
  await db.post.create({
    data: {
      authorId: alice.id,
      body: "Storyboard frames from this week's client pitch. #storyboards",
      hashtags: JSON.stringify(["storyboards"]),
      kind: "WIP",
      profession: "motion-designer",
      mediaKind: "IMAGE",
      media: { create: [
        { order: 0, mediaAssetId: aImg1, altText: "Storyboard frame one" },
        { order: 1, mediaAssetId: aImg2, altText: "Storyboard frame two" },
      ] },
    },
  });
  const aVideo = await makeVideoAsset(alice.id);
  const aPoster = await importImage(alice.id, assets[5] ?? assets[0]);
  await db.post.create({
    data: {
      authorId: alice.id,
      body: "30s reel cut — sound on! #showreel #motiondesign",
      hashtags: JSON.stringify(["showreel", "motiondesign"]),
      kind: "UPDATE",
      profession: "motion-designer",
      mediaKind: "VIDEO",
      media: { create: [{ order: 0, mediaAssetId: aVideo, altText: "Showreel clip", posterMediaAssetId: aPoster }] },
    },
  });

  // Bob's post + Carol's post
  const bImg = assets[1] ? await importImage(bob.id, assets[1]) : await importImage(bob.id, assets[0]);
  await db.post.create({
    data: {
      authorId: bob.id,
      body: "Design system tokens v2 shipped — question for the community: how do you handle motion tokens? #designsystems",
      hashtags: JSON.stringify(["designsystems"]),
      kind: "QUESTION",
      profession: "product-designer",
      mediaKind: "IMAGE",
      media: { create: [{ order: 0, mediaAssetId: bImg, altText: "Design tokens board" }] },
    },
  });
  await db.post.create({
    data: {
      authorId: carol.id,
      body: "Golden hour portrait session — behind the scenes. #photography #portraits",
      hashtags: JSON.stringify(["photography", "portraits"]),
      kind: "TUTORIAL",
      mediaKind: "TEXT",
      media: {},
    },
  });

  // Engagement: bob + carol like alice's reel; bob comments; alice replies
  const reel = await db.post.findFirst({ where: { authorId: alice.id, mediaKind: "VIDEO" }, select: { id: true } });
  if (reel) {
    await db.postLike.createMany({
      data: [
        { postId: reel.id, userId: bob.id },
        { postId: reel.id, userId: carol.id },
      ],
    });
    const comment = await db.postComment.create({
      data: { postId: reel.id, authorId: bob.id, body: "The transitions at 0:12 are so clean @alice" },
    });
    await db.postComment.create({
      data: { postId: reel.id, authorId: alice.id, body: "@bob thanks! all shape layers, no plugins", parentId: comment.id },
    });
    await db.postBookmark.create({ data: { postId: reel.id, userId: carol.id } });
  }

  console.log(JSON.stringify({
    event: "seed-social-e2e",
    accounts: ["alice", "bob", "carol", "dave"],
    password: PASSWORD,
    note: "dave is PRIVATE (follow request pending on alice)",
  }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
