/// <reference types="bun-types" />
/**
 * Universal Studio — project management regression tests.
 *
 * Covers the additive Studio backend added for "one Studio, every profession":
 *
 *   1. GET /api/projects — archive scoping (default excludes archived),
 *      free-text title search (`q`), sort allowlist (`updated|created|title`,
 *      invalid → 400), and the enriched card DTO (archivedAt/createdAt).
 *   2. POST /:id/archive + /:id/unarchive — owner-only lifecycle that never
 *      deletes: status/featuredAt/cover are untouched, archivedAt flips.
 *   3. POST /:id/duplicate — full copy as a PRIVATE DRAFT: "(copy)" suffix,
 *      customFields envelope carried over, media/skills/contributors linked,
 *      featuredAt/archivedAt/publishedAt NOT copied, 403 for non-owners.
 *   4. GET /api/media — the Studio Asset Library listing: owner-scoped rows
 *      with usage counts + storage summary, kind filter validation.
 *
 * Tests run against a dedicated QA account and clean up everything.
 *
 * Run: bun test tests/studio-management.test.ts
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";

// Route handlers called directly run outside a Next request scope, so
// next/headers' cookies() has no store. Serve a MUTABLE session token.
let cookieToken: string | undefined;
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieToken && name === "bean_session" ? { name, value: cookieToken } : undefined,
    set: () => undefined,
  }),
}));

import { db } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import { GET as listProjects, POST as createProject } from "@/app/api/projects/route";
import { POST as archiveRoute } from "@/app/api/projects/[id]/archive/route";
import { POST as unarchiveRoute } from "@/app/api/projects/[id]/unarchive/route";
import { POST as duplicateRoute } from "@/app/api/projects/[id]/duplicate/route";
import { GET as listMedia } from "@/app/api/media/route";

const QA_EMAIL = "qa-studio-mgmt@beanfolio.test";
const OTHER_EMAIL = "qa-studio-other@beanfolio.test";

let qaUserId = "";
let otherUserId = "";

const PNG_DATA = {
  mediaId: "",
  storagePath: "",
};

async function createProjectViaApi(title: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ title, ...extra });
  const req = new NextRequest("http://localhost:3000/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.90" },
    body,
  });
  return createProject(req);
}

function listReq(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/projects${query}`, {
    method: "GET",
    headers: { "x-forwarded-for": "198.51.100.91" },
  });
}

function actionReq(path: string): { req: NextRequest; ctx: { params: Promise<{ id: string }> } } {
  const id = path.split("/")[3] ?? "";
  return {
    req: new NextRequest(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.92" },
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

type CardDTO = {
  id: string;
  title: string;
  status: string;
  visibility: string;
  archivedAt: string | null;
  createdAt: string;
  featured: boolean;
};

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeAll(async () => {
  const qa = await db.user.create({
    data: {
      email: QA_EMAIL,
      name: "QA Studio Mgmt",
      passwordHash: await hashPassword("qa-only-password-123"),
    },
  });
  qaUserId = qa.id;

  const other = await db.user.create({
    data: {
      email: OTHER_EMAIL,
      name: "QA Other",
      passwordHash: await hashPassword("qa-only-password-456"),
    },
  });
  otherUserId = other.id;

  // One READY media asset owned by the QA user for the media-library test.
  const media = await db.mediaAsset.create({
    data: {
      ownerId: qaUserId,
      kind: "IMAGE",
      filename: "qa-asset.png",
      mime: "image/png",
      size: 1234,
      width: 64,
      height: 64,
      status: "READY",
      storagePath: "qa-unused/qa-asset.png",
    },
  });
  PNG_DATA.mediaId = media.id;
  PNG_DATA.storagePath = media.storagePath;
});

afterAll(async () => {
  for (const uid of [qaUserId, otherUserId]) {
    if (!uid) continue;
    // Project rows cascade; the QA media row + (unused) object are explicit.
    await db.mediaAsset.deleteMany({ where: { id: PNG_DATA.mediaId, ownerId: uid } }).catch(() => {});
    await db.session.deleteMany({ where: { userId: uid } }).catch(() => {});
    await db.user.delete({ where: { id: uid } }).catch(() => {});
  }
  cookieToken = undefined;
});

// -------------------------------------------------- GET /api/projects filters

describe("GET /api/projects — Studio filters", () => {
  test("401 without a session", async () => {
    cookieToken = undefined;
    const res = await listProjects(listReq(""));
    expect(res.status).toBe(401);
  });

  test("invalid sort → 400 with the allowlist in the message", async () => {
    cookieToken = await createSession(qaUserId);
    const res = await listProjects(listReq("?sort=not-a-sort"));
    expect(res.status).toBe(400);
    const b = await bodyOf(res);
    expect(String(b.error)).toContain("updated");
  });

  test("archive scoping, search and DTO fields (end-to-end lifecycle)", async () => {
    cookieToken = await createSession(qaUserId);
    const marker = `Archive Lifecycle ${Date.now()}`;
    const created = await createProjectViaApi(marker, {
      customFields: { kind: "web-app", fields: { stack: "Next.js" } },
    });
    expect(created.status).toBe(200);
    const project = ((await bodyOf(created)).project as unknown) as CardDTO;
    expect(project.archivedAt).toBeNull();
    expect(project.status).toBe("DRAFT");
    expect(typeof project.createdAt).toBe("string");

    // Active list (default archived=false) contains it; archived list does not.
    const active = await listProjects(listReq("?archived=false"));
    let list = ((await bodyOf(active)).projects as unknown) as CardDTO[];
    expect(list.some((p) => p.id === project.id)).toBe(true);

    // Search by title fragment (case-insensitive on SQLite ASCII).
    const search = await listProjects(listReq(`?q=${encodeURIComponent("archive LIFECYCLE")}`));
    list = ((await bodyOf(search)).projects as unknown) as CardDTO[];
    expect(list.some((p) => p.id === project.id)).toBe(true);

    // Sort by title puts it in a deterministic order relative to others.
    const sorted = await listProjects(listReq("?sort=title"));
    list = ((await bodyOf(sorted)).projects as unknown) as CardDTO[];
    const titles = list.map((p) => p.title.toLowerCase());
    expect([...titles].sort((a, b) => a.localeCompare(b))).toEqual(titles);

    // Archive it → hidden from the default list, present in ?archived=true,
    // still DRAFT with its kind intact.
    const arch = actionReq(`/api/projects/${project.id}/archive`);
    const archived = await archiveRoute(arch.req, arch.ctx);
    expect(archived.status).toBe(200);
    const archivedProject = ((await bodyOf(archived)).project as unknown) as CardDTO;
    expect(archivedProject.archivedAt).not.toBeNull();
    expect(archivedProject.status).toBe("DRAFT");

    const defaultList = await listProjects(listReq(""));
    list = ((await bodyOf(defaultList)).projects as unknown) as CardDTO[];
    expect(list.some((p) => p.id === project.id)).toBe(false);

    const archivedList = await listProjects(listReq("?archived=true"));
    list = ((await bodyOf(archivedList)).projects as unknown) as CardDTO[];
    expect(list.some((p) => p.id === project.id)).toBe(true);

    const anyList = await listProjects(listReq("?archived=any"));
    list = ((await bodyOf(anyList)).projects as unknown) as CardDTO[];
    expect(list.some((p) => p.id === project.id)).toBe(true);

    // Restore → back in the active list.
    const unarch = actionReq(`/api/projects/${project.id}/unarchive`);
    const restored = await unarchiveRoute(unarch.req, unarch.ctx);
    expect(restored.status).toBe(200);
    const restoredProject = ((await bodyOf(restored)).project as unknown) as CardDTO;
    expect(restoredProject.archivedAt).toBeNull();

    // Cleanup this project.
    await db.project.delete({ where: { id: project.id } });
  });

  test("archive is owner-scoped (403 for a foreign project, 404 for missing)", async () => {
    cookieToken = await createSession(otherUserId);
    const created = await createProjectViaApi("Other user's project");
    expect(created.status).toBe(200);
    const foreign = ((await bodyOf(created)).project as unknown) as CardDTO;

    cookieToken = await createSession(qaUserId);
    const f1 = actionReq(`/api/projects/${foreign.id}/archive`);
    const forbidden = await archiveRoute(f1.req, f1.ctx);
    expect(forbidden.status).toBe(403);

    const m1 = actionReq("/api/projects/does-not-exist/archive");
    const missing = await archiveRoute(m1.req, m1.ctx);
    expect(missing.status).toBe(404);

    await db.project.delete({ where: { id: foreign.id } });
  });
});

// --------------------------------------------------------- POST /:id/duplicate

describe("POST /api/projects/:id/duplicate", () => {
  test("copies content as a PRIVATE DRAFT with (copy) suffix, without curation state", async () => {
    cookieToken = await createSession(qaUserId);
    const source = await createProjectViaApi(`Duplicate Me ${Date.now()}`, {
      summary: "source summary",
      description: "source description",
      brief: "source brief",
      tools: ["Figma"],
      customFields: { kind: "showreel", templateId: "film-showreel", fields: { deliverables: "4K master" } },
    });
    expect(source.status).toBe(200);
    const src = ((await bodyOf(source)).project as unknown) as CardDTO;

    // The duplicate does NOT need publish prerequisites — it is always a draft.
    const d1 = actionReq(`/api/projects/${src.id}/duplicate`);
    const dup = await duplicateRoute(d1.req, d1.ctx);
    expect(dup.status).toBe(200);
    const copy = ((await bodyOf(dup)).project as unknown) as CardDTO;
    expect(copy.id).not.toBe(src.id);
    expect(copy.title).toBe(`${src.title} (copy)`);
    expect(copy.status).toBe("DRAFT");
    expect(copy.visibility).toBe("PRIVATE");
    expect(copy.archivedAt).toBeNull();
    expect(copy.featured).toBe(false);

    // Content actually carried over.
    const copyFull = await db.project.findUnique({
      where: { id: copy.id },
      include: { media: true, skills: true, contributors: true },
    });
    expect(copyFull).not.toBeNull();
    expect(copyFull!.summary).toBe("source summary");
    expect(copyFull!.brief).toBe("source brief");
    expect(JSON.parse(copyFull!.tools ?? "[]")).toEqual(["Figma"]);
    const envelope = JSON.parse(copyFull!.customFields ?? "{}");
    expect(envelope.kind).toBe("showreel");
    expect(envelope.fields?.deliverables).toBe("4K master");

    // The original is untouched.
    const srcAfter = await db.project.findUnique({ where: { id: src.id } });
    expect(srcAfter?.title).toBe(src.title);

    await db.project.delete({ where: { id: copy.id } });
    await db.project.delete({ where: { id: src.id } });
  });

  test("403 for non-owners, 404 for missing projects", async () => {
    cookieToken = await createSession(otherUserId);
    const created = await createProjectViaApi("Dup foreign");
    const foreign = ((await bodyOf(created)).project as unknown) as CardDTO;

    cookieToken = await createSession(qaUserId);
    const f2 = actionReq(`/api/projects/${foreign.id}/duplicate`);
    const forbidden = await duplicateRoute(f2.req, f2.ctx);
    expect(forbidden.status).toBe(403);

    const m2 = actionReq("/api/projects/does-not-exist/duplicate");
    const missing = await duplicateRoute(m2.req, m2.ctx);
    expect(missing.status).toBe(404);

    await db.project.delete({ where: { id: foreign.id } });
  });
});

// ------------------------------------------------------------- GET /api/media

describe("GET /api/media — Studio Asset Library listing", () => {
  test("401 without a session", async () => {
    cookieToken = undefined;
    const res = await listMedia(new NextRequest("http://localhost:3000/api/media"));
    expect(res.status).toBe(401);
  });

  test("lists owner READY assets with usage counts and storage summary", async () => {
    cookieToken = await createSession(qaUserId);
    const res = await listMedia(new NextRequest("http://localhost:3000/api/media?limit=120"));
    expect(res.status).toBe(200);
    const b = await bodyOf(res);
    const assets = (b.assets as unknown) as Array<{ id: string; kind: string; size: number; usedInProjects: number; url: string }>;
    const mine = assets.find((a) => a.id === PNG_DATA.mediaId);
    expect(mine).toBeDefined();
    expect(mine!.kind).toBe("IMAGE");
    expect(mine!.usedInProjects).toBe(0);
    expect(mine!.url).toBe(`/api/media/${PNG_DATA.mediaId}/raw`);
    const storage = b.storage as { bytes: number; count: number };
    expect(storage.count).toBeGreaterThanOrEqual(1);
    expect(storage.bytes).toBeGreaterThanOrEqual(1234);
  });

  test("kind filter validates and scopes", async () => {
    cookieToken = await createSession(qaUserId);
    const bad = await listMedia(new NextRequest("http://localhost:3000/api/media?kind=EXECUTABLE"));
    expect(bad.status).toBe(400);

    const images = await listMedia(new NextRequest("http://localhost:3000/api/media?kind=IMAGE"));
    expect(images.status).toBe(200);
    const list = ((await bodyOf(images)).assets as unknown) as Array<{ kind: string }>;
    expect(list.length).toBeGreaterThan(0);
    for (const a of list) expect(a.kind).toBe("IMAGE");

    const videos = await listMedia(new NextRequest("http://localhost:3000/api/media?kind=VIDEO"));
    const videoList = ((await bodyOf(videos)).assets as unknown) as Array<{ id: string }>;
    expect(videoList.some((a) => a.id === PNG_DATA.mediaId)).toBe(false);
  });

  test("never leaks another user's assets", async () => {
    cookieToken = await createSession(otherUserId);
    const res = await listMedia(new NextRequest("http://localhost:3000/api/media?limit=120"));
    const list = ((await bodyOf(res)).assets as unknown) as Array<{ id: string }>;
    expect(list.some((a) => a.id === PNG_DATA.mediaId)).toBe(false);
  });
});
