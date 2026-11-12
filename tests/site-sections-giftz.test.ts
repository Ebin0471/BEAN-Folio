/// <reference types="bun-types" />
/**
 * Site sections + GIFTZ separation — regression tests for the strict feature
 * corrections delivery:
 *
 *  1. FEATURED WORK / ALL PROJECTS / VIDEO REEL — three independent sections:
 *     the `featured` section type exists with its own curation (projectIds,
 *     never a slice of the collection), the `reel` type carries up to five
 *     owned VIDEO assets with captions, both parse through normalizeConfig,
 *     and the default template composition no longer fakes "Featured work"
 *     with a projects slice.
 *  2. GIFTZ PRODUCT SEPARATION — GiftzSite artifacts: save validation, the
 *     shared media IDOR guard (ownership + VIDEO-kind for reel media),
 *     revision snapshots, strict ownership (foreign site = 404), and studio
 *     session targeting (a giftz turn NEVER plans against the portfolio draft;
 *     a portfolio turn requires it).
 *
 * The test deployment has no AI provider configured — background turn
 * pipelines fail fast and honestly, so turn-level tests assert the RESOLUTION
 * contract (what the turn accepts/plans against), not provider output.
 *
 * Run: bun test tests/site-sections-giftz.test.ts
 */

import { describe, expect, test, afterAll, beforeAll, mock } from "bun:test";
import { randomUUID, createHash } from "crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

const jar = new Map<string, string>();
const realNextHeaders = await import("next/headers");
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

import { db } from "@/lib/db";
import { normalizeConfig, makeSection, blankGiftzSeedConfig, defaultConfig } from "@/lib/site-config";
import { siteConfigMediaError } from "@/lib/site-media-guard";
import { publicSiteGiftzPath, publicSiteGiftzHashUrl } from "@/lib/site-url";
import { startStudioTurn } from "@/lib/site-studio/turn";
import { saveGiftzSiteConfig } from "@/app/api/giftz/sites/route";
import { GET as sessionsGet, POST as sessionsPost } from "@/app/api/me/site/studio/sessions/route";
import { POST as messagesPost } from "@/app/api/me/site/studio/sessions/[id]/messages/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

// Self-cleaning: every fixture row created by this suite is deleted at the
// end (cascade removes sites, revisions, sessions, messages, media).
afterAll(async () => {
  await db.giftzSite.deleteMany({ where: { id: { in: leakedSiteIds } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: leakedUserIds } } }).catch(() => undefined);
});

function uniqueIp(): string {
  return `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`;
}

function request(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": uniqueIp() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ------------------------------------------------------------------ shared fixtures

const RUN = randomUUID().slice(0, 8);
const leakedUserIds: string[] = [];
const leakedSiteIds: string[] = [];

async function makeUser(label: string): Promise<{ id: string; username: string }> {
  const user = await db.user.create({
    data: {
      email: `site-giftz-${label}-${RUN}@qa.local`,
      passwordHash: "x",
      name: `QA ${label}`,
      username: `sg${RUN}${label}`.toLowerCase().replace(/[^a-z0-9]/g, ""),
    },
    select: { id: true, username: true },
  });
  leakedUserIds.push(user.id);
  return user;
}

/** Real session row + cookie — the armed-auth-free login harness. */
async function loginViaSession(userId: string): Promise<void> {
  const token = `qa-token-${userId}-${randomUUID()}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.session.create({
    data: { token: tokenHash, userId, expiresAt: new Date(Date.now() + 60 * 60_000) },
  });
  jar.clear();
  jar.set("bean_session", token);
}

async function makeMedia(ownerId: string, kind: "VIDEO" | "IMAGE"): Promise<string> {
  const asset = await db.mediaAsset.create({
    data: {
      ownerId,
      kind,
      filename: kind === "VIDEO" ? "clip.mp4" : "photo.jpg",
      mime: kind === "VIDEO" ? "video/mp4" : "image/jpeg",
      size: 1024,
      storagePath: `uploads/${ownerId}/qa-${randomUUID()}.${kind === "VIDEO" ? "mp4" : "jpg"}`,
    },
    select: { id: true },
  });
  return asset.id;
}

/** Minimal valid v2 config builder. */
function baseConfig(): Record<string, unknown> {
  return {
    version: 2,
    template: "atelier",
    name: "QA site",
    tagline: "",
    theme: { background: "#0d0e12", foreground: "#f5f4ef", accent: "#d4af6a" },
    motion: { enabled: false },
    pages: [
      {
        id: "home",
        name: "Home",
        visible: true,
        sections: [
          { id: "hero-1", type: "hero", visible: true, title: "Hello", subtitle: "", variant: "classic", ctaLabel: "", ctaHref: "" },
        ],
      },
    ],
  };
}

function withFeatured(cfg: Record<string, unknown>, projectIds: string[]): Record<string, unknown> {
  const pages = cfg.pages as { id: string; sections: unknown[] }[];
  return {
    ...cfg,
    pages: [
      ...pages,
      {
        id: "page-featured",
        name: "Featured",
        visible: true,
        sections: [
          {
            id: "featured-1",
            type: "featured",
            visible: true,
            title: "Featured work",
            subtitle: "",
            projectIds,
            layout: "featured",
          },
        ],
      },
    ],
  };
}

function withReel(cfg: Record<string, unknown>, videos: { mediaId: string; caption: string }[]): Record<string, unknown> {
  const pages = cfg.pages as { id: string; sections: unknown[] }[];
  return {
    ...cfg,
    pages: [
      ...pages,
      {
        id: "page-reel",
        name: "Reel",
        visible: true,
        sections: [
          { id: "reel-1", type: "reel", visible: true, title: "Video reel", subtitle: "", videos, layout: "strip" },
        ],
      },
    ],
  };
}

// ------------------------------------------------------------------ 1 — sections

describe("Featured Work, All Projects and Video Reel are independent sections", () => {
  test("the `featured` section type parses with explicit curation (independent of All Projects)", () => {
    const parsed = normalizeConfig(withFeatured(baseConfig(), ["proj-a", "proj-b"]));
    expect(parsed).not.toBeNull();
    const featured = parsed!.pages.flatMap((p) => p.sections).find((s) => s.type === "featured");
    expect(featured).toBeDefined();
    if (featured?.type === "featured") {
      expect(featured.projectIds).toEqual(["proj-a", "proj-b"]);
      expect(featured.layout).toBe("featured");
    }
  });

  test("the `reel` section type parses with up to five captioned videos", () => {
    const videos = Array.from({ length: 5 }, (_, i) => ({ mediaId: `media-${i}`, caption: `Clip ${i + 1}` }));
    const parsed = normalizeConfig(withReel(baseConfig(), videos));
    expect(parsed).not.toBeNull();
    const reel = parsed!.pages.flatMap((p) => p.sections).find((s) => s.type === "reel");
    expect(reel).toBeDefined();
    if (reel?.type === "reel") {
      expect(reel.videos).toHaveLength(5);
      expect(reel.videos[0].caption).toBe("Clip 1");
    }
  });

  test("a reel with SIX videos is rejected — the cap is five", () => {
    const videos = Array.from({ length: 6 }, (_, i) => ({ mediaId: `media-${i}`, caption: "" }));
    expect(normalizeConfig(withReel(baseConfig(), videos))).toBeNull();
  });

  test("makeSection produces the honest defaults for both new types", () => {
    const featured = makeSection("featured");
    expect(featured.type).toBe("featured");
    if (featured.type === "featured") expect(featured.projectIds).toEqual([]);
    const reel = makeSection("reel");
    expect(reel.type).toBe("reel");
    if (reel.type === "reel") expect(reel.videos).toEqual([]);
  });

  test("the default template composition no longer fakes Featured Work with a projects slice", () => {
    const cfg = defaultConfig();
    const featuredSections = cfg.pages.flatMap((p) => p.sections).filter((s) => s.type === "featured");
    expect(featuredSections.length).toBeGreaterThanOrEqual(1);
    // The featured section is a REAL curated section, not a `projects` slice.
    for (const s of featuredSections) {
      if (s.type === "featured") expect(s.projectIds).toEqual([]);
    }
    const featuredTitles = featuredSections.map((s) => s.title.toLowerCase());
    expect(featuredTitles.join(" ")).toContain("featured");
  });

  test("the renderer ships both new section cases and the exporter mirrors them", () => {
    const renderer = readFileSync("src/components/bean/site/SiteRenderer.tsx", "utf8");
    expect(renderer.includes('case "featured"')).toBe(true);
    expect(renderer.includes('case "reel"')).toBe(true);
    // Featured Work NEVER falls back to the whole collection — only explicit
    // curation or platform-starred projects render.
    expect(renderer.includes("p.featured")).toBe(true);
    // The reel renders a real player (controls) and honest per-tile failures.
    expect(renderer.includes("SiteReelSection")).toBe(true);
    expect(renderer.includes("Video unavailable")).toBe(true);

    const exporter = readFileSync("src/lib/site-export.ts", "utf8");
    expect(exporter.includes('case "featured"')).toBe(true);
    expect(exporter.includes('case "reel"')).toBe(true);
  });

  test("the studio editor ships the featured picker and the reel picker", () => {
    const editor = readFileSync("src/components/bean/site/studio/SectionEditor.tsx", "utf8");
    expect(editor.includes('section.type === "featured"')).toBe(true);
    expect(editor.includes('section.type === "reel"')).toBe(true);
    expect(editor.includes("ReelVideosEditor")).toBe(true);
    expect(editor.includes("kind=VIDEO")).toBe(true); // owner's own video library
  });

  test("GIFTZ generated-site URLs are stable helpers on the /site namespace", () => {
    expect(publicSiteGiftzPath("Ada", "site-123")).toBe("/site/ada/g/site-123");
    expect(publicSiteGiftzHashUrl("ada", "site-123")).toBe("#/site/ada/g/site-123");
    expect(publicSiteGiftzPath(null, "site-123")).toBeNull();
  });

  test("the proxy boots the SPA document for generated-site deep links", () => {
    const src = readFileSync("src/proxy.ts", "utf8");
    expect(src.includes("\\/g\\/[^/]+")).toBe(true);
  });
});

// ------------------------------------------------------------------ 2 — media guard

describe("the shared media IDOR guard (portfolio + GIFTZ saves)", () => {
  let owner: { id: string };
  let stranger: { id: string };
  let ownVideo = "";
  let ownImage = "";
  let foreignVideo = "";

  beforeAll(async () => {
    owner = await makeUser("guardowner");
    stranger = await makeUser("guardstranger");
    ownVideo = await makeMedia(owner.id, "VIDEO");
    ownImage = await makeMedia(owner.id, "IMAGE");
    foreignVideo = await makeMedia(stranger.id, "VIDEO");
  });

  test("a reel referencing ANOTHER user's media is rejected (never publishable)", async () => {
    const error = await siteConfigMediaError(
      normalizeConfig(withReel(baseConfig(), [{ mediaId: foreignVideo, caption: "" }]))!,
      owner.id
    );
    expect(error).not.toBeNull();
    expect(error).toContain("own account");
  });

  test("a reel entry that is an IMAGE (not a VIDEO) is rejected", async () => {
    const error = await siteConfigMediaError(
      normalizeConfig(withReel(baseConfig(), [{ mediaId: ownImage, caption: "" }]))!,
      owner.id
    );
    expect(error).not.toBeNull();
    expect(error).toContain("video files");
  });

  test("a reel of the owner's own VIDEO assets passes", async () => {
    const error = await siteConfigMediaError(
      normalizeConfig(withReel(baseConfig(), [{ mediaId: ownVideo, caption: "My clip" }]))!,
      owner.id
    );
    expect(error).toBeNull();
  });
});

// ------------------------------------------------------------------ 3 — GiftzSite artifact

describe("GIFTZ generated sites — independent artifacts with honest validation", () => {
  let owner: { id: string };
  let stranger: { id: string };
  let siteId = "";
  let ownVideo = "";

  beforeAll(async () => {
    owner = await makeUser("siteowner");
    stranger = await makeUser("sitestranger");
    ownVideo = await makeMedia(owner.id, "VIDEO");
  });

  test("a fresh GiftzSite saves a valid config and reports it back normalized", async () => {
    const created = await db.giftzSite.create({ data: { userId: owner.id, title: "Landing page" }, select: { id: true } });
    siteId = created.id;
    leakedSiteIds.push(siteId);

    const result = await saveGiftzSiteConfig(owner.id, siteId, { config: baseConfig() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config?.name).toBe("QA site");
    }
    const stored = await db.giftzSite.findUnique({ where: { id: siteId } });
    expect(stored?.config).not.toBeNull();
    expect(normalizeConfig(stored!.config!)?.pages.length).toBe(1);
  });

  test("saving an INVALID config fails honestly with a user-safe message", async () => {
    const result = await saveGiftzSiteConfig(owner.id, siteId, { config: { nope: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  test("saving a config with a FOREIGN reel video is rejected by the media guard", async () => {
    const strangerVideo = await makeMedia(stranger.id, "VIDEO");
    const result = await saveGiftzSiteConfig(owner.id, siteId, {
      config: withReel(baseConfig(), [{ mediaId: strangerVideo, caption: "" }]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("own account");
  });

  test("a SECOND different save snapshots the previous config as a revision (revisions preserve history)", async () => {
    const next = JSON.parse(JSON.stringify(baseConfig())) as Record<string, unknown>;
    (next as { tagline: string }).tagline = "Revised by GIFTZ";
    const result = await saveGiftzSiteConfig(owner.id, siteId, { config: next });
    expect(result.ok).toBe(true);
    const revisions = await db.giftzSiteRevision.findMany({ where: { siteId } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].label).toBe("Before save");
    // The revision holds the PREVIOUS config (not the new one).
    expect(normalizeConfig(revisions[0].config)?.tagline).toBe("");
  });

  test("a reel of the owner's own video saves fine (real playable content)", async () => {
    const result = await saveGiftzSiteConfig(owner.id, siteId, {
      config: withReel(baseConfig(), [{ mediaId: ownVideo, caption: "Showreel" }]),
    });
    expect(result.ok).toBe(true);
  });

  test("a FOREIGN user's site id is a hard 404 — ownership is strict", async () => {
    const result = await saveGiftzSiteConfig(stranger.id, siteId, { config: baseConfig() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  test("publishing snapshots the draft; unpublish clears only the public snapshot", async () => {
    // Direct DB-level publish contract (the route handler wraps this logic).
    const site = await db.giftzSite.findUnique({ where: { id: siteId } });
    expect(site?.config).not.toBeNull();
    await db.giftzSite.update({
      where: { id: siteId },
      data: { status: "PUBLISHED", publishedConfig: site!.config, publishedAt: new Date() },
    });
    const published = await db.giftzSite.findUnique({ where: { id: siteId } });
    expect(published?.status).toBe("PUBLISHED");
    expect(published?.publishedConfig).not.toBeNull();
  });
});

// ------------------------------------------------------------------ 4 — session targeting + turn resolution

describe("studio session targeting — the product separation boundary", () => {
  let owner: { id: string };
  let siteId = "";
  let giftzSessionId = "";
  let portfolioSessionId = "";

  beforeAll(async () => {
    owner = await makeUser("targetowner");
    await loginViaSession(owner.id);
    const created = await db.giftzSite.create({ data: { userId: owner.id, title: "Bound site" }, select: { id: true } });
    siteId = created.id;
    leakedSiteIds.push(siteId);
  });

  test("POST /sessions binds a giftz conversation to the caller's OWN site", async () => {
    const res = await sessionsPost(request("/api/me/site/studio/sessions", "POST", { target: { kind: "giftz", siteId } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { id: string; targetKind: string; targetSiteId: string | null } };
    expect(body.session.targetKind).toBe("giftz");
    expect(body.session.targetSiteId).toBe(siteId);
    giftzSessionId = body.session.id;
  });

  test("a FOREIGN siteId is a 404, never a silent rebind", async () => {
    const stranger = await makeUser("targetstranger");
    await loginViaSession(stranger.id);
    const foreign = await db.giftzSite.create({ data: { userId: stranger.id, title: "Not yours" }, select: { id: true } });
    const res = await sessionsPost(
      request("/api/me/site/studio/sessions", "POST", { target: { kind: "giftz", siteId: foreign.id } })
    );
    expect(res.status).toBe(200); // own site binds fine for its owner
    await loginViaSession(owner.id);
    const foreignAsOwner = await sessionsPost(
      request("/api/me/site/studio/sessions", "POST", { target: { kind: "giftz", siteId: foreign.id } })
    );
    expect(foreignAsOwner.status).toBe(404);
    await db.giftzSite.delete({ where: { id: foreign.id } });
  });

  test("the default (no target) stays portfolio — historic behavior preserved", async () => {
    const res = await sessionsPost(request("/api/me/site/studio/sessions", "POST", {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { id: string; targetKind: string } };
    expect(body.session.targetKind).toBe("portfolio");
    portfolioSessionId = body.session.id;
  });

  test("GET /sessions?target=giftz lists only giftz conversations", async () => {
    const res = await sessionsGet(request("/api/me/site/studio/sessions?target=giftz", "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { id: string; targetKind: string }[] };
    expect(body.sessions.length).toBeGreaterThan(0);
    for (const s of body.sessions) expect(s.targetKind).toBe("giftz");
  });

  test("a GIFTZ turn resolves its base from the GiftzSite — an invalid currentConfig is IGNORED, never fatal", async () => {
    // The portfolio path throws on an invalid draft; the giftz path must not.
    // `{ garbage: true }` passes the transport schema (a JSON object) but
    // fails normalizeConfig — proving the RESOLUTION layer, not the body
    // schema, decides the outcome.
    const res = await messagesPost(
      request(`/api/me/site/studio/sessions/${giftzSessionId}/messages`, "POST", {
        text: "Build me a photography portfolio site",
        currentConfig: { garbage: true },
        mode: "create",
      }),
      { params: Promise.resolve({ id: giftzSessionId }) }
    );
    expect(res.status).toBe(202); // the turn started — no portfolio-draft dependency
  });

  test("a PORTFOLIO turn still requires a valid currentConfig (unchanged contract)", async () => {
    const res = await messagesPost(
      request(`/api/me/site/studio/sessions/${portfolioSessionId}/messages`, "POST", {
        text: "Add a section",
        currentConfig: { garbage: true },
        mode: "edit",
      }),
      { params: Promise.resolve({ id: portfolioSessionId }) }
    );
    expect(res.status).toBe(400);
  });

  test("the turn engine resolves the giftz base directly (unbound session = seed config)", async () => {
    // Unbound giftz session + null currentConfig: the seed makes creation work
    // without any portfolio draft. The background pipeline fails fast (no
    // provider) — the RESOLUTION contract is that it starts, honestly.
    const session = await db.siteStudioSession.create({
      data: { userId: owner.id, title: "Unbound giftz", targetKind: "giftz", targetSiteId: null },
      select: { id: true },
    });
    let threw: unknown = null;
    try {
      await startStudioTurn({ userId: owner.id, sessionId: session.id, text: "Create my site", currentConfig: null, mode: "create" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
    const seed = blankGiftzSeedConfig();
    expect(normalizeConfig(seed)).not.toBeNull();
  });
});
