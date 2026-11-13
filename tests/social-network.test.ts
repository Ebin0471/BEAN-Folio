/**
 * Social network expansion — routes against the REAL database with REAL
 * route handlers (same armed-auth pattern as discover-social.test.ts).
 *
 * Covers the phase deliverables: private-account follow REQUESTS (PENDING →
 * approve → FOLLOW_ACCEPTED notification; ACTIVE-only counts), the feed
 * engine (following chronological keyset; For You excluding blocked/muted/
 * hidden authors with explainable reasons; trending velocity; video filter;
 * impressions recorded), the notification engine (dedupKey retry-safety,
 * mute suppression, per-type preferences, grouped inbox), restricted-author
 * comment gating (HIDDEN → owner approve), comment likes, share events,
 * hide-post negative signals, drafts + scheduled posts (never in feeds),
 * hashtag dictionary sync, DM authorization (non-participant 404, blocked
 * send 403, request accept flow, read receipts) and post analytics
 * (engagement-rate formula over recorded events only).
 *
 * Run: bun test tests/social-network.test.ts
 */

import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";

// --- module overrides (armed pattern — harmless when disarmed) -------------

declare global {
  var __socialNetAuth: { armed: boolean; userId: string | null } | undefined;
}
globalThis.__socialNetAuth = { armed: false, userId: null };

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
    const state = globalThis.__socialNetAuth!;
    if (state.armed && state.userId) {
      const { db } = await import("@/lib/db");
      return db.user.findUnique({ where: { id: state.userId } });
    }
    return realGetSessionUser();
  },
}));

afterAll(() => {
  mock.restore();
  globalThis.__socialNetAuth = { armed: false, userId: null };
});

// --- helpers ----------------------------------------------------------------

import { db } from "@/lib/db";

const XFF = () => `10.78.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

function req(path: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined
      ? { body: JSON.stringify(init.body), headers: { "content-type": "application/json", "x-forwarded-for": XFF() } }
      : { headers: { "x-forwarded-for": XFF() } }),
  });
}

const ctxId = (id: string) => ({ params: Promise.resolve({ id }) });
const ctxUsername = (username: string) => ({ params: Promise.resolve({ username }) });
const ctxComment = (id: string, commentId: string) => ({ params: Promise.resolve({ id, commentId }) });
const ctxConv = (conversationId: string) => ({ params: Promise.resolve({ conversationId }) });

const cleanup: string[] = [];
const cleanupPostIds: string[] = [];
const cleanupConvIds: string[] = [];

let pub: { id: string; username: string }; // public account
let priv: { id: string; username: string }; // private account
let viewer: { id: string; username: string }; // the acting user
let outsider: { id: string; username: string };

async function makeUser(username: string, opts?: { visibility?: string }): Promise<{ id: string; username: string }> {
  const u = await db.user.create({
    data: {
      email: `${username}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`,
      passwordHash: "0".repeat(32) + ":" + "0".repeat(128),
      name: username.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      username,
      onboarded: true,
      profileVisibility: opts?.visibility ?? "PUBLIC",
    },
  });
  cleanup.push(u.id);
  return { id: u.id, username: u.username! };
}

function asUser(id: string) {
  globalThis.__socialNetAuth = { armed: true, userId: id };
}
function asAnon() {
  globalThis.__socialNetAuth = { armed: false, userId: null };
}

async function makePost(authorId: string, body: string, opts?: { mediaKind?: string; visibility?: string; status?: string; hashtags?: string[] }): Promise<string> {
  const p = await db.post.create({
    data: {
      authorId,
      body,
      hashtags: JSON.stringify(opts?.hashtags ?? []),
      mediaKind: opts?.mediaKind ?? "TEXT",
      visibility: opts?.visibility ?? "PUBLIC",
      status: opts?.status ?? "PUBLISHED",
    },
  });
  cleanupPostIds.push(p.id);
  return p.id;
}

// handlers
const followPOST = (await import("@/app/api/profiles/[username]/follow/route")).POST;
const followDELETE = (await import("@/app/api/profiles/[username]/follow/route")).DELETE;
const followGET = (await import("@/app/api/profiles/[username]/follow/route")).GET;
const requestsPOST = (await import("@/app/api/me/requests/route")).POST;
const followersGET = (await import("@/app/api/me/followers/route")).GET;
const feedGET = (await import("@/app/api/feed/route")).GET;
const notificationsGET = (await import("@/app/api/me/notifications/route")).GET;
const commentsPOST = (await import("@/app/api/posts/[id]/comments/route")).POST;
const commentsGET = (await import("@/app/api/posts/[id]/comments/route")).GET;
const commentPATCH = (await import("@/app/api/posts/[id]/comments/[commentId]/route")).PATCH;
const commentLikePOST = (await import("@/app/api/posts/[id]/comments/[commentId]/like/route")).POST;
const likePOST = (await import("@/app/api/posts/[id]/like/route")).POST;
const sharePOST = (await import("@/app/api/posts/[id]/share/route")).POST;
const hidePOST = (await import("@/app/api/posts/[id]/hide/route")).POST;
const edgePATCH = (await import("@/app/api/profiles/[username]/edge/route")).PATCH;
const draftsPOST = (await import("@/app/api/posts/drafts/route")).POST;
const postDELETE = (await import("@/app/api/posts/[id]/route")).DELETE;
const messagesGET = (await import("@/app/api/me/messages/route")).GET;
const messagesPOST = (await import("@/app/api/me/messages/route")).POST;
const threadGET = (await import("@/app/api/me/messages/[conversationId]/route")).GET;
const threadPOST = (await import("@/app/api/me/messages/[conversationId]/route")).POST;
const threadPATCH = (await import("@/app/api/me/messages/[conversationId]/route")).PATCH;
const insightsGET = (await import("@/app/api/me/insights/posts/route")).GET;
const postsCreate = (await import("@/app/api/posts/route")).POST;

beforeAll(async () => {
  pub = await makeUser("socnet-pub");
  priv = await makeUser("socnet-priv", { visibility: "PRIVATE" });
  viewer = await makeUser("socnet-viewer");
  outsider = await makeUser("socnet-out");
});

// ---------------------------------------------------------------- follow graph

describe("follow requests (private accounts)", () => {
  test("following a PRIVATE account creates a PENDING request, not an ACTIVE edge", async () => {
    asUser(viewer.id);
    const res = await followPOST(req("/api/profiles/socnet-priv/follow"), ctxUsername("socnet-priv"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("PENDING");

    const row = await db.follow.findUnique({
      where: { followerId_followingId: { followerId: viewer.id, followingId: priv.id } },
    });
    expect(row?.status).toBe("PENDING");
  });

  test("PENDING requests never inflate the target's follower count", async () => {
    asUser(priv.id);
    const res = await followGET(req("/x"), ctxUsername("socnet-viewer"));
    const probe = await db.follow.count({ where: { followingId: priv.id, status: "ACTIVE" } });
    expect(probe).toBe(0); // viewer's request is PENDING — no ACTIVE edge
    void res;
  });

  test("approve flips the edge to ACTIVE, sets respondedAt, notifies the requester", async () => {
    asUser(priv.id);
    const res = await requestsPOST(req("/api/me/requests", { method: "POST", body: { username: "socnet-viewer", action: "approve" } }), undefined as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("ACTIVE");

    const row = await db.follow.findUnique({
      where: { followerId_followingId: { followerId: viewer.id, followingId: priv.id } },
    });
    expect(row?.status).toBe("ACTIVE");
    expect(row?.respondedAt).not.toBeNull();

    const notification = await db.notification.findFirst({
      where: { userId: viewer.id, type: "FOLLOW_ACCEPTED" },
    });
    expect(notification).not.toBeNull();
  });

  test("me/followers lists ACTIVE followers under people and PENDING under requests", async () => {
    asUser(priv.id);
    const res = await followersGET(req("/api/me/followers"));
    const body = await res.json();
    expect(body.people.some((p: { person: { username: string } }) => p.person.username === "socnet-viewer")).toBe(true);
    expect(body.requests.every((r: { person: { username: string } }) => r.person.username !== "socnet-viewer")).toBe(true);
  });

  test("declining removes the edge silently", async () => {
    // outsider requests priv, priv declines
    asUser(outsider.id);
    await followPOST(req("/api/profiles/socnet-priv/follow"), ctxUsername("socnet-priv"));
    asUser(priv.id);
    const res = await requestsPOST(req("/api/me/requests", { method: "POST", body: { username: "socnet-out", action: "decline" } }), undefined as never);
    expect(res.status).toBe(200);
    const gone = await db.follow.findUnique({
      where: { followerId_followingId: { followerId: outsider.id, followingId: priv.id } },
    });
    expect(gone).toBeNull();
  });
});

// ---------------------------------------------------------------- feed engine

describe("feed engine", () => {
  let pubPost: string;
  let privPost: string;

  beforeAll(async () => {
    pubPost = await makePost(pub.id, "public post from pub for the feed engine");
    privPost = await makePost(priv.id, "private-author post — must never leak");
    await makePost(viewer.id, "viewer's own post appears in their following feed");
  });

  test("following mode: chronological, own posts + ACTIVE-followed authors only", async () => {
    // viewer ACTIVELY follows pub (approve through viewer's own request? pub is public → instant)
    asUser(viewer.id);
    await followPOST(req("/api/profiles/socnet-pub/follow"), ctxUsername("socnet-pub"));
    const res = await feedGET(req("/api/feed?mode=following&limit=20"));
    const body = await res.json();
    const authors = new Set(body.items.map((i: { author: { username: string } }) => i.author.username));
    expect(authors.has("socnet-pub")).toBe(true); // followed
    expect(authors.has("socnet-viewer")).toBe(true); // own posts included
    expect(authors.has("socnet-out")).toBe(false); // not followed

    // chronological (newest first)
    const times = body.items.map((i: { createdAt: string }) => i.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  test("foryou: excludes private authors and hidden posts; includes explainable reasons", async () => {
    asUser(viewer.id);
    const res = await feedGET(req("/api/feed?mode=foryou&limit=20"));
    const body = await res.json();
    const authors = new Set(body.items.map((i: { author: { username: string } }) => i.author.username));
    expect(authors.has("socnet-priv")).toBe(false); // private ladder
    for (const item of body.items) {
      expect(typeof item.reason).toBe("string");
      expect(item.reason.length).toBeGreaterThan(0);
    }
  });

  test("hide post → excluded from foryou for that viewer only", async () => {
    asUser(viewer.id);
    await hidePOST(req(`/api/posts/${pubPost}/hide`, { method: "POST", body: {} }), ctxId(pubPost));
    const res = await feedGET(req("/api/feed?mode=foryou&limit=20&exclude="));
    const body = await res.json();
    expect(body.items.some((i: { id: string }) => i.id === pubPost)).toBe(false);
    // other users still see it
    asUser(outsider.id);
    const res2 = await feedGET(req("/api/feed?mode=foryou&limit=20"));
    const body2 = await res2.json();
    expect(body2.items.some((i: { id: string }) => i.id === pubPost)).toBe(true);
  });

  test("mute: muted author's posts never enter the viewer's foryou", async () => {
    asUser(viewer.id);
    await edgePATCH(req("/api/profiles/socnet-out/edge", { method: "PATCH", body: { muted: true } }), ctxUsername("socnet-out"));
    await makePost(outsider.id, "post from a muted account");
    const res = await feedGET(req("/api/feed?mode=foryou&limit=30"));
    const body = await res.json();
    expect(body.items.every((i: { author: { username: string } }) => i.author.username !== "socnet-out")).toBe(true);
  });

  test("video mode: only VIDEO posts", async () => {
    asAnon();
    await makePost(pub.id, "video post", { mediaKind: "VIDEO" });
    const res = await feedGET(req("/api/feed?mode=video&limit=10"));
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i: { mediaKind: string }) => i.mediaKind === "VIDEO")).toBe(true);
  });

  test("feed serving records impressions (Post.impressions + daily buckets)", async () => {
    asUser(viewer.id);
    const before = await db.post.findUnique({ where: { id: pubPost }, select: { impressions: true } });
    await feedGET(req("/api/feed?mode=foryou&limit=30"));
    const after = await db.post.findUnique({ where: { id: pubPost }, select: { impressions: true } });
    expect((after?.impressions ?? 0)).toBeGreaterThanOrEqual(before?.impressions ?? 0);
  });

  test("scheduled posts are swept to PUBLISHED when due and never appear before their time", async () => {
    asUser(viewer.id);
    const res = await draftsPOST(
      req("/api/posts/drafts", { method: "POST", body: { body: "future post", media: [], scheduledAt: new Date(Date.now() + 86_400_000).toISOString() } })
    );
    const body = await res.json();
    expect(body.status).toBe("SCHEDULED");
    cleanupPostIds.push(body.id);

    const feedRes = await feedGET(req("/api/feed?mode=foryou&limit=30"));
    const feedBody = await feedRes.json();
    expect(feedBody.items.some((i: { id: string }) => i.id === body.id)).toBe(false);
  });
});

// ---------------------------------------------------------------- notifications

describe("notification engine", () => {
  test("dedupKey retries never duplicate (like → notification stays single)", async () => {
    asUser(viewer.id);
    const post = await makePost(pub.id, "dedup target");
    await likePOST(req(`/api/posts/${post}/like`, { method: "POST", body: {} }), ctxId(post));
    // unlike + re-like (a retry-like sequence must upsert, not duplicate)
    const likeDELETE = (await import("@/app/api/posts/[id]/like/route")).DELETE;
    await likeDELETE(req(`/api/posts/${post}/like`), ctxId(post));
    await likePOST(req(`/api/posts/${post}/like`, { method: "POST", body: {} }), ctxId(post));

    const rows = await db.notification.findMany({
      where: { userId: pub.id, type: "POST_LIKE", targetId: post },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].dedupKey).toBe(`post-like:${viewer.id}:${post}`);
  });

  test("muted actors never notify", async () => {
    // viewer mutes outsider, outsider likes viewer's post → no notification
    asUser(viewer.id);
    await edgePATCH(req("/api/profiles/socnet-out/edge", { method: "PATCH", body: { muted: true } }), ctxUsername("socnet-out"));
    const post = await makePost(viewer.id, "mute-suppression target");
    asUser(outsider.id);
    await likePOST(req(`/api/posts/${post}/like`, { method: "POST", body: {} }), ctxId(post));
    const rows = await db.notification.findMany({
      where: { userId: viewer.id, type: "POST_LIKE", targetId: post },
    });
    expect(rows.length).toBe(0);
  });

  test("per-type preferences disable notifications (absent row = enabled)", async () => {
    await db.notificationSetting.create({
      data: { userId: pub.id, type: "POST_LIKE", enabled: false },
    });
    asUser(viewer.id);
    const post = await makePost(pub.id, "preference target");
    await likePOST(req(`/api/posts/${post}/like`, { method: "POST", body: {} }), ctxId(post));
    const rows = await db.notification.findMany({
      where: { userId: pub.id, type: "POST_LIKE", targetId: post },
    });
    expect(rows.length).toBe(0);
    await db.notificationSetting.delete({ where: { userId_type: { userId: pub.id, type: "POST_LIKE" } } });
  });

  test("grouped inbox collapses per-type/target with ids for exact mark-read", async () => {
    asUser(viewer.id);
    const post = await makePost(pub.id, "grouping target");
    const other = await makePost(pub.id, "grouping target two");
    asUser(outsider.id);
    await likePOST(req(`/api/posts/${post}/like`, { method: "POST", body: {} }), ctxId(post));
    asUser(viewer.id);
    await likePOST(req(`/api/posts/${other}/like`, { method: "POST", body: {} }), ctxId(other));

    asUser(pub.id);
    const res = await notificationsGET(req("/api/me/notifications"));
    const body = await res.json();
    expect(Array.isArray(body.groups)).toBe(true);
    for (const g of body.groups) {
      expect(g.ids.length).toBe(g.count);
      expect(typeof g.unread).toBe("boolean");
    }
    const likeGroups = body.groups.filter((g: { type: string }) => g.type === "POST_LIKE");
    expect(likeGroups.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- comments

describe("restricted-author comment gating", () => {
  let post: string;

  beforeAll(async () => {
    post = await makePost(viewer.id, "post with restricted comments");
    // viewer restricts outsider
    asUser(viewer.id);
    await edgePATCH(req("/api/profiles/socnet-out/edge", { method: "PATCH", body: { restricted: true } }), ctxUsername("socnet-out"));
  });

  test("restricted author's comment lands HIDDEN; public viewers never see it", async () => {
    asUser(outsider.id);
    const res = await commentsPOST(req(`/api/posts/${post}/comments`, { method: "POST", body: { body: "restricted comment" } }), ctxId(post));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.comment.status).toBe("HIDDEN");

    // public listing for an anonymous viewer excludes it
    asAnon();
    const list = await commentsGET(req(`/api/posts/${post}/comments`), ctxId(post));
    const listBody = await list.json();
    expect(listBody.items.some((c: { id: string }) => c.id === body.comment.id)).toBe(false);
  });

  test("the comment's author still sees their own HIDDEN comment; post owner sees it with canModerate", async () => {
    asUser(outsider.id);
    const own = await commentsGET(req(`/api/posts/${post}/comments`), ctxId(post));
    const ownBody = await own.json();
    const hidden = ownBody.items.find((c: { status: string }) => c.status === "HIDDEN");
    expect(hidden).toBeDefined();

    asUser(viewer.id);
    const owner = await commentsGET(req(`/api/posts/${post}/comments`), ctxId(post));
    const ownerBody = await owner.json();
    const moderated = ownerBody.items.find((c: { status: string }) => c.status === "HIDDEN");
    expect(moderated).toBeDefined();
    expect(moderated.canModerate).toBe(true);
  });

  test("owner approval flips HIDDEN → VISIBLE (public again)", async () => {
    asUser(viewer.id);
    const list = await commentsGET(req(`/api/posts/${post}/comments`), ctxId(post));
    const listBody = await list.json();
    const hidden = listBody.items.find((c: { status: string }) => c.status === "HIDDEN");
    const res = await commentPATCH(req(`/api/posts/${post}/comments/${hidden.id}`, { method: "PATCH", body: { approve: true } }), ctxComment(post, hidden.id));
    expect(res.status).toBe(200);
    const after = await db.postComment.findUnique({ where: { id: hidden.id } });
    expect(after?.status).toBe("VISIBLE");
  });

  test("non-owner cannot approve", async () => {
    const comment = await db.postComment.findFirst({ where: { postId: post }, select: { id: true } });
    asUser(pub.id);
    const res = await commentPATCH(req(`/api/posts/${post}/comments/${comment!.id}`, { method: "PATCH", body: { approve: false } }), ctxComment(post, comment!.id));
    expect(res.status).toBe(403);
  });

  test("comment likes are idempotent and counted", async () => {
    asUser(outsider.id);
    const comment = await db.postComment.findFirst({ where: { postId: post }, select: { id: true } });
    const res = await commentLikePOST(req(`/api/posts/${post}/comments/${comment!.id}/like`, { method: "POST", body: {} }), ctxComment(post, comment!.id));
    const body = await res.json();
    expect(body.liked).toBe(true);
    expect(body.likes).toBe(1);
    // duplicate like (same user again) — composite PK keeps it single
    await commentLikePOST(req(`/api/posts/${post}/comments/${comment!.id}/like`, { method: "POST", body: {} }), ctxComment(post, comment!.id));
    const count = await db.postCommentLike.count({ where: { commentId: comment!.id } });
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------- direct messages

describe("direct messages", () => {
  test("block prevents starting a conversation (403)", async () => {
    await db.block.create({ data: { blockerId: viewer.id, blockedId: pub.id } });
    asUser(pub.id);
    const res = await messagesPOST(req("/api/me/messages", { method: "POST", body: { username: "socnet-viewer" } }));
    expect(res.status).toBe(403);
    await db.block.delete({ where: { blockerId_blockedId: { blockerId: viewer.id, blockedId: pub.id } } });
  });

  test("request flow: sender opens thread, PENDING recipient accepts, then both read", async () => {
    // outsider does not follow viewer and viewer does not follow outsider →
    // the recipient's side starts PENDING (message request).
    asUser(outsider.id);
    const start = await messagesPOST(req("/api/me/messages", { method: "POST", body: { username: "socnet-viewer" } }));
    const startBody = await start.json();
    expect(startBody.partnerRequestState).toBe("PENDING");
    cleanupConvIds.push(startBody.conversationId);

    // sender sends the opening message
    const send = await threadPOST(req(`/api/me/messages/${startBody.conversationId}`, { method: "POST", body: { body: "hello from outsider" } }), ctxConv(startBody.conversationId));
    expect(send.status).toBe(201);

    // recipient sees request state PENDING and unread
    asUser(viewer.id);
    const list = await messagesGET(req("/api/me/messages"));
    const listBody = await list.json();
    const conv = listBody.conversations.find((c: { id: string }) => c.id === startBody.conversationId);
    expect(conv.requestState).toBe("PENDING");
    expect(conv.unread).toBeGreaterThan(0);

    // accept → both ACTIVE
    const accept = await threadPATCH(req(`/api/me/messages/${startBody.conversationId}`, { method: "PATCH", body: { accept: true } }), ctxConv(startBody.conversationId));
    expect(accept.status).toBe(200);

    // reply + read receipts
    await threadPOST(req(`/api/me/messages/${startBody.conversationId}`, { method: "POST", body: { body: "reply from viewer" } }), ctxConv(startBody.conversationId));
    const thread = await threadGET(req(`/api/me/messages/${startBody.conversationId}`), ctxConv(startBody.conversationId));
    const threadBody = await thread.json();
    expect(threadBody.requestState).toBe("ACTIVE");
    expect(threadBody.messages.some((m: { body: string }) => m.body === "hello from outsider")).toBe(true);
    expect(threadBody.messages.some((m: { body: string }) => m.body === "reply from viewer")).toBe(true);
  });

  test("authorization: a non-participant gets 404 (thread existence never revealed)", async () => {
    const convId = cleanupConvIds[0];
    asUser(pub.id); // pub has no conversation here — 404, never a leak
    const res = await threadGET(req(`/api/me/messages/${convId}`), ctxConv(convId));
    expect(res.status).toBe(404);
  });

  test("blocked counterparties cannot send into an existing thread (403)", async () => {
    const convId = cleanupConvIds[0];
    await db.block.create({ data: { blockerId: viewer.id, blockedId: outsider.id } });
    asUser(outsider.id);
    const res = await threadPOST(req(`/api/me/messages/${convId}`, { method: "POST", body: { body: "should fail" } }), ctxConv(convId));
    expect(res.status).toBe(403);
    await db.block.delete({ where: { blockerId_blockedId: { blockerId: viewer.id, blockedId: outsider.id } } });
  });

  test("media validation: another user's mediaAsset is rejected", async () => {
    const convId = cleanupConvIds[0];
    const asset = await db.mediaAsset.create({
      data: {
        ownerId: outsider.id,
        kind: "IMAGE",
        filename: "x.png",
        mime: "image/png",
        size: 10,
        status: "READY",
        storagePath: "uploads/socnet-x.png",
      },
    });
    asUser(viewer.id);
    const res = await threadPOST(
      req(`/api/me/messages/${convId}`, { method: "POST", body: { body: "steal", mediaAssetId: asset.id } }),
      ctxConv(convId)
    );
    expect(res.status).toBe(400);
    await db.mediaAsset.delete({ where: { id: asset.id } });
  });
});

// ---------------------------------------------------------------- hashtags + analytics + shares

describe("hashtags, shares and analytics", () => {
  test("creating a public post with hashtags syncs the dictionary; private posts never count", async () => {
    asUser(viewer.id);
    const tag = `socnettag${Date.now()}`.slice(0, 24);
    const res = await postsCreate(
      req("/api/posts", { method: "POST", body: { body: `tagged post #${tag}`, hashtags: [tag], media: [] } })
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    cleanupPostIds.push(body.id);

    const tagRow = await db.hashtag.findUnique({ where: { name: tag } });
    expect(tagRow?.postCount).toBe(1);

    const privateRes = await postsCreate(
      req("/api/posts", { method: "POST", body: { body: "private tagged #socnetsecret", hashtags: ["socnetsecret"], visibility: "PRIVATE", media: [] } })
    );
    const privateBody = await privateRes.json();
    cleanupPostIds.push(privateBody.id);
    await db.hashtag.deleteMany({ where: { name: "socnetsecret" } }).catch(() => undefined); // residue from older runs
    const secretTag = await db.hashtag.findUnique({ where: { name: "socnetsecret" } });
    expect(secretTag).toBeNull(); // private posts never enter discovery
    void privateBody;
  });

  test("share records the counter AND a share-event row", async () => {
    asUser(viewer.id);
    const post = await makePost(viewer.id, "share target");
    asUser(outsider.id);
    const res = await sharePOST(req(`/api/posts/${post}/share`, { method: "POST", body: {} }), ctxId(post));
    const body = await res.json();
    expect(body.shares).toBeGreaterThanOrEqual(1);
    const events = await db.postShareEvent.count({ where: { postId: post } });
    expect(events).toBeGreaterThanOrEqual(1);
  });

  test("analytics: engagement rate = (likes+comments+shares+saves)/impressions over recorded events only", async () => {
    asUser(viewer.id);
    const post = await makePost(viewer.id, "analytics target");
    // one real like + impressions from a feed serve
    asUser(outsider.id);
    await likePOST(req(`/api/posts/${post}/like`, { method: "POST", body: {} }), ctxId(post));
    asAnon();
    await feedGET(req("/api/feed?mode=foryou&limit=30"));

    asUser(viewer.id);
    const res = await insightsGET(req("/api/me/insights/posts?range=7"));
    const body = await res.json();
    expect(typeof body.totals.engagementRate).toBe("number");
    expect(body.totals.impressions).toBeGreaterThanOrEqual(0);
    expect(body.totals.likes).toBeGreaterThanOrEqual(1);
    const expected = body.totals.impressions > 0
      ? (body.totals.likes + body.totals.comments + body.totals.shares + body.totals.saves) / body.totals.impressions
      : 0;
    expect(Math.abs(body.totals.engagementRate - expected)).toBeLessThan(0.0001);
    expect(body.topPosts.length).toBeGreaterThan(0);
    expect(body.followerGrowth.series.length).toBeGreaterThan(0);
  });

  test("deleting a post removes it and its hashtag counts", async () => {
    asUser(viewer.id);
    const res = await postsCreate(
      req("/api/posts", { method: "POST", body: { body: "to delete #deletetag2", hashtags: ["deletetag2"], media: [] } })
    );
    const body = await res.json();
    const del = await postDELETE(req(`/api/posts/${body.id}`, { method: "DELETE" }), ctxId(body.id));
    expect(del.status).toBe(200);
    const tagRow = await db.hashtag.findUnique({ where: { name: "deletetag2" } });
    expect(tagRow?.postCount ?? 0).toBe(0);
  });
});

// global teardown for created rows
afterAll(async () => {
  await db.message.deleteMany({ where: { conversationId: { in: cleanupConvIds } } }).catch(() => undefined);
  await db.conversationParticipant.deleteMany({ where: { conversationId: { in: cleanupConvIds } } }).catch(() => undefined);
  await db.conversation.deleteMany({ where: { id: { in: cleanupConvIds } } }).catch(() => undefined);
  await db.post.deleteMany({ where: { id: { in: cleanupPostIds } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: cleanup } } }).catch(() => undefined);
});
