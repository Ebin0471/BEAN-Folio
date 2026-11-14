/**
 * GIFTZ motion compiler sync tests (M15 §13 "Project file synchronization" +
 * "Compiler preservation").
 *
 * Runs the REAL syncGeneratedFiles (sync rule S1) against an in-memory db
 * fake (same pattern as tests/giftz-project-platform.test.ts) and asserts:
 *   - a motion-enabled config emits vendor rows + the generated runtime,
 *   - "user"/"ai" animation files are never overwritten (provenance kept),
 *   - stale generated rows disappear when the engine is disabled,
 *   - three.min.js passes through the vendor per-file cap allowance,
 *   - the post-sync version snapshot + activity row are recorded.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { agencyMotionFixture } from "./helpers/giftz-motion-fixtures";
import { PROJECT_FILE_LIMITS } from "@/lib/giftz/project-files";
import { MOTION_RUNTIME_PATH } from "@/lib/giftz/motion-engine";
import type { GiftzProjectFile } from "@prisma/client";
import type { syncGeneratedFiles as syncGeneratedFilesFn } from "@/lib/giftz/project-compiler";

const SITE_ID = "site-motion-sync";
const USER_ID = "user-motion-sync";

interface FakeProjectFileRow {
  id: string;
  siteId: string;
  path: string;
  content: string;
  encoding: string;
  source: string;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
}

function row(path: string, content: string, source: string, encoding = "utf8"): FakeProjectFileRow {
  return {
    id: `pf-${path.replace(/[^a-z0-9]/gi, "-")}`,
    siteId: SITE_ID,
    path,
    content,
    encoding,
    source,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createFakeDb() {
  let fileRows: FakeProjectFileRow[] = [];
  const upserts: { path: string; source: string; encoding: string }[] = [];
  const deletes: string[] = [];
  const deleteManyCalls: string[] = [];
  const siteUpdates: Record<string, unknown>[] = [];
  const activityCreates: Record<string, unknown>[] = [];
  const versionCreates: Record<string, unknown>[] = [];

  const db = {
    giftzProjectFile: {
      count: async () => fileRows.length,
      findMany: async () => fileRows.map((r) => ({ ...r })),
      findUnique: async (args: { where: { siteId_path: { siteId: string; path: string } } }) => {
        const { siteId, path } = args.where.siteId_path;
        const found = fileRows.find((r) => r.siteId === siteId && r.path === path);
        return found ? { ...found } : null;
      },
      upsert: async ({ where, create }: { where: { siteId_path: { siteId: string; path: string } }; create: Record<string, unknown> }) => {
        const { siteId, path } = where.siteId_path;
        const existing = fileRows.find((r) => r.siteId === siteId && r.path === path);
        const next = existing
          ? { ...existing, ...(create as Partial<FakeProjectFileRow>), updatedAt: new Date() }
          : ({ ...(create as Record<string, unknown>), id: `pf-${fileRows.length + 1}`, createdAt: new Date(), updatedAt: new Date() } as FakeProjectFileRow);
        if (existing) Object.assign(existing, next);
        else fileRows.push(next);
        upserts.push({ path, source: String(create.source ?? ""), encoding: String(create.encoding ?? "utf8") });
        return { ...next };
      },
      delete: async ({ where }: { where: { siteId_path: { siteId: string; path: string } } }) => {
        deletes.push(where.siteId_path.path);
        fileRows = fileRows.filter((r) => !(r.siteId === where.siteId_path.siteId && r.path === where.siteId_path.path));
        return {};
      },
      deleteMany: async ({ where }: { where: { siteId: string; path?: string } }) => {
        const before = fileRows.length;
        fileRows = fileRows.filter((r) => {
          if (r.siteId !== where.siteId) return true;
          if (where.path !== undefined && r.path === where.path) return false;
          return where.path === undefined ? false : true;
        });
        if (where.path !== undefined) deleteManyCalls.push(where.path);
        return { count: before - fileRows.length };
      },
    },
    giftzSite: {
      findUnique: async () => ({
        id: SITE_ID,
        userId: USER_ID,
        config: JSON.stringify(siteConfig()),
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        siteUpdates.push({ ...data });
        return {};
      },
    },
    giftzActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activityCreates.push({ ...data });
        return { id: `activity-${activityCreates.length + 1}`, ...data };
      },
    },
    giftzProjectVersion: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        versionCreates.push({ ...data });
        return { id: `version-${versionCreates.length + 1}`, ...data };
      },
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({
        name: "Fixture Creator",
        username: "fixture",
        headline: "Test profile",
        location: null,
        bio: "Fixture bio.",
        availability: null,
        coverPositionY: 50,
        contactEmail: null,
        websiteUrl: null,
        avatarMediaId: null,
        coverMediaId: null,
        _count: { followsReceived: 3, followsGiven: 5 },
        skills: [],
      }),
    },
    project: {
      count: async () => 0,
      findMany: async () => [],
    },
    collection: {
      findMany: async () => [],
    },
    mediaAsset: {
      findUnique: async () => null,
    },
  };
  return {
    db,
    reset(files: FakeProjectFileRow[]) {
      fileRows = files;
      upserts.length = 0;
      deletes.length = 0;
      deleteManyCalls.length = 0;
      siteUpdates.length = 0;
      activityCreates.length = 0;
      versionCreates.length = 0;
    },
    upserts,
    deletes,
    deleteManyCalls,
    siteUpdates,
    activityCreates,
    versionCreates,
    rows: () => fileRows.map((r) => ({ ...r })),
  };
}

function siteConfig() {
  return agencyMotionFixture();
}

const fakeDb = createFakeDb();
mock.module("@/lib/db", () => ({ db: fakeDb.db }));

/** Loaded lazily AFTER mock.module so the real db module never loads. */
let syncGeneratedFiles: typeof syncGeneratedFilesFn;
beforeAll(async () => {
  ({ syncGeneratedFiles } = await import("@/lib/giftz/project-compiler"));
});

describe("compiler sync (S1) with the motion engine", () => {
  beforeAll(() => {
    // Deterministic db fake — no real database involved.
  });

  test("a motion-enabled config emits vendor rows + runtime and preserves user/ai files", async () => {
    fakeDb.reset([
      row("assets/custom-motion.js", "// user-authored animation\ngsap.to('.x', { opacity: 1, duration: 1 });", "user"),
      row("assets/ai-motion.js", "// ai-authored helper\ngsap.set('.y', { opacity: 1 });", "ai"),
    ]);
    const result = await syncGeneratedFiles(USER_ID, SITE_ID);
    expect(result.ok).toBe(true);
    const paths = fakeDb.rows().map((r) => r.path);
    expect(paths).toContain(MOTION_RUNTIME_PATH);
    expect(paths).toContain("assets/vendor/gsap.min.js");
    expect(paths).toContain("assets/vendor/SplitText.min.js");
    expect(paths).toContain("assets/vendor/ScrollTrigger.min.js");
    expect(paths).toContain("site.config.json");
    expect(paths).toContain("assets/custom-motion.js");
    expect(paths).toContain("assets/ai-motion.js");
    // Provenance preserved: the user/ai rows were never upserted.
    const upserted = new Set(fakeDb.upserts.map((u) => u.path));
    expect(upserted.has("assets/custom-motion.js")).toBe(false);
    expect(upserted.has("assets/ai-motion.js")).toBe(false);
    const userRow = fakeDb.rows().find((r) => r.path === "assets/custom-motion.js") as GiftzProjectFile;
    expect(userRow.source).toBe("user");
    // The generated runtime carries the program JSON (one animated site).
    const runtime = fakeDb.rows().find((r) => r.path === MOTION_RUNTIME_PATH);
    expect(runtime?.content).toContain("prefers-reduced-motion");
    expect(fakeDb.versionCreates.length).toBe(1);
    expect(fakeDb.activityCreates[0]).toMatchObject({ kind: "file.write" });
  });

  test("three.min.js passes the vendor per-file cap allowance (616KB > 256KB)", async () => {
    const fixture = agencyMotionFixture();
    // Give the site a Vanta background so three.js must be bundled.
    const config = { ...fixture, backgroundEffects: { enabled: true, engine: "vanta", effect: "FOG", target: { kind: "hero" }, settings: { speed: 1 }, responsive: { mobile: "reduced" }, accessibility: { respectReducedMotion: true }, fallback: { kind: "color", value: "#101014" } } };
    const originalFindUnique = fakeDb.db.giftzSite.findUnique;
    (fakeDb.db.giftzSite as { findUnique: unknown }).findUnique = async () => ({
      id: SITE_ID,
      userId: USER_ID,
      config: JSON.stringify(config),
    });
    fakeDb.reset([]);
    try {
      const result = await syncGeneratedFiles(USER_ID, SITE_ID);
      expect(result.ok).toBe(true);
      const three = fakeDb.rows().find((r) => r.path === "assets/vendor/three.min.js");
      expect(three).toBeDefined();
      expect(three!.sizeBytes).toBeGreaterThan(PROJECT_FILE_LIMITS.maxTextBytes);
      expect(three!.sizeBytes).toBeLessThanOrEqual(PROJECT_FILE_LIMITS.maxVendorTextBytes);
      const fog = fakeDb.rows().find((r) => r.path === "assets/vendor/vanta.fog.min.js");
      expect(fog).toBeDefined();
      // The generated HTML references the vendor scripts.
      const html = fakeDb.rows().find((r) => r.path === "index.html");
      expect(html?.content).toContain("assets/vendor/three.min.js");
    } finally {
      (fakeDb.db.giftzSite as { findUnique: unknown }).findUnique = originalFindUnique;
    }
  });

  test("disabling the engine removes the stale generated vendor rows but keeps user files", async () => {
    const base = agencyMotionFixture();
    const disabled: typeof base = {
      ...base,
      motion: { ...base.motion, gsap: { ...base.motion.gsap!, enabled: false, animations: [] } },
    };
    (fakeDb.db.giftzSite as { findUnique: unknown }).findUnique = async () => ({
      id: SITE_ID,
      userId: USER_ID,
      config: JSON.stringify(disabled),
    });
    fakeDb.reset([
      row(MOTION_RUNTIME_PATH, "/* stale generated runtime */", "generated"),
      row("assets/vendor/gsap.min.js", "/* stale vendor */", "generated"),
      row("assets/custom-motion.js", "// still mine", "user"),
    ]);
    const result = await syncGeneratedFiles(USER_ID, SITE_ID);
    expect(result.ok).toBe(true);
    const paths = fakeDb.rows().map((r) => r.path);
    expect(paths).not.toContain(MOTION_RUNTIME_PATH);
    expect(paths).not.toContain("assets/vendor/gsap.min.js");
    expect(paths).toContain("assets/custom-motion.js");
    expect(fakeDb.deleteManyCalls).toContain("assets/vendor/gsap.min.js");
  });
});
