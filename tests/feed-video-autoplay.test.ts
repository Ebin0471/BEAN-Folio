/**
 * Part B — social video autoplay + post-media delivery.
 *
 * Two layers:
 *  1. The feed-video coordinator store: one active video at a time, muted
 *     autoplay default, atomic switch between videos, user-pause pinning,
 *     release on scroll-away, tab-hidden pause, blocked-autoplay fallback —
 *     all tested against fake media elements (no DOM required).
 *  2. The /api/media/[id]/raw post-media ladder: PUBLIC posts of live,
 *     publicly-visible authors serve bytes to EVERYONE (anonymous included,
 *     publicly cacheable — the feed renders them for every visitor);
 *     PRIVATE/draft/scheduled posts and demo fixtures stay author-only;
 *     posters follow the same verdict as their video. Nothing about the
 *     previous ladders (owner, avatar, project, published sites) changes.
 *
 * Run: bun test tests/feed-video-autoplay.test.ts
 */

import { describe, expect, test, afterAll, beforeAll, mock } from "bun:test";
import { NextRequest } from "next/server";
import { putObject, deleteObject } from "@/lib/storage";

// --- armed auth pattern (same as social-network.test.ts) -------------------

declare global {
  var __feedVideoAuth: { armed: boolean; userId: string | null } | undefined;
}
globalThis.__feedVideoAuth = { armed: false, userId: null };

const actualAuth = await import("@/lib/auth");
const realGetSessionUser = actualAuth.getSessionUser;
const snapshot = { ...actualAuth };

mock.module("@/lib/auth", () => ({
  ...snapshot,
  getSessionUser: async () => {
    const s = globalThis.__feedVideoAuth!;
    if (s.armed && s.userId) {
      const { db } = await import("@/lib/db");
      return db.user.findUnique({ where: { id: s.userId } });
    }
    return realGetSessionUser();
  },
}));

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

afterAll(() => {
  mock.restore();
  globalThis.__feedVideoAuth = { armed: false, userId: null };
});

// --- fake media element ----------------------------------------------------

type FakeVideo = {
  paused: boolean;
  muted: boolean;
  ended: boolean;
  play: () => Promise<void>;
  pause: () => void;
};

function fakeVideo(): FakeVideo {
  const v: FakeVideo = {
    paused: true,
    muted: true,
    ended: false,
    play: undefined as unknown as () => Promise<void>,
    pause: undefined as unknown as () => void,
  };
  v.play = async () => {
    if (v.ended) return; // a failed/ended element refuses play (autoplay rejection)
    v.paused = false;
  };
  v.pause = () => {
    v.paused = true;
  };
  return v;
}

function fakeBlockedVideo(): FakeVideo {
  const v = fakeVideo();
  v.ended = true; // play() resolves-but-refuses marker used by the fakes
  (v as unknown as { play: () => Promise<void> }).play = () =>
    Promise.reject(new DOMException("play() failed", "NotAllowedError"));
  return v;
}

// --- store contract ---------------------------------------------------------

import { FEED_VIDEO, useFeedVideo } from "@/lib/feed-video";

describe("feed video coordinator", () => {
  test("autoplay is muted by default and unmuting is an explicit user action", () => {
    expect(useFeedVideo.getState().muted).toBe(true);
    useFeedVideo.getState().setMuted(false);
    expect(useFeedVideo.getState().muted).toBe(false);
    useFeedVideo.getState().setMuted(true);
  });

  test("claiming playback pauses the previous active video (atomic switch, never two)", () => {
    const store = useFeedVideo.getState();
    const a = fakeVideo();
    const b = fakeVideo();
    expect(store.claim("v1", a as unknown as HTMLVideoElement, { reducedMotion: false })).toBe(true);
    expect(a.paused).toBe(false);
    expect(useFeedVideo.getState().activeId).toBe("v1");

    expect(useFeedVideo.getState().claim("v2", b as unknown as HTMLVideoElement, { reducedMotion: false })).toBe(true);
    // The previous video STOPPED before the next one started:
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(false);
    expect(useFeedVideo.getState().activeId).toBe("v2");
  });

  test("release pauses the video and frees the active slot", () => {
    const store = useFeedVideo.getState();
    const a = fakeVideo();
    store.claim("rel1", a as unknown as HTMLVideoElement, { reducedMotion: false });
    expect(a.paused).toBe(false);
    store.release("rel1", a as unknown as HTMLVideoElement);
    expect(a.paused).toBe(true);
    expect(useFeedVideo.getState().activeId).toBeNull();
  });

  test("reduced motion and hidden tabs refuse autoplay (manual play control instead)", () => {
    const store = useFeedVideo.getState();
    const a = fakeVideo();
    expect(store.claim("rm1", a as unknown as HTMLVideoElement, { reducedMotion: true })).toBe(false);
    expect(a.paused).toBe(true);
    expect(useFeedVideo.getState().activeId).toBeNull();
  });

  test("browser autoplay rejection is recorded so the UI shows the manual control", async () => {
    const store = useFeedVideo.getState();
    const blocked = fakeBlockedVideo();
    store.claim("blk1", blocked as unknown as HTMLVideoElement, { reducedMotion: false });
    await Promise.resolve(); // the NotAllowedError rejection lands on a microtask
    expect(useFeedVideo.getState().autoplayBlocked.has("blk1")).toBe(true);
    expect(useFeedVideo.getState().activeId).toBeNull(); // not actually playing
    // Manual play recovers:
    const manual = fakeVideo();
    (manual as unknown as { muted: boolean }).muted = false;
    store.userPlay("blk1", manual as unknown as HTMLVideoElement);
    expect(useFeedVideo.getState().autoplayBlocked.has("blk1")).toBe(false);
    expect(manual.paused).toBe(false);
    store.release("blk1", manual as unknown as HTMLVideoElement);
  });

  test("explicit user pause pins the video off; scrolling away clears the pin", () => {
    const store = useFeedVideo.getState();
    const a = fakeVideo();
    store.claim("up1", a as unknown as HTMLVideoElement, { reducedMotion: false });
    store.userToggle("up1", a as unknown as HTMLVideoElement, { reducedMotion: false });
    expect(a.paused).toBe(true);
    expect(useFeedVideo.getState().userPaused.has("up1")).toBe(true);
    // IO re-claim while still dominant must NOT autoplay a user-paused video:
    expect(store.claim("up1", a as unknown as HTMLVideoElement, { reducedMotion: false })).toBe(false);
    expect(a.paused).toBe(true);
    // Leaving the screen clears the pin, so scrolling back resumes normally:
    store.release("up1", a as unknown as HTMLVideoElement);
    expect(useFeedVideo.getState().userPaused.has("up1")).toBe(false);
    store.claim("up1", a as unknown as HTMLVideoElement, { reducedMotion: false });
    expect(a.paused).toBe(false);
    store.release("up1", a as unknown as HTMLVideoElement);
  });

  test("userToggle resumes a paused video and claims the slot", () => {
    const store = useFeedVideo.getState();
    const a = fakeVideo();
    store.userToggle("ut1", a as unknown as HTMLVideoElement, { reducedMotion: false });
    expect(a.paused).toBe(false);
    expect(useFeedVideo.getState().activeId).toBe("ut1");
    store.userToggle("ut1", a as unknown as HTMLVideoElement, { reducedMotion: false });
    expect(a.paused).toBe(true);
    store.release("ut1", a as unknown as HTMLVideoElement);
  });

  test("pauseActive stops whatever plays (tab hidden) without pinning it", () => {
    const store = useFeedVideo.getState();
    const a = fakeVideo();
    store.claim("pa1", a as unknown as HTMLVideoElement, { reducedMotion: false });
    useFeedVideo.getState().pauseActive();
    expect(a.paused).toBe(true);
    expect(useFeedVideo.getState().activeId).toBeNull();
    expect(useFeedVideo.getState().userPaused.has("pa1")).toBe(false);
    // The next IO claim plays it again (it was not a user pause):
    store.claim("pa1", a as unknown as HTMLVideoElement, { reducedMotion: false });
    expect(a.paused).toBe(false);
    store.release("pa1", a as unknown as HTMLVideoElement);
  });

  test("unregister removes block pins so a re-mounted player starts clean", async () => {
    const store = useFeedVideo.getState();
    const blocked = fakeBlockedVideo();
    store.claim("unreg", blocked as unknown as HTMLVideoElement, { reducedMotion: false });
    await Promise.resolve(); // let the rejection handler record the block
    expect(useFeedVideo.getState().autoplayBlocked.has("unreg")).toBe(true);
    useFeedVideo.getState().unregister("unreg");
    expect(useFeedVideo.getState().autoplayBlocked.has("unreg")).toBe(false);
  });

  test("thresholds encode the dominant-visibility hysteresis band", () => {
    expect(FEED_VIDEO.PLAY_AT).toBeGreaterThan(FEED_VIDEO.STOP_AT);
    expect(FEED_VIDEO.PLAY_AT).toBeGreaterThanOrEqual(0.5);
    expect(FEED_VIDEO.STOP_AT).toBeGreaterThan(0);
  });
});

// --- post media ladder ------------------------------------------------------

import { db } from "@/lib/db";
import { GET as rawGET } from "@/app/api/media/[id]/raw/route";

const cleanupUsers: string[] = [];
const cleanupAssets: string[] = [];
const cleanupPosts: string[] = [];

async function makeUser(username: string, opts?: { visibility?: string; demo?: boolean }) {
  const u = await db.user.create({
    data: {
      email: `${username}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`,
      passwordHash: "0".repeat(32) + ":" + "0".repeat(128),
      name: username,
      username,
      onboarded: true,
      profileVisibility: opts?.visibility ?? "PUBLIC",
      isDemo: opts?.demo ?? false,
    },
  });
  cleanupUsers.push(u.id);
  return u;
}

const FIXTURE_BLOB = "uploads/test-fixtures/feed-video-fixture.bin";

async function makeMedia(ownerId: string, mime = "video/mp4", storagePath = FIXTURE_BLOB) {
  const m = await db.mediaAsset.create({
    data: { ownerId, kind: mime.startsWith("video") ? "VIDEO" : "IMAGE", filename: "f", mime, size: 38, status: "READY", storagePath },
  });
  cleanupAssets.push(m.id);
  return m;
}

async function makePost(authorId: string, mediaId: string, opts?: { visibility?: string; status?: string; posterId?: string | null }) {
  const p = await db.post.create({
    data: {
      authorId,
      body: "video ladder fixture",
      hashtags: "[]",
      mediaKind: "VIDEO",
      visibility: opts?.visibility ?? "PUBLIC",
      status: opts?.status ?? "PUBLISHED",
      media: {
        create: {
          mediaAssetId: mediaId,
          order: 0,
          ...(opts?.posterId !== undefined ? { posterMediaAssetId: opts.posterId } : {}),
        },
      },
    },
  });
  cleanupPosts.push(p.id);
  return p;
}

function rawReq(id: string) {
  return new NextRequest(`http://localhost/api/media/${id}/raw`);
}
const rawCtx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("post media delivery ladder", () => {
  let author: Awaited<ReturnType<typeof makeUser>>;
  let viewer: Awaited<ReturnType<typeof makeUser>>;
  let demo: Awaited<ReturnType<typeof makeUser>>;
  let publicVideo: Awaited<ReturnType<typeof makeMedia>>;
  let publicPost: Awaited<ReturnType<typeof makePost>>;
  let poster: Awaited<ReturnType<typeof makeMedia>>;
  let privateVideo: Awaited<ReturnType<typeof makeMedia>>;
  let privatePost: Awaited<ReturnType<typeof makePost>>;
  let draftVideo: Awaited<ReturnType<typeof makeMedia>>;
  let draftPost: Awaited<ReturnType<typeof makePost>>;

  beforeAll(async () => {
    // The fixture blob lives under the (gitignored) uploads/ storage root, so
    // sandbox restores can wipe it — write it through the storage layer
    // instead of depending on pre-existing disk state. 38 bytes to match the
    // MediaAsset.size the rows below declare.
    await putObject(FIXTURE_BLOB, Buffer.from("v".repeat(38), "utf8"), "application/octet-stream");
    author = await makeUser("vlda");
    viewer = await makeUser("vldv");
    demo = await makeUser("vldd", { demo: true });
    publicVideo = await makeMedia(author.id);
    poster = await makeMedia(author.id, "image/jpeg");
    publicPost = await makePost(author.id, publicVideo.id, { posterId: poster.id });
    privateVideo = await makeMedia(author.id);
    privatePost = await makePost(author.id, privateVideo.id, { visibility: "PRIVATE" });
    draftVideo = await makeMedia(author.id);
    draftPost = await makePost(author.id, draftVideo.id, { status: "DRAFT" });
  });

  test("PUBLIC post video serves EVERYONE anonymously, publicly cacheable", async () => {
    globalThis.__feedVideoAuth = { armed: false, userId: null };
    const res = await rawGET(rawReq(publicVideo.id), rawCtx(publicVideo.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
  });

  test("the poster of a PUBLIC post follows the same verdict (anonymous)", async () => {
    globalThis.__feedVideoAuth = { armed: false, userId: null };
    const res = await rawGET(rawReq(poster.id), rawCtx(poster.id));
    expect(res.status).not.toBe(403);
    expect(res.headers.get("cache-control")).toContain("public");
  });

  test("another signed-in viewer reads PUBLIC post media (feed behavior)", async () => {
    globalThis.__feedVideoAuth = { armed: true, userId: viewer.id };
    const res = await rawGET(rawReq(publicVideo.id), rawCtx(publicVideo.id));
    expect(res.status).not.toBe(403);
  });

  test("PRIVATE post video stays author-only; nobody else, not even cacheable", async () => {
    globalThis.__feedVideoAuth = { armed: true, userId: viewer.id };
    const res = await rawGET(rawReq(privateVideo.id), rawCtx(privateVideo.id));
    expect(res.status).toBe(403);
    // The author themselves still reads it (private cache class):
    globalThis.__feedVideoAuth = { armed: true, userId: author.id };
    const own = await rawGET(rawReq(privateVideo.id), rawCtx(privateVideo.id));
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).not.toContain("public");
  });

  test("DRAFT posts never leak their media (owner-only even when visibility PUBLIC)", async () => {
    globalThis.__feedVideoAuth = { armed: true, userId: viewer.id };
    const res = await rawGET(rawReq(draftVideo.id), rawCtx(draftVideo.id));
    expect(res.status).toBe(403);
  });

  test("demo-fixture authors' posts stay non-public (no anonymous feed media)", async () => {
    const demoMedia = await makeMedia(demo.id);
    await makePost(demo.id, demoMedia.id);
    globalThis.__feedVideoAuth = { armed: false, userId: null };
    const res = await rawGET(rawReq(demoMedia.id), rawCtx(demoMedia.id));
    expect(res.status).toBe(403);
  });

  test("missing objects report 404 after authorization (not 403)", async () => {
    const orphan = await makeMedia(author.id, "video/mp4", "/nonexistent");
    await db.postMedia.create({ data: { postId: publicPost.id, mediaAssetId: orphan.id, order: 1 } });
    globalThis.__feedVideoAuth = { armed: false, userId: null };
    const res = await rawGET(rawReq(orphan.id), rawCtx(orphan.id));
    // storagePath /nonexistent: the ladder ALLOWS, then the object is gone.
    expect(res.status).toBe(404);
  });

  test("deleted authors' public posts stop serving media", async () => {
    const gone = await makeUser("vldg");
    const m = await makeMedia(gone.id);
    const p = await makePost(gone.id, m.id);
    await db.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    globalThis.__feedVideoAuth = { armed: false, userId: null };
    const res = await rawGET(rawReq(m.id), rawCtx(m.id));
    expect(res.status).toBe(403);
  });

  afterAll(async () => {
    for (const id of cleanupPosts) await db.post.deleteMany({ where: { id } });
    for (const id of cleanupAssets) await db.mediaAsset.deleteMany({ where: { id } });
    for (const id of cleanupUsers) await db.user.deleteMany({ where: { id } });
    await deleteObject(FIXTURE_BLOB).catch(() => undefined);
  });
});
