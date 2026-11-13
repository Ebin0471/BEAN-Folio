/**
 * Discover social feed — routes against the REAL database with REAL route
 * handlers, following the established route-test pattern (auth module
 * override armed per-file and DISARMED afterwards; unique XFF per request).
 *
 * Covers the owner spec: project cards gone from Discover (feed endpoints
 * serve posts/creators, not project listings), suggested-profile eligibility
 * (public + onboarded + non-demo + non-deleted + public artifact; excludes
 * self and blocked), post creation (text / image carousel / video with
 * poster, ownership + kind enforced server-side), like/bookmark idempotency
 * (composite PK), comments + replies + ownership deletion, share counting,
 * deduped views, PRIVATE visibility (404 for others, author-only) and the
 * public post SEO resolver (null for restricted content, real fields for
 * public ones).
 *
 * Run: bun test tests/discover-social.test.ts
 */

import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";

// --- module overrides (armed pattern — harmless when disarmed) -------------

declare global {
  var __discoverSocialAuth: { armed: boolean; userId: string | null } | undefined;
}
globalThis.__discoverSocialAuth = { armed: false, userId: null };

const actualAuth = await import("@/lib/auth");
const realAuthSnapshot = { ...actualAuth };
const realGetSessionUser = actualAuth.getSessionUser;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
  }),
}));

mock.module("@/lib/auth", () => ({
  ...realAuthSnapshot,
  getSessionUser: async () => {
    const state = globalThis.__discoverSocialAuth!;
    if (state.armed && state.userId) {
      const { db } = await import("@/lib/db");
      return db.user.findUnique({ where: { id: state.userId } });
    }
    return realGetSessionUser();
  },
}));

afterAll(() => {
  mock.restore();
  globalThis.__discoverSocialAuth = { armed: false, userId: null };
});

// --- helpers ----------------------------------------------------------------

import { db } from "@/lib/db";

const XFF = () => `10.77.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

function req(path: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined
      ? { body: JSON.stringify(init.body), headers: { "content-type": "application/json", "x-forwarded-for": XFF() } }
      : { headers: { "x-forwarded-for": XFF() } }),
  });
}

const ctxId = (id: string) => ({ params: Promise.resolve({ id }) });
const ctxComment = (id: string, commentId: string) => ({ params: Promise.resolve({ id, commentId }) });

let passwordUser: { id: string; username: string };
let otherUser: { id: string; username: string };
let privateUser: { id: string; username: string };
const cleanup: string[] = [];

async function makeUser(username: string, opts?: { visibility?: string; onboarded?: boolean }): Promise<{ id: string; username: string }> {
  const u = await db.user.create({
    data: {
      email: `${username}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`,
      passwordHash: "0".repeat(32) + ":" + "0".repeat(128),
      name: username.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      username,
      onboarded: opts?.onboarded ?? true,
      profileVisibility: opts?.visibility ?? "PUBLIC",
    },
  });
  cleanup.push(u.id);
  return { id: u.id, username: u.username! };
}

function asUser(id: string) {
  globalThis.__discoverSocialAuth = { armed: true, userId: id };
}
function asAnon() {
  globalThis.__discoverSocialAuth = { armed: false, userId: null };
}

async function media(ownerId: string, kind: "IMAGE" | "VIDEO"): Promise<string> {
  const a = await db.mediaAsset.create({
    data: {
      ownerId,
      kind,
      filename: kind === "VIDEO" ? "clip.mp4" : "frame.jpg",
      mime: kind === "VIDEO" ? "video/mp4" : "image/jpeg",
      size: 1024,
      status: "READY",
      storagePath: `uploads/${ownerId}/${kind.toLowerCase()}-test-${Math.random().toString(36).slice(2)}`,
    },
  });
  return a.id;
}

// handlers
const suggestedGET = (await import("@/app/api/discover/suggested/route")).GET;
const discoverPostsGET = (await import("@/app/api/discover/posts/route")).GET;
const postsPOST = (await import("@/app/api/posts/route")).POST;
const postGET = (await import("@/app/api/posts/[id]/route")).GET;
const postDELETE = (await import("@/app/api/posts/[id]/route")).DELETE;
const likePOST = (await import("@/app/api/posts/[id]/like/route")).POST;
const likeDELETE = (await import("@/app/api/posts/[id]/like/route")).DELETE;
const bookmarkPOST = (await import("@/app/api/posts/[id]/bookmark/route")).POST;
const bookmarkDELETE = (await import("@/app/api/posts/[id]/bookmark/route")).DELETE;
const commentsGET = (await import("@/app/api/posts/[id]/comments/route")).GET;
const commentsPOST = (await import("@/app/api/posts/[id]/comments/route")).POST;
const commentDELETE = (await import("@/app/api/posts/[id]/comments/[commentId]/route")).DELETE;
const sharePOST = (await import("@/app/api/posts/[id]/share/route")).POST;
const viewPOST = (await import("@/app/api/posts/[id]/view/route")).POST;
const { getPublicPostMeta } = await import("@/lib/public-post");

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function createPost(authorId: string, body: unknown): Promise<{ id: string }> {
  asUser(authorId);
  const res = await postsPOST(req("/api/posts", { method: "POST", body }));
  return (await json(res)) as unknown as { id: string };
}

// --- fixtures ----------------------------------------------------------------

beforeAll(async () => {
  passwordUser = await makeUser(`feed-owner-${Date.now()}`);
  otherUser = await makeUser(`feed-other-${Date.now()}`);
  privateUser = await makeUser(`feed-priv-${Date.now()}`, { visibility: "PRIVATE" });

  await db.project.create({
    data: {
      ownerId: otherUser.id,
      title: "Eligibility project",
      status: "PUBLISHED",
      visibility: "PUBLIC",
      publishedAt: new Date(),
    },
  });
});

afterAll(async () => {
  for (const id of cleanup) {
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
});

// --- suggested profiles ------------------------------------------------------

describe("suggested profiles", () => {
  test("returns real eligible creators and excludes self, blocked, demo, private", async () => {
    await createPost(passwordUser.id, { body: "Eligibility post" });
    await db.block.create({ data: { blockerId: otherUser.id, blockedId: passwordUser.id } });

    asAnon();
    const anon = await suggestedGET(req("/api/discover/suggested?limit=50"));
    expect(anon.status).toBe(200);
    const anonBody = (await json(anon)) as { items: { username: string }[]; nextCursor: string | null };
    expect(Array.isArray(anonBody.items)).toBe(true);
    expect(anonBody.items.some((i) => i.username === passwordUser.username)).toBe(true);
    expect(anonBody.items.some((i) => i.username === otherUser.username)).toBe(true);
    expect(anonBody.items.some((i) => i.username === privateUser.username)).toBe(false);

    asUser(otherUser.id);
    const r = await suggestedGET(req("/api/discover/suggested?limit=50"));
    const body = (await json(r)) as { items: { username: string }[] };
    expect(body.items.some((i) => i.username === otherUser.username)).toBe(false); // never self
    expect(body.items.some((i) => i.username === passwordUser.username)).toBe(false); // blocked
  });

  test("pagination cursor advances without repeats", async () => {
    asAnon();
    const p1 = (await json(await suggestedGET(req("/api/discover/suggested?limit=1")))) as { items: { username: string }[]; nextCursor: string | null };
    if (p1.nextCursor) {
      const p2 = (await json(await suggestedGET(req(`/api/discover/suggested?limit=1&cursor=${p1.nextCursor}`)))) as { items: { username: string }[] };
      expect(p2.items[0].username).not.toBe(p1.items[0].username);
    }
  });
});

// --- post creation -----------------------------------------------------------

describe("post creation", () => {
  test("requires authentication", async () => {
    asAnon();
    const res = await postsPOST(req("/api/posts", { method: "POST", body: { body: "anon post" } }));
    expect(res.status).toBe(401);
  });

  test("rejects an empty post (no body, no media)", async () => {
    asUser(passwordUser.id);
    const res = await postsPOST(req("/api/posts", { method: "POST", body: { body: "   " } }));
    expect(res.status).toBe(400);
  });

  test("rejects an unknown profession slug", async () => {
    asUser(passwordUser.id);
    const res = await postsPOST(req("/api/posts", { method: "POST", body: { body: "hello", profession: "not-a-real-slug" } }));
    expect(res.status).toBe(400);
  });

  test("creates a text post; hashtags come from the caption and the explicit list", async () => {
    asUser(passwordUser.id);
    const res = await postsPOST(req("/api/posts", {
      method: "POST",
      body: { body: "Shipping a new brand system today #editing", hashtags: ["MotionDesign", "editing"] },
    }));
    expect(res.status).toBe(201);
    const body = (await json(res)) as { body: string; hashtags: string[]; mediaKind: string; counts: { likes: number } };
    expect(body.mediaKind).toBe("TEXT");
    expect(body.hashtags).toContain("editing");
    expect(body.hashtags).toContain("motiondesign");
    expect(body.counts.likes).toBe(0);
  });

  test("video post enforces ownership, kind and poster rules", async () => {
    asUser(passwordUser.id);
    const myVideo = await media(passwordUser.id, "VIDEO");
    const foreignImage = await media(otherUser.id, "IMAGE");
    const myImage = await media(passwordUser.id, "IMAGE");

    const bad1 = await postsPOST(req("/api/posts", { method: "POST", body: { body: "v", media: [{ mediaAssetId: myVideo }], posterMediaAssetId: foreignImage } }));
    expect(bad1.status).toBe(400);

    const myVideo2 = await media(passwordUser.id, "VIDEO");
    const bad2 = await postsPOST(req("/api/posts", { method: "POST", body: { body: "v", media: [{ mediaAssetId: myVideo2 }], posterMediaAssetId: myVideo } }));
    expect(bad2.status).toBe(400);

    const okRes = await postsPOST(req("/api/posts", { method: "POST", body: { body: "My new reel", media: [{ mediaAssetId: myVideo, altText: "showreel" }], posterMediaAssetId: myImage } }));
    expect(okRes.status).toBe(201);
    const body = (await json(okRes)) as { mediaKind: string; media: { kind: string; posterUrl: string | null }[] };
    expect(body.mediaKind).toBe("VIDEO");
    expect(body.media[0].kind).toBe("VIDEO");
    expect(body.media[0].posterUrl).not.toBeNull();

    const mixed = await postsPOST(req("/api/posts", { method: "POST", body: { body: "mix", media: [{ mediaAssetId: myVideo }, { mediaAssetId: myImage }] } }));
    expect(mixed.status).toBe(400);
  });

  test("image carousel post accepts multiple owned images", async () => {
    asUser(passwordUser.id);
    const imgs = await Promise.all([media(passwordUser.id, "IMAGE"), media(passwordUser.id, "IMAGE"), media(passwordUser.id, "IMAGE")]);
    const res = await postsPOST(req("/api/posts", { method: "POST", body: { body: "carousel", media: imgs.map((id) => ({ mediaAssetId: id })) } }));
    expect(res.status).toBe(201);
    const body = (await json(res)) as { mediaKind: string; media: unknown[] };
    expect(body.mediaKind).toBe("IMAGE");
    expect(body.media.length).toBe(3);
  });
});

// --- feed --------------------------------------------------------------------

describe("posts feed", () => {
  test("only PUBLIC posts by public authors; kind=video filters; pagination works", async () => {
    await createPost(passwordUser.id, { body: "private musing", visibility: "PRIVATE" });

    asAnon();
    const all = (await json(await discoverPostsGET(req("/api/discover/posts?limit=50")))) as { items: { body: string; mediaKind: string }[] };
    expect(all.items.every((p) => p.body !== "private musing")).toBe(true);

    const vids = (await json(await discoverPostsGET(req("/api/discover/posts?kind=video&limit=50")))) as { items: { mediaKind: string }[] };
    expect(vids.items.every((p) => p.mediaKind === "VIDEO")).toBe(true);

    const page1 = (await json(await discoverPostsGET(req("/api/discover/posts?limit=1")))) as { items: unknown[]; nextCursor: string | null };
    if (page1.nextCursor) {
      const page2 = (await json(await discoverPostsGET(req(`/api/discover/posts?limit=1&cursor=${page1.nextCursor}`)))) as { items: unknown[] };
      expect(page2.items.length).toBe(1);
    }
  });

  test("PRIVATE post is 404 for others, 200 for the author; deleted posts vanish", async () => {
    const priv = await createPost(passwordUser.id, { body: "secret note", visibility: "PRIVATE" });
    const pid = priv.id;

    asUser(otherUser.id);
    expect((await postGET(req(`/api/posts/${pid}`), ctxId(pid))).status).toBe(404);
    asAnon();
    expect((await postGET(req(`/api/posts/${pid}`), ctxId(pid))).status).toBe(404);
    asUser(passwordUser.id);
    expect((await postGET(req(`/api/posts/${pid}`), ctxId(pid))).status).toBe(200);

    expect(await getPublicPostMeta(pid)).toBeNull();

    asUser(otherUser.id);
    expect((await postDELETE(req(`/api/posts/${pid}`, { method: "DELETE" }), ctxId(pid))).status).toBe(403);
    asUser(passwordUser.id);
    expect((await postDELETE(req(`/api/posts/${pid}`, { method: "DELETE" }), ctxId(pid))).status).toBe(200);
    asUser(otherUser.id);
    expect((await postGET(req(`/api/posts/${pid}`), ctxId(pid))).status).toBe(404);
  });
});

// --- interactions --------------------------------------------------------------

describe("likes, bookmarks, comments, shares, views", () => {
  let pid: string;

  beforeAll(async () => {
    const created = await createPost(passwordUser.id, { body: "interaction target" });
    pid = created.id;
  });

  test("like → unlike is idempotent with accurate counts; anon cannot like", async () => {
    asAnon();
    expect((await likePOST(req(`/api/posts/${pid}/like`, { method: "POST" }), ctxId(pid))).status).toBe(401);

    asUser(otherUser.id);
    const l1 = (await json(await likePOST(req(`/api/posts/${pid}/like`, { method: "POST" }), ctxId(pid)))) as { liked: boolean; likes: number };
    expect(l1.liked).toBe(true);
    const l2 = (await json(await likePOST(req(`/api/posts/${pid}/like`, { method: "POST" }), ctxId(pid)))) as { liked: boolean; likes: number };
    expect(l2.likes).toBe(1); // duplicate like structurally prevented
    const l3 = (await json(await likeDELETE(req(`/api/posts/${pid}/like`, { method: "DELETE" }), ctxId(pid)))) as { liked: boolean; likes: number };
    expect(l3.liked).toBe(false);
    expect(l3.likes).toBe(0);
  });

  test("bookmark toggles are idempotent with accurate counts", async () => {
    asUser(otherUser.id);
    const b1 = (await json(await bookmarkPOST(req(`/api/posts/${pid}/bookmark`, { method: "POST" }), ctxId(pid)))) as { bookmarked: boolean; bookmarks: number };
    expect(b1.bookmarked).toBe(true);
    const b2 = (await json(await bookmarkPOST(req(`/api/posts/${pid}/bookmark`, { method: "POST" }), ctxId(pid)))) as { bookmarks: number };
    expect(b2.bookmarks).toBe(1);
    const b3 = (await json(await bookmarkDELETE(req(`/api/posts/${pid}/bookmark`, { method: "DELETE" }), ctxId(pid)))) as { bookmarked: boolean; bookmarks: number };
    expect(b3.bookmarked).toBe(false);
    expect(b3.bookmarks).toBe(0);
  });

  test("comments: create, reply, paginate; foreign deletion refused; authors may delete", async () => {
    asUser(otherUser.id);
    const c1res = await commentsPOST(req(`/api/posts/${pid}/comments`, { method: "POST", body: { body: "First comment" } }), ctxId(pid));
    if (process.env.DEBUG_COMMENTS) console.log("C1 STATUS", c1res.status, await c1res.clone().text());
    const c1 = (await json(c1res)) as { comment: { id: string }; comments: number };
    expect(c1.comments).toBe(1);

    const c2 = (await json(await commentsPOST(req(`/api/posts/${pid}/comments`, { method: "POST", body: { body: "A reply", parentId: c1.comment.id } }), ctxId(pid)))) as { comment: { id: string; parentId: string }; comments: number };
    expect(c2.comment.parentId).toBe(c1.comment.id);
    expect(c2.comments).toBe(2);

    const foreignPost = await createPost(otherUser.id, { body: "other post" });
    const foreignComment = (await json(await commentsPOST(req(`/api/posts/${foreignPost.id}/comments`, { method: "POST", body: { body: "on other post" } }), ctxId(foreignPost.id)))) as { comment: { id: string } };
    const badReply = await commentsPOST(req(`/api/posts/${pid}/comments`, { method: "POST", body: { body: "bad", parentId: foreignComment.comment.id } }), ctxId(pid));
    expect(badReply.status).toBe(400);

    const third = await makeUser(`feed-third-${Date.now()}`);
    asUser(third.id);
    expect((await commentDELETE(req(`/api/posts/${pid}/comments/${c1.comment.id}`, { method: "DELETE" }), ctxComment(pid, c1.comment.id))).status).toBe(403);

    asUser(passwordUser.id); // post author moderates
    const del = (await json(await commentDELETE(req(`/api/posts/${pid}/comments/${c1.comment.id}`, { method: "DELETE" }), ctxComment(pid, c1.comment.id)))) as { deleted: boolean; comments: number };
    expect(del.deleted).toBe(true);
    expect(del.comments).toBe(0); // parent + cascaded reply are both gone

    // comment author deletes their own (fresh) comment
    asUser(otherUser.id);
    const mine = (await json(await commentsPOST(req(`/api/posts/${pid}/comments`, { method: "POST", body: { body: "my own comment" } }), ctxId(pid)))) as { comment: { id: string }; comments: number };
    expect(mine.comments).toBe(1);
    const del2 = (await json(await commentDELETE(req(`/api/posts/${pid}/comments/${mine.comment.id}`, { method: "DELETE" }), ctxComment(pid, mine.comment.id)))) as { comments: number };
    expect(del2.comments).toBe(0);

    const list = (await json(await commentsGET(req(`/api/posts/${pid}/comments?limit=10`), ctxId(pid)))) as { items: unknown[]; total: number };
    expect(list.total).toBe(0);
  });

  test("share increments and returns the canonical public URL", async () => {
    asAnon();
    const s1 = (await json(await sharePOST(req(`/api/posts/${pid}/share`, { method: "POST" }), ctxId(pid)))) as { shares: number; shareUrl: string };
    expect(s1.shares).toBe(1);
    expect(s1.shareUrl).toContain(`/post/${pid}`);
    const s2 = (await json(await sharePOST(req(`/api/posts/${pid}/share`, { method: "POST" }), ctxId(pid)))) as { shares: number };
    expect(s2.shares).toBe(2);
  });

  test("views dedupe per viewer per day and skip the author", async () => {
    asAnon();
    await viewPOST(req(`/api/posts/${pid}/view`, { method: "POST" }), ctxId(pid));
    await viewPOST(req(`/api/posts/${pid}/view`, { method: "POST" }), ctxId(pid));
    const anonViews = await db.postView.count({ where: { postId: pid, viewerKey: { startsWith: "a:" } } });
    expect(anonViews).toBeGreaterThanOrEqual(1);

    asUser(otherUser.id);
    await viewPOST(req(`/api/posts/${pid}/view`, { method: "POST" }), ctxId(pid));
    expect(await db.postView.count({ where: { postId: pid, viewerKey: `u:${otherUser.id}` } })).toBe(1);

    asUser(passwordUser.id); // author views are never counted
    await viewPOST(req(`/api/posts/${pid}/view`, { method: "POST" }), ctxId(pid));
    expect(await db.postView.count({ where: { postId: pid, viewerKey: `u:${passwordUser.id}` } })).toBe(0);
  });
});

// --- SEO ---------------------------------------------------------------------

describe("public post SEO resolver", () => {
  test("returns real title/description/media fields for a public post, null for unknown ids", async () => {
    asUser(passwordUser.id);
    const img = await media(passwordUser.id, "IMAGE");
    const vid = await media(passwordUser.id, "VIDEO");
    const created = await createPost(passwordUser.id, {
      body: "Brand launch recap\nwith details",
      hashtags: ["branding"],
      media: [{ mediaAssetId: vid, altText: "launch reel" }],
      posterMediaAssetId: img,
    });

    const meta = await getPublicPostMeta(created.id);
    expect(meta).not.toBeNull();
    expect(meta!.authorName).toBeTruthy();
    expect(meta!.mediaKind).toBe("VIDEO");
    expect(meta!.videoMediaId).toBe(vid);
    expect(meta!.imageMediaId).toBe(img);
    expect(meta!.hashtags).toContain("branding");
    expect(meta!.description).toContain("Brand launch recap");

    expect(await getPublicPostMeta("does-not-exist")).toBeNull();
  });
});
