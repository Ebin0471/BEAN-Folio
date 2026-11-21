# G-4 — Unit tests for the GIFTZ standalone project platform

Agent: G-4 (unit tests)
Date: 2026-11-13
Scope: ONE new file — `tests/giftz-project-platform.test.ts`. No `src/` files touched
(git: only the new untracked test file from this task; the modified `src/` files in the
working tree belong to prior tasks 2-a / 3-a / 3-b).

## Deliverable

`tests/giftz-project-platform.test.ts` — unit-style, no real AI calls, no real DB
queries, no filesystem access. Run: `bun test tests/giftz-project-platform.test.ts`

**Result: 60 pass / 0 fail, 220 expect() calls, ~0.3s.** The warn-level log lines in
the output (`giftz.agent.classify_failed` / `classify_invalid`) are the module's own
honest-fallback logging exercised intentionally by the fallback tests — not errors.

## Mocking approach (matches repo conventions)

- `mock.module("@/lib/db", ...)` — **first db mock in this repo's tests** (existing
  tests use the real DB). Captured the real module first and restored it in `afterAll`
  (same convention as `tests/giftz-api.test.ts`). The fake is minimal and loud: only
  `giftzProjectFile.{count,findMany,findUnique}`, `giftzBuild.{create,update,findUnique}`,
  `giftzSite.update`, `giftzDeployment.count`, `giftzActivity.create` exist; anything
  else fails instead of pretending to work.
- `mock.module("@/lib/ai", ...)` — wholesale seam exactly like
  `tests/riishe-chat-reliability.test.ts` (scripted `aiComplete`, real-shaped
  `parseJsonFromText`, no restore — the real module imports `z-ai-web-dev-sdk`,
  which unit tests must not load; precedent: riishe file).
- Modules under test are imported via `await import(...)` AFTER the mocks are armed
  (hoisting-safe pattern from giftz-api.test.ts).

## Coverage per contract §3 / task spec

### 1. `constrainProjectPath` (project-files.ts, pure)
- accepts normal paths; normalizes duplicate/trailing slashes; preserves case; depth-8 OK; 200-char boundary OK.
- rejects: absolute, backslash, NUL, non-strings, empty, `"//"` (leading-slash rule fires first — pinned honestly).
- rejects `..`, dot segments, `.git` segments (via the dot-segment rule that always fires first — pinned honestly), `my.git/HEAD` allowed.
- over-length (201) / over-depth (9) → `ProjectFileError` status 413 + codes `path_too_long` / `path_too_deep`.

### 2. `assertProjectLimits` (pure)
- `projectContentSizeBytes` utf8/base64 counting.
- text cap 256KB → 413 `file_too_large`; base64 decoded cap 4MB → 413 `file_too_large`;
  file-count cap 300 → 413 `too_many_files` (replacement of an existing path allowed);
  total cap 30MB → 413 `project_too_large` (replacement does not double-count);
  invalid encoding → 400 `invalid_encoding`.

### 3. `mimeForPath` / `isBinaryPath` (pure)
- all text exts from the map; binary exts incl. case-insensitivity (`photo.JPG`);
  unknown/missing ext → `application/octet-stream`;
  `isBinaryPath` true for known binary assets only (SVG is text; extensionless/unknown-ext are not binary).

### 4. Build validation (project-build.ts)
- **Pure helpers tested directly** (exported): `stripCommentsAndStrings`,
  `balancedDelimiterError` (strings/comments/template literals excluded; unclosed
  delimiter reports opening line number; mismatched closer; CSS braces+comments),
  `resolveLocalRef` (excludes external/data/mailto/tel/#//, strips query+hash,
  dir-relative resolution, `%20` decode), `parseBuildDiagnostics` (defensive nulls),
  `serializeBuild` (summary/checksRun/durationMs/diagnostics/artifactFileCount/ISO dates).
- **`runProjectBuild` end-to-end against the in-memory db fake** (permitted by the
  task since a fake was already required for item 6): healthy tree SUCCEEDS with
  artifact + `deployStatus → PREVIEW` + build activity; missing `index.html`;
  broken local refs (root + `../` from a subdir); invalid JSON; unbalanced js/css
  delimiters; `site.config.json` drift → warning only; empty binary-extension file →
  warning only; **proposal overlay** (add fixes the build / remove hides the file);
  db crash → honest FAILED `(build)` diagnostic.

### 5. Versions (project-versions.ts)
- `unifiedPatch` (exported pure LCS diff): identical/empty → null; addition hunk exact
  format `@@ -1,2 +1,3 @@ / -lines / +lines`; removal hunk; modification as paired -/+
  with hunk counts; empty→content `@@ -1,0 +1,1 @@`; distant changes → 2 hunks with
  3-line context (`@@ -27,4 +27,4 @@`); oversized (>1500 lines) → whole-file
  replacement + honest note; truncation cap → honest note.
- `parseVersionPayload`: valid entries kept, missing `source` defaults to `"user"`,
  invalid entries filtered, config preserved; malformed/`null`/wrong-shape JSON →
  `{ files: [], config: null }`.
- `toVersionSummary` / `toVersionDetail`: counts, ISO dates, decoded base64 sizes.
- `VERSION_LIMITS.keep === 20` (prune target pinned; the prune EXECUTION itself is
  DB-bound — see "not covered").

### 6. `classifyProjectRequest` (project-agent.ts)
- `{"intent":"files"}` → files; `{"intent":"config"}` → config; aiComplete THROWS →
  deterministic `config` default with honest "router was unavailable" reason; unknown
  intent → same honest default.
- exactly ONE router call; fake `giftzProjectFile.count` returns 5 and the count
  flows into the prompt ("5 project files"). Note documented in-test: empty sites
  skip the classifier in `turn.ts`, NOT inside `classifyProjectRequest` itself.

### 7. Bonus: preview serving (preview-serve.ts — in the task's module list)
- `PREVIEW_CSP` pins the documented network restriction (`connect-src 'none'`,
  `default-src 'none'`, inline-script allowance, `frame-ancestors *`, `form-action 'none'`).
- `previewNotFound` honest plain-text 404 with sandbox headers.
- `servePreviewFile` via db fake: text row + charset; base64 row decoded with binary
  mime; overlay content override; overlay deletion hides; directory-style
  (`"about"` → `about/index.html`); 404 for missing/unsafe paths.

## NOT covered, and why (honest)

1. **`validatePlanOutput`** (project-agent.ts) — **not exported** (private fn, line
   ~326). Reaching it means driving `runProjectTurn` (heavy multi-seam mock of
   aiComplete plan/execute sequences + message/task/activity/version writes) or
   exporting it from src — the task forbids modifying `src/`. Skipped per the task's
   "if exported" condition; noted here.
2. **`snapshotProjectVersion` / `restoreProjectVersion` / `diffVersionAgainstCurrent` /
   `diffVersions`** — DB-transaction flows (`$transaction`, per-row upserts). The repo
   had no established db-mock pattern for these before this task; per the task's
   "verify DB-dependent functions only if a clean db-mock pattern already exists",
   they are skipped (the pure parts — payload parsing, diffing, summaries — ARE
   covered; the prune target constant is pinned).
3. **`project-compiler.ts` (`compileGiftzProjectFiles`, `syncGeneratedFiles`,
   `syncConfigFromSiteConfigFile`)** — wraps `buildSiteExport` + MediaAssets loader +
   version/activity writes; DB+export-pipeline integration, not unit-testable under
   the task constraints. Not covered.
4. **`project-deploy.ts` (`publishGiftzSiteProject`, `rollbackDeployment`,
   `unpublishGiftzSiteProject`)** — multi-row deploy lifecycle with real DNS verify;
   needs the same integration treatment as 2. Not covered.
5. **Preview/public HTTP routes** (§5) — route-level integration (auth, catch-all
   segments); only the shared lib layer (`preview-serve.ts`) is covered.
6. `check 4 normalizeConfig` invalid-schema branch and the UTF-8 mojibake check are
   reachable only through `runProjectBuild` fixtures; I covered the drift/valid paths
   but did not craft a mojibake fixture (low value, and the check is a one-liner
   ratio guard).

## Verification results

- `bun test tests/giftz-project-platform.test.ts` → **60 pass, 0 fail** (220 expects).
- `bun run lint` → **0 errors, 13 warnings — all pre-existing baseline** (same list as
  prior agents recorded: `scripts/loadtest/k6/*`, PostComments/PostComposer/
  PostMediaView/VideoCard/PostDetailView); grep over lint output for
  `giftz-project-platform` → **empty (clean)**.
- `bunx tsc --noEmit` filtered to `giftz-project-platform` → **empty (clean)** (the
  tests/scripts clusters have pre-existing tsc errors — untouched, per baseline).
- Not run (per instructions): full test suite, dev server. Known pre-existing failures
  (design-jobs-durable persistJob dead-cluster import; auth.test.ts isDemo drift;
  portfolio/*, site-sections-giftz, studio-profession-aware, design-step-repair-retry,
  riishe-automation import failures) were left alone as documented baseline.
