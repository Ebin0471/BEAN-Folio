/// <reference types="bun-types" />
/**
 * GIFTZ standalone project platform — unit tests (task G-4).
 *
 * Covers the new src/lib/giftz/ platform modules at UNIT level, following the
 * repo's established conventions (see tests/giftz-api.test.ts for the
 * mock.module + restore pattern and tests/riishe-chat-reliability.test.ts for
 * the @/lib/ai mock seam):
 *
 *   project-files.ts    — path confinement, per-file/per-project caps, MIME
 *                         detection (pure, no DB).
 *   project-build.ts    — the exported pure check helpers
 *                         (balancedDelimiterError, stripCommentsAndStrings,
 *                         resolveLocalRef) plus runProjectBuild end-to-end
 *                         against a MINIMAL in-memory db fake (no pre-existing
 *                         db-mock pattern existed in this repo; the fake below
 *                         implements only the methods the tested paths call).
 *   project-versions.ts — the exported pure diff (unifiedPatch), version
 *                         payload parsing and summary serialization. The
 *                         prune/restore/snapshot DB flows are NOT covered
 *                         (no clean db-mock pattern existed for them; noted
 *                         in the task report).
 *   project-agent.ts    — classifyProjectRequest routing with a scripted
 *                         @/lib/ai seam: files / config / throw → honest
 *                         config default. validatePlanOutput is NOT exported
 *                         from the module, so it cannot be reached without
 *                         modifying src/ (skipped — noted in the report).
 *   preview-serve.ts    — CSP constant, honest 404s, serving with the
 *                         proposal overlay (via the same db fake).
 *
 * No real AI calls, no real DB queries, no filesystem access.
 * Run: bun test tests/giftz-project-platform.test.ts
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { ownerDispatchRecord } from "./helpers/owner-dispatch-mock";
import type { GiftzBuild, GiftzProjectVersion, GiftzSite } from "@prisma/client";
import type { BuildDiagnostics } from "@/lib/giftz/project-build";
import { defaultConfig, normalizeConfig, type SiteConfig } from "@/lib/site-config";

// ------------------------------------------------------------------ mocks
// bun module mocks persist for the whole test process: the FIRST import of
// a mocked module while a mock is registered freezes the factory result
// into the module record for every later importer, and no afterAll
// re-registration can reliably undo that. So each mocked record's frozen
// value is a DISPATCH PROXY around the REAL module: while this file's tests
// run (owner flag) calls route to the in-memory fakes; every other file in
// the process — regardless of load order — gets the real PrismaClient and
// the real AI gateway.
declare global {
  var __giftzProjectPlatformOwnsMocks: boolean | undefined;
}
const realDbModule = await import("@/lib/db");
const realAiModule = await import("@/lib/ai");

const SITE_ID = "site-g4-unit";
const USER_ID = "user-g4-unit";

interface FakeProjectFileRow {
  siteId: string;
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  source: string;
  sizeBytes: number;
  updatedAt: Date;
}

interface FakeBuildRow {
  id: string;
  [key: string]: unknown;
}

/**
 * Minimal in-memory Prisma fake. ONLY the methods exercised by
 * runProjectBuild / classifyProjectRequest / readProjectFile exist —
 * anything else fails loudly instead of pretending to work.
 */
function createFakeDb() {
  let fileRows: FakeProjectFileRow[] = [];
  let deploymentCount = 0;
  let failFindMany = false;
  const buildRows: FakeBuildRow[] = [];
  const siteUpdates: Record<string, unknown>[] = [];
  const activityCreates: Record<string, unknown>[] = [];
  let buildSeq = 0;
  let activitySeq = 0;

  const db = {
    giftzProjectFile: {
      // Task G-4 spec: a non-zero count keeps the request router reachable
      // (empty sites skip the classifier in site-studio/turn.ts, NOT here).
      count: async () => 5,
      findMany: async (_args?: unknown) => {
        if (failFindMany) throw new Error("synthetic db failure");
        return fileRows.filter((r) => r.siteId === SITE_ID).map((r) => ({ ...r }));
      },
      findUnique: async (args: { where: { siteId_path: { siteId: string; path: string } } }) => {
        const { siteId, path } = args.where.siteId_path;
        const row = fileRows.find((r) => r.siteId === siteId && r.path === path);
        return row ? { ...row } : null;
      },
    },
    giftzBuild: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: FakeBuildRow = {
          id: `build-${++buildSeq}`,
          finishedAt: null,
          diagnosticsJson: null,
          artifactJson: null,
          ...data,
        };
        buildRows.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = buildRows.find((r) => r.id === where.id);
        if (!row) throw new Error(`fake db: unknown build row ${where.id}`);
        Object.assign(row, data);
        return { ...row };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = buildRows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      },
    },
    giftzSite: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        siteUpdates.push({ ...data });
        return {};
      },
    },
    giftzDeployment: {
      count: async () => deploymentCount,
    },
    giftzActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activityCreates.push({ ...data });
        return { id: `activity-${++activitySeq}`, ...data };
      },
    },
  };

  return {
    db,
    reset(opts: { files?: FakeProjectFileRow[]; deploymentCount?: number; failFindMany?: boolean } = {}) {
      fileRows = opts.files ?? [];
      deploymentCount = opts.deploymentCount ?? 0;
      failFindMany = opts.failFindMany ?? false;
      buildRows.length = 0;
      siteUpdates.length = 0;
      activityCreates.length = 0;
      buildSeq = 0;
      activitySeq = 0;
    },
    buildRows,
    siteUpdates,
    activityCreates,
  };
}

const fakeDb = createFakeDb();
const dispatchDb = new Proxy(realDbModule.db, {
  get(target, prop) {
    if (globalThis.__giftzProjectPlatformOwnsMocks) {
      return (fakeDb.db as Record<string | symbol, unknown>)[prop];
    }
    // Read from the CAPTURED target — the namespace property is patched in
    // place by mock.module; re-reading it would recurse into this proxy.
    return Reflect.get(target, prop);
  },
});
mock.module("@/lib/db", () => ({ db: dispatchDb }));

// @/lib/ai is mocked wholesale (same pattern as
// tests/riishe-chat-reliability.test.ts): unit tests must not load the real
// gateway (z-ai-web-dev-sdk). parseJsonFromText mirrors the REAL
// implementation in src/lib/ai.ts so the tests exercise the modules' own
// routing/validation logic, not a more forgiving parser.
type AiMessage = { role: string; content: string };
type AiCompleteFn = (
  system: string,
  messages: AiMessage[],
  opts?: Record<string, unknown>
) => Promise<{ text: string }>;

const aiState: { complete: AiCompleteFn | null } = { complete: null };

const aiFake = {
  AiProviderError: class MockAiProviderError extends Error {},
  AI_DAILY_LIMIT: 30,
  AI_BURST_LIMIT: 6,
  AI_DEEP_TIMEOUT_MS: 120_000,
  AI_FEATURES: [],
  aiCapabilities: () => ({
    available: true,
    provider: "BEAN Intelligence gateway",
    features: [],
    dailyLimit: 30,
    consentRequired: false,
  }),
  aiGate: async () => null,
  recordAiUsage: async () => undefined,
  aiComplete: async (system: string, messages: AiMessage[], opts?: Record<string, unknown>) => {
    if (!aiState.complete) throw new Error("no aiComplete mock configured");
    return aiState.complete(system, messages, opts);
  },
  parseJsonFromText: <T,>(text: string): T | null => {
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  },
};
const dispatchAi = ownerDispatchRecord(
  () => globalThis.__giftzProjectPlatformOwnsMocks === true,
  realAiModule,
  aiFake
);
mock.module("@/lib/ai", () => dispatchAi);

beforeAll(() => {
  globalThis.__giftzProjectPlatformOwnsMocks = true;
});

afterAll(() => {
  globalThis.__giftzProjectPlatformOwnsMocks = false;
  aiState.complete = null;
});

// Modules under test — imported AFTER the mocks are armed.
const {
  PROJECT_FILE_LIMITS,
  ProjectFileError,
  constrainProjectPath,
  assertProjectLimits,
  projectContentSizeBytes,
  mimeForPath,
  isBinaryPath,
} = await import("@/lib/giftz/project-files");

const {
  balancedDelimiterError,
  stripCommentsAndStrings,
  resolveLocalRef,
  runProjectBuild,
  parseBuildDiagnostics,
  serializeBuild,
} = await import("@/lib/giftz/project-build");

const {
  VERSION_LIMITS,
  unifiedPatch,
  parseVersionPayload,
  toVersionSummary,
  toVersionDetail,
} = await import("@/lib/giftz/project-versions");

const { classifyProjectRequest } = await import("@/lib/giftz/project-agent");
const { PREVIEW_CSP, previewNotFound, servePreviewFile } = await import("@/lib/giftz/preview-serve");

// ------------------------------------------------------------------ fixtures

const normalizedConfig = normalizeConfig(defaultConfig("atelier"));
if (!normalizedConfig) throw new Error("atelier default failed to normalize");
const siteConfig: SiteConfig = normalizedConfig;

function siteFixture(config: string | null, deployStatus = "DRAFT"): GiftzSite {
  return {
    id: SITE_ID,
    userId: USER_ID,
    title: "G4 Test Site",
    framework: "standard-static",
    deployStatus,
    config,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as GiftzSite;
}

function row(
  path: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
  source = "generated"
): FakeProjectFileRow {
  return {
    siteId: SITE_ID,
    path,
    content,
    encoding,
    source,
    sizeBytes: projectContentSizeBytes(content, encoding),
    updatedAt: new Date(),
  };
}

const HEALTHY_INDEX_HTML = [
  "<!doctype html>",
  "<html>",
  "<head>",
  '<link rel="stylesheet" href="assets/styles.css">',
  '<script src="assets/app.js" defer></script>',
  "</head>",
  "<body><h1>G4</h1></body>",
  "</html>",
].join("\n");

function healthyFiles(): FakeProjectFileRow[] {
  return [
    row("index.html", HEALTHY_INDEX_HTML),
    row("assets/styles.css", "body { margin: 0; color: #1a1a1a; }\n"),
    row("assets/app.js", 'const greeting = "hello";\nconsole.log(greeting);\n'),
    row("manifest.json", JSON.stringify({ name: "g4", short_name: "g4" })),
    row("site.config.json", JSON.stringify(siteConfig, null, 2)),
  ];
}

/** Unwraps a thrown ProjectFileError for structured status/code assertions. */
function projectError(fn: () => unknown): { status: number; code: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProjectFileError) return { status: e.status, code: e.code, message: e.message };
    throw new Error(`expected ProjectFileError, got: ${String(e)}`);
  }
  throw new Error("expected the call to throw ProjectFileError");
}

function errorsOf(diag: BuildDiagnostics | null) {
  return diag?.checks.filter((c) => c.severity === "error") ?? [];
}

function warningsOf(diag: BuildDiagnostics | null) {
  return diag?.checks.filter((c) => c.severity === "warning") ?? [];
}

// ================================================================ 1. paths

describe("constrainProjectPath — project path confinement", () => {
  test("accepts normal relative paths, normalizes duplicate and trailing slashes, preserves case", () => {
    expect(constrainProjectPath("index.html")).toBe("index.html");
    expect(constrainProjectPath("assets//styles.css")).toBe("assets/styles.css");
    expect(constrainProjectPath("a///b///c.txt")).toBe("a/b/c.txt");
    expect(constrainProjectPath("assets/js/")).toBe("assets/js");
    expect(constrainProjectPath("Assets/Styles.CSS")).toBe("Assets/Styles.CSS");
    expect(constrainProjectPath("l1/l2/l3/l4/l5/l6/l7/l8.txt")).toBe(
      "l1/l2/l3/l4/l5/l6/l7/l8.txt"
    );
  });

  test("accepts paths at the exact length boundary (200 chars)", () => {
    expect(constrainProjectPath("a".repeat(PROJECT_FILE_LIMITS.maxPathLength))).toBe(
      "a".repeat(PROJECT_FILE_LIMITS.maxPathLength)
    );
  });

  test("rejects absolute paths, backslashes, NUL, non-strings and empty paths", () => {
    expect(() => constrainProjectPath("/index.html")).toThrow("must be relative");
    expect(() => constrainProjectPath("assets\\styles.css")).toThrow("must use '/' separators");
    expect(() => constrainProjectPath("a\0b")).toThrow("invalid character");
    expect(() => constrainProjectPath(42)).toThrow("must be a string");
    expect(() => constrainProjectPath(null)).toThrow("must be a string");
    expect(() => constrainProjectPath("")).toThrow("empty");
    // "//" is caught by the leading-slash rule before slash normalization runs.
    expect(() => constrainProjectPath("//")).toThrow("must be relative");
  });

  test("rejects traversal and dot segments", () => {
    expect(() => constrainProjectPath("../secret")).toThrow("must not contain '..'");
    expect(() => constrainProjectPath("a/../b")).toThrow("must not contain '..'");
    expect(() => constrainProjectPath("pages/.hidden.html")).toThrow("must not start with '.'");
    expect(() => constrainProjectPath(".")).toThrow("must not start with '.'");
  });

  test("rejects '.git' segments (via the dot-segment rule) but allows names merely containing '.git'", () => {
    // A '.git' segment always starts with '.', so the dot-segment rule fires
    // first; either way the path is rejected — never stored.
    expect(() => constrainProjectPath(".git/config")).toThrow("must not start with '.'");
    expect(() => constrainProjectPath("x/.git/config")).toThrow("must not start with '.'");
    expect(constrainProjectPath("my.git/HEAD")).toBe("my.git/HEAD");
  });

  test("rejects over-length and over-depth paths with 413 and stable codes", () => {
    const tooLong = projectError(() => constrainProjectPath("a".repeat(PROJECT_FILE_LIMITS.maxPathLength + 1)));
    expect(tooLong.status).toBe(413);
    expect(tooLong.code).toBe("path_too_long");

    const tooDeep = projectError(() =>
      constrainProjectPath("l1/l2/l3/l4/l5/l6/l7/l8/l9.txt")
    );
    expect(tooDeep.status).toBe(413);
    expect(tooDeep.code).toBe("path_too_deep");
  });
});

// ================================================================ 2. limits

describe("assertProjectLimits — per-file and per-project caps", () => {
  test("projectContentSizeBytes counts utf8 bytes and decoded base64 bytes", () => {
    expect(projectContentSizeBytes("héllo", "utf8")).toBe(6); // é is 2 bytes
    expect(projectContentSizeBytes(Buffer.from("hello").toString("base64"), "base64")).toBe(5);
  });

  test("rejects a utf8 file over the 256KB per-file cap (413, file_too_large)", () => {
    const err = projectError(() =>
      assertProjectLimits([], {
        path: "assets/big.js",
        content: "x".repeat(PROJECT_FILE_LIMITS.maxTextBytes + 1),
        encoding: "utf8",
      })
    );
    expect(err.status).toBe(413);
    expect(err.code).toBe("file_too_large");
  });

  test("rejects a base64 file whose decoded size exceeds 4MB (413, file_too_large)", () => {
    const content = Buffer.alloc(PROJECT_FILE_LIMITS.maxBase64Bytes + 1, 1).toString("base64");
    const err = projectError(() =>
      assertProjectLimits([], { path: "img/big.png", content, encoding: "base64" })
    );
    expect(err.status).toBe(413);
    expect(err.code).toBe("file_too_large");
  });

  test("rejects writes beyond the 300-file cap but allows replacing an existing path", () => {
    const existing = Array.from({ length: PROJECT_FILE_LIMITS.maxFiles }, (_, i) => ({
      path: `f-${i}.txt`,
      sizeBytes: 1,
      encoding: "utf8",
    }));
    const blocked = projectError(() =>
      assertProjectLimits(existing, { path: "new.txt", content: "x", encoding: "utf8" })
    );
    expect(blocked.status).toBe(413);
    expect(blocked.code).toBe("too_many_files");

    // Replacing an existing path does not count as a new file.
    expect(() =>
      assertProjectLimits(existing, { path: "f-0.txt", content: "replaced", encoding: "utf8" })
    ).not.toThrow();
  });

  test("rejects projects that would exceed the 30MB total cap; replacements do not double-count", () => {
    const existing = [
      { path: "a.bin", sizeBytes: PROJECT_FILE_LIMITS.maxTotalBytes - 10, encoding: "base64" },
      { path: "b.txt", sizeBytes: 100, encoding: "utf8" },
    ];
    const blocked = projectError(() =>
      assertProjectLimits(existing, { path: "c.txt", content: "1byte", encoding: "utf8" })
    );
    expect(blocked.status).toBe(413);
    expect(blocked.code).toBe("project_too_large");

    // Replacing b.txt frees its 100 bytes — the same content now fits.
    expect(() =>
      assertProjectLimits(existing, { path: "b.txt", content: "1byte", encoding: "utf8" })
    ).not.toThrow();
  });

  test("rejects unknown encodings with 400 invalid_encoding", () => {
    const err = projectError(() =>
      assertProjectLimits([], { path: "x.txt", content: "hi", encoding: "binary" })
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_encoding");
  });
});

// ================================================================ 3. MIME

describe("mimeForPath / isBinaryPath — content-type detection", () => {
  test("maps known text extensions to text MIME types", () => {
    expect(mimeForPath("index.html")).toBe("text/html");
    expect(mimeForPath("assets/styles.css")).toBe("text/css");
    expect(mimeForPath("assets/app.js")).toBe("text/javascript");
    expect(mimeForPath("assets/modules/x.mjs")).toBe("text/javascript");
    expect(mimeForPath("manifest.json")).toBe("application/json");
    expect(mimeForPath("icons/logo.svg")).toBe("image/svg+xml");
    expect(mimeForPath("docs/README.md")).toBe("text/markdown");
    expect(mimeForPath("assets/site.webmanifest")).toBe("application/manifest+json");
  });

  test("maps known binary extensions to binary MIME types (case-insensitive)", () => {
    expect(mimeForPath("img/photo.png")).toBe("image/png");
    expect(mimeForPath("img/photo.JPG")).toBe("image/jpeg");
    expect(mimeForPath("fonts/font.woff2")).toBe("font/woff2");
    expect(mimeForPath("media/clip.mp4")).toBe("video/mp4");
    expect(mimeForPath("docs/paper.pdf")).toBe("application/pdf");
  });

  test("falls back to octet-stream for unknown or missing extensions", () => {
    expect(mimeForPath("LICENSE")).toBe("application/octet-stream");
    expect(mimeForPath("downloads/file.xyz")).toBe("application/octet-stream");
  });

  test("flags binary assets for the file-agent rule; text and extensionless files are not binary", () => {
    expect(isBinaryPath("img/photo.png")).toBe(true);
    expect(isBinaryPath("img/photo.jpeg")).toBe(true);
    expect(isBinaryPath("fonts/font.woff2")).toBe(true);
    expect(isBinaryPath("docs/paper.pdf")).toBe(true);
    expect(isBinaryPath("index.html")).toBe(false);
    expect(isBinaryPath("icons/logo.svg")).toBe(false); // SVG is text — the agent may write it
    expect(isBinaryPath("assets/app.js")).toBe(false);
    expect(isBinaryPath("Dockerfile")).toBe(false); // no extension → treated as text
    expect(isBinaryPath("downloads/file.xyz")).toBe(false); // unknown ext is not a KNOWN binary type
  });
});

// ================================================================ 4. build scanner

describe("balancedDelimiterError / stripCommentsAndStrings — JS/CSS syntax scan", () => {
  test("passes balanced code whose delimiters live inside strings, comments and template literals", () => {
    expect(
      balancedDelimiterError('const a = "{ not code";\n// } stray in comment\nconst b = [1, 2];\n')
    ).toBeNull();
    expect(balancedDelimiterError("const s = `template { with braces }`;\n")).toBeNull();
    expect(balancedDelimiterError("const s = 'it\\'s ) fine';\n")).toBeNull();
    expect(balancedDelimiterError("function f() { return () => ({ a: 1 }); }\n")).toBeNull();
  });

  test("stripCommentsAndStrings removes string bodies and comments so delimiters count honestly", () => {
    const stripped = stripCommentsAndStrings('const a = "{"; // keep { open');
    expect(stripped).not.toContain("{");
    expect(stripped).toContain('const a = ""');
  });

  test("reports unclosed delimiters with the opening line number", () => {
    const problem = balancedDelimiterError("const a = 1;\nfunction f() {\n  const b = {\n");
    expect(problem).toContain("balanced-delimiter check failed");
    expect(problem).toContain("unclosed '{'");
    expect(problem).toContain("line 3");
  });

  test("reports mismatched closers", () => {
    const problem = balancedDelimiterError("const a = (1}");
    expect(problem).toContain("unexpected '}'");
  });

  test("handles CSS braces with comments", () => {
    expect(balancedDelimiterError(".a { color: red; }\n")).toBeNull();
    expect(balancedDelimiterError(".a { /* stray } inside comment */ }\n")).toBeNull();
    expect(balancedDelimiterError(".a {\n  color: red;\n")).toContain("unclosed '{'");
  });
});

// ================================================================ 4b. link resolution

describe("resolveLocalRef — local HTML reference resolution", () => {
  test("ignores external, data, mailto, tel, protocol-relative and hash-only references", () => {
    expect(resolveLocalRef("https://cdn.example.com/x.js", "index.html")).toBeNull();
    expect(resolveLocalRef("http://example.com/a.png", "index.html")).toBeNull();
    expect(resolveLocalRef("data:image/png;base64,AAAA", "index.html")).toBeNull();
    expect(resolveLocalRef("mailto:hi@example.com", "index.html")).toBeNull();
    expect(resolveLocalRef("tel:+1234567890", "index.html")).toBeNull();
    expect(resolveLocalRef("#top", "index.html")).toBeNull();
    expect(resolveLocalRef("//cdn.example.com/x.js", "index.html")).toBeNull();
  });

  test("strips query strings and hashes before resolution", () => {
    expect(resolveLocalRef("assets/site.js?v=2#top", "index.html")).toBe("assets/site.js");
    expect(resolveLocalRef("assets/styles.css?cachebust=123", "index.html")).toBe(
      "assets/styles.css"
    );
  });

  test("resolves relative references against the referencing file's directory", () => {
    expect(resolveLocalRef("logo.svg", "pages/about.html")).toBe("pages/logo.svg");
    expect(resolveLocalRef("./script.js", "pages/about.html")).toBe("pages/script.js");
    expect(resolveLocalRef("../assets/styles.css", "pages/about.html")).toBe("assets/styles.css");
    expect(resolveLocalRef("assets/app.js", "index.html")).toBe("assets/app.js");
  });

  test("decodes URI components before resolution", () => {
    expect(resolveLocalRef("assets/my%20pic.png", "index.html")).toBe("assets/my pic.png");
  });
});

// ================================================================ 4c. runProjectBuild (db fake)

describe("runProjectBuild — deterministic validation (in-memory db)", () => {
  test("passes a healthy tree, records the artifact, flips deployStatus to PREVIEW and logs activity", async () => {
    fakeDb.reset({ files: healthyFiles(), deploymentCount: 0 });
    const build = await runProjectBuild(siteFixture(JSON.stringify(siteConfig)), "manual");

    expect(build.status).toBe("SUCCEEDED");
    const diag = parseBuildDiagnostics(build);
    expect(errorsOf(diag)).toHaveLength(0);
    expect(warningsOf(diag)).toHaveLength(0);
    expect(diag?.summary).toContain("All checks passed");

    const artifact = JSON.parse(build.artifactJson ?? "{}") as {
      files?: { path: string; mime: string; encoding: string }[];
    };
    expect(artifact.files).toHaveLength(5);
    expect(artifact.files?.find((f) => f.path === "index.html")?.mime).toBe("text/html");
    expect(artifact.files?.find((f) => f.path === "site.config.json")?.mime).toBe(
      "application/json"
    );

    // No deployments yet → a successful manual build moves DRAFT to PREVIEW.
    expect(fakeDb.siteUpdates).toEqual([{ deployStatus: "PREVIEW" }]);

    const activity = fakeDb.activityCreates[0] as { kind?: string; detailJson?: string };
    expect(activity.kind).toBe("build");
    const detail = JSON.parse(activity.detailJson ?? "{}") as { ok?: boolean; trigger?: string };
    expect(detail.ok).toBe(true);
    expect(detail.trigger).toBe("manual");
  });

  test("fails on a missing index.html entry file", async () => {
    fakeDb.reset({
      files: healthyFiles().filter((f) => f.path !== "index.html"),
      deploymentCount: 0,
    });
    const build = await runProjectBuild(siteFixture(null), "manual");

    expect(build.status).toBe("FAILED");
    const diag = parseBuildDiagnostics(build);
    const entry = errorsOf(diag).find((c) => c.path === "index.html");
    expect(entry?.message).toContain("missing entry file");
  });

  test("fails on broken local references in html files", async () => {
    fakeDb.reset({
      files: [
        row("index.html", '<html><body><img src="img/missing.png"></body></html>'),
        row("pages/about.html", '<html><body><a href="../styles.css">css</a></body></html>'),
      ],
    });
    const build = await runProjectBuild(siteFixture(null), "manual");

    expect(build.status).toBe("FAILED");
    const diag = parseBuildDiagnostics(build);
    const broken = errorsOf(diag).filter((c) => c.message.includes("broken local reference"));
    expect(broken).toHaveLength(2);
    expect(broken.some((c) => c.path === "index.html" && c.message.includes("img/missing.png"))).toBe(
      true
    );
    expect(
      broken.some((c) => c.path === "pages/about.html" && c.message.includes("../styles.css"))
    ).toBe(true);
  });

  test("fails on invalid JSON files", async () => {
    fakeDb.reset({
      files: [row("index.html", "<p>ok</p>"), row("data/broken.json", '{ "open": ')],
    });
    const build = await runProjectBuild(siteFixture(null), "manual");

    expect(build.status).toBe("FAILED");
    const diag = parseBuildDiagnostics(build);
    const jsonErrors = errorsOf(diag).filter((c) => c.path === "data/broken.json");
    expect(jsonErrors).toHaveLength(1);
    expect(jsonErrors[0]?.message).toContain("invalid JSON");
    expect(errorsOf(diag)).toHaveLength(1); // nothing else is wrong with this tree
  });

  test("fails on unbalanced delimiters in js/css files", async () => {
    fakeDb.reset({
      files: [
        row("index.html", "<p>ok</p>"),
        row("assets/app.js", "function f() {\n  return 1;\n"),
        row("assets/styles.css", ".a { color: red;"),
      ],
    });
    const build = await runProjectBuild(siteFixture(null), "manual");

    expect(build.status).toBe("FAILED");
    const diag = parseBuildDiagnostics(build);
    const syntax = errorsOf(diag).filter((c) => c.message.includes("balanced-delimiter check failed"));
    expect(syntax).toHaveLength(2);
    expect(syntax.every((c) => c.message.includes("unclosed '{'"))).toBe(true);
  });

  test("warns (but passes) when site.config.json drifts from the saved site config", async () => {
    const drifted = { ...siteConfig, name: "Renamed While Editing Files" };
    fakeDb.reset({
      files: healthyFiles().map((f) =>
        f.path === "site.config.json" ? row("site.config.json", JSON.stringify(drifted, null, 2)) : f
      ),
    });
    const build = await runProjectBuild(siteFixture(JSON.stringify(siteConfig)), "manual");

    expect(build.status).toBe("SUCCEEDED");
    const diag = parseBuildDiagnostics(build);
    expect(errorsOf(diag)).toHaveLength(0);
    const drift = warningsOf(diag).find((c) => c.path === "site.config.json");
    expect(drift?.message).toContain("differs from the saved site configuration");
  });

  test("warns (but passes) on empty binary-extension files", async () => {
    fakeDb.reset({
      files: [row("index.html", "<p>ok</p>"), row("img/placeholder.png", "")],
    });
    const build = await runProjectBuild(siteFixture(null), "manual");

    expect(build.status).toBe("SUCCEEDED");
    const diag = parseBuildDiagnostics(build);
    expect(errorsOf(diag)).toHaveLength(0);
    const warning = warningsOf(diag).find((c) => c.path === "img/placeholder.png");
    expect(warning?.message).toContain("empty binary file");
    expect(diag?.summary).toContain("warning");
  });

  test("applies the proposal overlay: added content fixes the build, removed files hide", async () => {
    const indexOnly = () => [
      row("index.html", '<html><body><script src="assets/app.js"></script></body></html>'),
    ];

    fakeDb.reset({ files: indexOnly() });
    const broken = await runProjectBuild(siteFixture(null), "manual");
    expect(broken.status).toBe("FAILED");

    // Overlay ADDS the missing script → the same tree now builds.
    fakeDb.reset({ files: indexOnly() });
    const fixed = await runProjectBuild(
      siteFixture(null),
      "ai",
      new Map([["assets/app.js", 'console.log("fixed");\n']])
    );
    expect(fixed.status).toBe("SUCCEEDED");
    const artifact = JSON.parse(fixed.artifactJson ?? "{}") as { files?: { path: string }[] };
    expect(artifact.files?.some((f) => f.path === "assets/app.js")).toBe(true);

    // Overlay REMOVES index.html → the entry check fires honestly.
    fakeDb.reset({ files: indexOnly() });
    const removed = await runProjectBuild(siteFixture(null), "ai", new Map([["index.html", null]]));
    expect(removed.status).toBe("FAILED");
    const diag = parseBuildDiagnostics(removed);
    expect(errorsOf(diag).some((c) => c.message.includes("missing entry file"))).toBe(true);
  });

  test("reports an honest FAILED build when the db read crashes", async () => {
    fakeDb.reset({ files: healthyFiles(), failFindMany: true });
    const build = await runProjectBuild(siteFixture(null), "manual");

    expect(build.status).toBe("FAILED");
    const diag = parseBuildDiagnostics(build);
    const crash = errorsOf(diag).find((c) => c.path === "(build)");
    expect(crash?.message).toContain("build crashed");
    expect(crash?.message).toContain("synthetic db failure");
    expect(diag?.summary).toContain("the build process itself errored");
  });
});

// ================================================================ 4d. build serialization

describe("build diagnostics serialization — parseBuildDiagnostics / serializeBuild", () => {
  test("parses valid diagnostics and rejects garbage defensively", () => {
    const ok = parseBuildDiagnostics({
      diagnosticsJson: JSON.stringify({
        checks: [{ path: "assets/app.js", severity: "error", message: "unclosed '{' at line 1" }],
        summary: "Build failed — 1 error(s)",
        checksRun: 7,
        durationMs: 9,
      }),
    });
    expect(ok?.checks).toHaveLength(1);
    expect(ok?.checks[0]?.severity).toBe("error");

    expect(parseBuildDiagnostics({ diagnosticsJson: "not json" })).toBeNull();
    expect(parseBuildDiagnostics({ diagnosticsJson: null })).toBeNull();
    expect(parseBuildDiagnostics({ diagnosticsJson: JSON.stringify({ checks: "nope" }) })).toBeNull();
  });

  test("serializes a build row for API responses", () => {
    const buildRow = {
      id: "b1",
      siteId: SITE_ID,
      status: "SUCCEEDED",
      trigger: "manual",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:01.000Z"),
      finishedAt: new Date("2026-01-01T00:00:02.000Z"),
      diagnosticsJson: JSON.stringify({
        checks: [{ path: "img/placeholder.png", severity: "warning", message: "empty binary file" }],
        summary: "Build passed with 1 warning(s) (7 checks)",
        checksRun: 7,
        durationMs: 12,
      }),
      artifactJson: JSON.stringify({
        files: [{ path: "index.html" }, { path: "assets/app.js" }, { path: "assets/styles.css" }],
      }),
    } as unknown as GiftzBuild;

    const serialized = serializeBuild(buildRow);
    expect(serialized.id).toBe("b1");
    expect(serialized.status).toBe("SUCCEEDED");
    expect(serialized.trigger).toBe("manual");
    expect(serialized.summary).toContain("1 warning");
    expect(serialized.checksRun).toBe(7);
    expect(serialized.durationMs).toBe(12);
    expect(serialized.diagnostics?.[0]?.path).toBe("img/placeholder.png");
    expect(serialized.artifactFileCount).toBe(3);
    expect(serialized.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(serialized.createdAt).toBe("2026-01-01T00:00:01.000Z");
    expect(serialized.finishedAt).toBe("2026-01-01T00:00:02.000Z");
  });
});

// ================================================================ 5. versions / diff

describe("unifiedPatch — LCS line diff", () => {
  test("returns null for identical or empty inputs", () => {
    expect(unifiedPatch(["a", "b"], ["a", "b"], VERSION_LIMITS.maxPatchLines)).toBeNull();
    expect(unifiedPatch([], [], VERSION_LIMITS.maxPatchLines)).toBeNull();
  });

  test("emits an addition hunk with unified headers and + lines", () => {
    const patch = unifiedPatch(["a", "b"], ["a", "b", "c"], VERSION_LIMITS.maxPatchLines);
    expect(patch).toBe("@@ -1,2 +1,3 @@\n a\n b\n+c");
  });

  test("emits a removal hunk with - lines", () => {
    const patch = unifiedPatch(["a", "b", "c"], ["a", "c"], VERSION_LIMITS.maxPatchLines);
    expect(patch).toBe("@@ -1,3 +1,2 @@\n a\n-b\n c");
  });

  test("shows a modification as paired -/+ lines with correct hunk counts", () => {
    const patch = unifiedPatch(
      ["x", "old", "y"],
      ["x", "new", "y"],
      VERSION_LIMITS.maxPatchLines
    );
    expect(patch).toContain("@@ -1,3 +1,3 @@");
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
    expect(patch).toContain(" x\n");
    expect(patch).toContain(" y");
  });

  test("handles empty→content as a pure addition", () => {
    const patch = unifiedPatch([], ["a"], VERSION_LIMITS.maxPatchLines);
    expect(patch).toBe("@@ -1,0 +1,1 @@\n+a");
  });

  test("splits distant changes into separate hunks", () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const newLines = ["A0", ...oldLines.slice(1, 29), "A29"];
    const patch = unifiedPatch(oldLines, newLines, VERSION_LIMITS.maxPatchLines) ?? "";
    const headers = patch.split("\n").filter((l) => l.startsWith("@@"));
    expect(headers).toHaveLength(2);
    expect(patch).toContain("+A0");
    expect(patch).toContain("-l0");
    expect(patch).toContain("-l29");
    expect(patch).toContain("+A29");
    // 3 context lines around each change → 4-line hunk windows.
    expect(headers[1]).toBe("@@ -27,4 +27,4 @@");
  });

  test("collapses oversized files to a whole-file replacement with an honest note", () => {
    const lines = Array.from({ length: VERSION_LIMITS.maxLcsLines + 1 }, (_, i) => `line-${i}`);
    const patch = unifiedPatch(lines, lines, VERSION_LIMITS.maxPatchLines) ?? "";
    expect(patch).toContain("@@ diff note: file too large for a detailed line comparison");
    expect(patch).toContain("@@ diff truncated (cap reached)");
  });

  test("truncates patches at the line cap with an honest note", () => {
    const patch = unifiedPatch(["a", "b", "c", "d", "e"], ["a", "b", "X", "d", "e"], 3) ?? "";
    const lines = patch.split("\n");
    expect(lines).toHaveLength(4); // hunk header + 2 lines, then the truncation note
    expect(lines[lines.length - 1]).toBe(
      "@@ diff truncated (cap reached) — open the files for the full content"
    );
  });
});

describe("version payload + summaries — parseVersionPayload / toVersionDetail", () => {
  test("keeps valid entries, defaults missing sources to 'user' and preserves the config", () => {
    const payload = parseVersionPayload({
      filesJson: JSON.stringify({
        files: [
          { path: "index.html", content: "<p>hi</p>", encoding: "utf8", source: "generated" },
          { path: "img/logo.png", content: "AAAA", encoding: "base64", source: "ai" },
          { path: "notes.txt", content: "note", encoding: "utf8" },
          { path: "bad.bin", content: 42, encoding: "utf8" },
          { path: "weird.enc", content: "x", encoding: "binary" },
          "not-an-object",
        ],
        config: { version: 2, name: "kept" },
      }),
    });
    expect(payload.files.map((f) => f.path)).toEqual(["index.html", "img/logo.png", "notes.txt"]);
    expect(payload.files[0]?.source).toBe("generated");
    expect(payload.files[2]?.source).toBe("user");
    const config: unknown = payload.config;
    expect(config).toEqual({ version: 2, name: "kept" });
  });

  test("falls back to an empty payload for malformed or wrongly-shaped JSON", () => {
    expect(parseVersionPayload({ filesJson: "{nope" })).toEqual({ files: [], config: null });
    expect(parseVersionPayload({ filesJson: JSON.stringify({ files: "nope" }) })).toEqual({
      files: [],
      config: null,
    });
    expect(parseVersionPayload({ filesJson: "null" })).toEqual({ files: [], config: null });
  });

  test("computes file counts and decoded sizes for version summaries", () => {
    const versionRow = {
      id: "v-1",
      label: "Before AI edit",
      source: "user",
      createdAt: new Date("2026-02-03T04:05:06.000Z"),
      filesJson: JSON.stringify({
        files: [
          { path: "index.html", content: "<p>hi</p>", encoding: "utf8", source: "generated" },
          {
            path: "img/logo.png",
            content: Buffer.from("hello").toString("base64"),
            encoding: "base64",
            source: "ai",
          },
        ],
        config: null,
      }),
    } as unknown as GiftzProjectVersion;

    const summary = toVersionSummary(versionRow);
    expect(summary.id).toBe("v-1");
    expect(summary.label).toBe("Before AI edit");
    expect(summary.source).toBe("user");
    expect(summary.createdAt).toBe("2026-02-03T04:05:06.000Z");
    expect(summary.fileCount).toBe(2);

    const detail = toVersionDetail(versionRow);
    expect(detail.files).toEqual([
      { path: "index.html", sizeBytes: Buffer.byteLength("<p>hi</p>") },
      { path: "img/logo.png", sizeBytes: 5 },
    ]);
    expect(detail.config).toBeNull();
  });

  test("VERSION_LIMITS keeps 20 snapshots per site (prune contract §3.4)", () => {
    expect(VERSION_LIMITS.keep).toBe(20);
  });
});

// ================================================================ 6. classify

describe("classifyProjectRequest — file/config routing", () => {
  const site = { id: SITE_ID, title: "G4 Site", framework: "standard-static" };

  test("routes to the files pipeline when the router answers intent files", async () => {
    fakeDb.reset({ files: healthyFiles() });
    aiState.complete = async () => ({ text: '{"intent":"files","reason":"adds a custom page"}' });
    const routing = await classifyProjectRequest(USER_ID, site, "Add a pricing page with real files");
    expect(routing.intent).toBe("files");
    expect(routing.reason).toBe("adds a custom page");
  });

  test("routes to the config pipeline for config intent", async () => {
    fakeDb.reset({ files: healthyFiles() });
    aiState.complete = async () => ({ text: '{"intent":"config","reason":"color tweak"}' });
    const routing = await classifyProjectRequest(USER_ID, site, "Make the headings gold");
    expect(routing.intent).toBe("config");
    expect(routing.reason).toBe("color tweak");
  });

  test("falls back to the config pipeline when the router call throws (honest default)", async () => {
    fakeDb.reset({ files: healthyFiles() });
    aiState.complete = async () => {
      throw new Error("gateway down");
    };
    const routing = await classifyProjectRequest(USER_ID, site, "Add a pricing page");
    expect(routing.intent).toBe("config");
    expect(routing.reason).toContain("router was unavailable");
  });

  test("falls back to the config pipeline on unknown intents", async () => {
    fakeDb.reset({ files: healthyFiles() });
    aiState.complete = async () => ({ text: '{"intent":"database","reason":"wants a db"}' });
    const routing = await classifyProjectRequest(USER_ID, site, "Add a database");
    expect(routing.intent).toBe("config");
    expect(routing.reason).toContain("router was unavailable");
  });

  test("makes exactly ONE router call and includes the file count in the prompt", async () => {
    fakeDb.reset({ files: healthyFiles() }); // fake count → 5
    let routerCalls = 0;
    let routerUser = "";
    aiState.complete = async (_system: string, messages: AiMessage[]) => {
      routerCalls += 1;
      routerUser = messages[messages.length - 1]?.content ?? "";
      return { text: '{"intent":"files","reason":"rebuild fix"}' };
    };
    const routing = await classifyProjectRequest(USER_ID, site, "Fix the build errors");
    expect(routing.intent).toBe("files");
    expect(routerCalls).toBe(1);
    expect(routerUser).toContain("5 project files");
    expect(routerUser).toContain("Fix the build errors");
  });
});

// ================================================================ 7. preview serving

describe("preview serving — PREVIEW_CSP + servePreviewFile", () => {
  test("CSP forbids network access and framing but allows inline rendering scripts", () => {
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
    expect(PREVIEW_CSP).toContain("script-src * data: 'unsafe-inline'");
    expect(PREVIEW_CSP).toContain("form-action 'none'");
    expect(PREVIEW_CSP).toContain("frame-ancestors *");
  });

  test("previewNotFound is an honest plain-text 404 with the sandbox headers", () => {
    const res = previewNotFound();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(PREVIEW_CSP);
  });

  test("serves text files from the working tree with charset + sandbox headers", async () => {
    fakeDb.reset({ files: [row("index.html", HEALTHY_INDEX_HTML)] });
    const res = await servePreviewFile(SITE_ID, "index.html", null);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HEALTHY_INDEX_HTML);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(PREVIEW_CSP);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("serves base64 rows decoded with a binary content type", async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff];
    fakeDb.reset({
      files: [
        row("img/logo.png", Buffer.from(bytes).toString("base64"), "base64", "user"),
      ],
    });
    const res = await servePreviewFile(SITE_ID, "img/logo.png", null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual(bytes);
  });

  test("applies the proposal overlay: overrides content and hides removed files", async () => {
    fakeDb.reset({ files: [row("index.html", "<p>working tree</p>")] });

    const overridden = await servePreviewFile(
      SITE_ID,
      "index.html",
      new Map([["index.html", "<p>overlay</p>"]])
    );
    expect(await overridden.text()).toBe("<p>overlay</p>");

    const removed = await servePreviewFile(SITE_ID, "index.html", new Map([["index.html", null]]));
    expect(removed.status).toBe(404);
  });

  test("resolves directory-style requests to the directory's index.html", async () => {
    fakeDb.reset({ files: [row("about/index.html", "<p>about</p>")] });
    const res = await servePreviewFile(SITE_ID, "about", null);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>about</p>");

    const root = await servePreviewFile(SITE_ID, "", null);
    expect(root.status).toBe(404); // no root index.html in this tree
  });

  test("answers 404 for missing files and unsafe paths", async () => {
    fakeDb.reset({ files: [row("index.html", "<p>ok</p>")] });
    const missing = await servePreviewFile(SITE_ID, "nope.txt", null);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not found");

    const traversal = await servePreviewFile(SITE_ID, "../escape", null);
    expect(traversal.status).toBe(404);
  });
});
