# Task 2-a (backend core) — GIFTZ standalone platform — Work Record

Agent: 2-a (backend core). Contract: `CONTRACT.md` §3.1–3.5, §4 (except files/apply-proposal, deployments, domains, public routes), §5.1, sync rules S1/S2.
Scope honored: all AI-free/deterministic (no z-ai imports), owner-scoped on every route, honest errors, additive changes only. Did NOT touch publish/unpublish/deployments/domains/public routes, `site-studio/turn.ts`, any frontend file, WebsiteBuilderView/ChatPanel.

---

## 1. Files created (lib modules)

| File | Purpose |
|---|---|
| `src/lib/giftz/project-files.ts` | DB-backed file store: path confinement (`constrainProjectPath`), limits (`assertProjectLimits` → 413), CRUD (`listProjectFiles`/`readProjectFile`/`writeProjectFile`/`deleteProjectFile`), `projectTreeSummary`, MIME maps (`mimeForPath`/`isTextMime`/`isTextPath`), `ProjectFileError(status, code, message)`. |
| `src/lib/giftz/project-compiler.ts` | Deterministic compiler wrapping `buildSiteExport` (owner-scoped profile/projects/collections + owner-scoped media loader — mirrors `/api/me/site/export`); adds `package.json`, `site.config.json`, `scripts/validate.js` (self-contained Node validator template, 116 lines, verified with `node --check` + live runs), `.gitignore`; binary detection via NUL-in-first-8KB (`isBinaryBuffer`); per-file cap overflow → skip + warning. Implements S1 (`syncGeneratedFiles`) and the S2 helper (`syncConfigFromSiteConfigFile`). |
| `src/lib/giftz/project-build.ts` | `runProjectBuild(site, trigger, overlay?)` — GiftzBuild row QUEUED→BUILDING→SUCCEEDED/FAILED; 6 checks (entry file, local src/href resolution with query/hash stripping + URI decoding, JSON.parse / balanced-delimiter scanner for js/mjs/css, site.config.json schema + drift warning, size/count limits, UTF-8 mojibake ratio); success persists artifact `{ files: [{ path, mime, encoding, content }] }` (FULL tree); deployStatus PREVIEW/READY_TO_PUBLISH transition on manual/ai success (publish trigger untouched; failures leave prior value); activity `build`. `overlay?: Map<string, string|null>` applies an in-memory proposal (content override / delete) for this build only — the Task 3-b hook. Plus `serializeBuild`/`parseBuildDiagnostics` for routes. |
| `src/lib/giftz/project-versions.ts` | `snapshotProjectVersion` (full tree + normalized config; prune newest 20, NEVER prune source="publish"), `restoreProjectVersion` (atomic `$transaction` replace; rows not in snapshot deleted; each file keeps its ORIGINAL generated/user/ai source; config restored when present; then new version "Restore of '<label>'" source "restore"), LCS line diff (`unifiedPatch`, caps 1500 lines/side, 400 patch lines, binary/oversized → patch null), `diffVersionAgainstCurrent`, `diffVersions(aId, bId)` (§3.4 lib API; no route — §4 only exposes vs-current), `toVersionSummary`/`toVersionDetail` serializers. |
| `src/lib/giftz/project-activity.ts` | `recordGiftzActivity(siteId, userId, kind, detail)` — never throws (logs via logger on failure); `listGiftzActivity(siteId, limit=50)` newest-first with parsed detail objects. |
| `src/lib/giftz/preview-serve.ts` | Shared §5.1 serving core (deviation A below): exact CSP string, no-store, nosniff, text/base64 responses, plain-text 404, directory-style resolution, `loadProposalOverlay` (validates SiteStudioMessage → session.userId + targetSiteId, parses kind-"files" fileChanges into `Map<path, content|null>`). |

## 2. Routes created (all `export const dynamic = "force-dynamic"`, `handler()` + `ERR.*`, `getSessionUser()` → `findFirst({ id, userId })` → 404)

| File | Verbs |
|---|---|
| `src/app/api/giftz/sites/[id]/files/route.ts` | GET tree |
| `src/app/api/giftz/sites/[id]/files/content/route.ts` | GET ?path[&raw=1] / PUT / DELETE |
| `src/app/api/giftz/sites/[id]/files/rename/route.ts` | POST |
| `src/app/api/giftz/sites/[id]/preview/[...path]/route.ts` | GET (CSP, overlay, dir resolution) |
| `src/app/api/giftz/sites/[id]/preview/route.ts` | GET (root dir-style request → index.html; deviation B) |
| `src/app/api/giftz/sites/[id]/builds/route.ts` | GET newest 20 / POST run build (rate limit `giftz-build:`, 20/60s, `maxDuration = 120`) |
| `src/app/api/giftz/sites/[id]/builds/[buildId]/route.ts` | GET full build |
| `src/app/api/giftz/sites/[id]/versions/route.ts` | GET newest 20 / POST snapshot (source "user"; safety rate limit `giftz-version:`, 30/60s — deviation F) |
| `src/app/api/giftz/sites/[id]/versions/[versionId]/route.ts` | GET |
| `src/app/api/giftz/sites/[id]/versions/[versionId]/diff/route.ts` | GET vs current |
| `src/app/api/giftz/sites/[id]/versions/[versionId]/restore/route.ts` | POST (rate limit `giftz-restore:`, 10/60s) |
| `src/app/api/giftz/sites/[id]/activity/route.ts` | GET (optional `?limit=` 1–100, default 50) |

## 3. Files modified (additive — every existing field/behavior kept)

| File | Change |
|---|---|
| `src/app/api/giftz/sites/route.ts` | GET summaries gain `deployStatus`, `framework`, `hasFiles` (`_count.projectFiles > 0`). `createSchema`/`putSchema` gain optional `description` (trim ≤300; stored `null` when empty). POST create stores description; response gains `description`, `deployStatus`, `framework`. `saveGiftzSiteConfig` input gains `description?: string` (update applies it). Rate limits unchanged. |
| `src/app/api/giftz/sites/[id]/route.ts` | GET gains `deployStatus`, `framework`, `description`, `fileSummary` (`{ fileCount, totalBytes, lastUpdatedAt } | null`, null when 0 files), `lastBuild` (`{ id, status, createdAt, summary } | null`, newest build), `liveDeployment` (`{ id, deployedAt } | null`, newest status LIVE). PUT passes `description`; after a CONFIG save runs `syncGeneratedFiles` awaited inline and response gains `fileSync` (title/description-only saves skip the recompile and return the zero-count shape). |

## 4. Exported function signatures

```ts
// project-files.ts
PROJECT_FILE_LIMITS = { maxFiles: 300, maxTextBytes: 262_144, maxBase64Bytes: 4_194_304, maxTotalBytes: 31_457_280, maxPathDepth: 8, maxPathLength: 200 }
class ProjectFileError extends Error { status: number; code: string }   // default 400
constrainProjectPath(raw: unknown): string                               // throws ProjectFileError
projectContentSizeBytes(content: string, encoding: string): number       // base64 → decoded size
assertProjectLimits(existing: {path,sizeBytes,encoding}[], incoming: {path, content, encoding}): void  // throws 413
listProjectFiles(siteId: string): Promise<GiftzProjectFile[]>            // orderBy path asc
readProjectFile(siteId: string, path: string): Promise<GiftzProjectFile | null>
writeProjectFile(siteId, path, content, encoding: "utf8"|"base64", source: "generated"|"user"|"ai"): Promise<GiftzProjectFile>
deleteProjectFile(siteId: string, path: string): Promise<boolean>
projectTreeSummary(siteId): Promise<{ fileCount, totalBytes, lastUpdatedAt: string | null }>
mimeForPath(path: string): string                                        // unknown → application/octet-stream
isTextMime(mime: string): boolean; isTextPath(path: string): boolean

// project-compiler.ts
type CompiledFile = { path: string; content: string; encoding: "utf8"|"base64"; source: "generated" }
type CompileResult = { ok: true; files: CompiledFile[]; warnings: string[] } | { ok: false; error: string; warnings: string[] }
type FileSyncResult = { ok: boolean; error?: string; generated: number; skippedUserFiles: number; removed: number }
VALIDATE_SCRIPT: string                                                  // generated validator source (116 lines)
compileGiftzProjectFiles(input: { siteId, config: SiteConfig, userId, watermark? }): Promise<CompileResult>
syncGeneratedFiles(userId: string, siteId: string): Promise<FileSyncResult>          // S1
syncConfigFromSiteConfigFile(siteId, userId, configText): Promise<{ ok: true; config: SiteConfig } | { ok: false; error: string; issues: string[] }>  // S2
type ConfigSyncResult = (the union above)

// project-build.ts
type BuildTrigger = "manual" | "publish" | "ai"
interface BuildDiagnostic { path: string; severity: "error" | "warning"; message: string }
interface BuildDiagnostics { checks: BuildDiagnostic[]; summary: string; checksRun: number; durationMs: number }
stripCommentsAndStrings(text): string; balancedDelimiterError(text): string | null; resolveLocalRef(ref, fromPath): string | null
runProjectBuild(site: GiftzSite, trigger: BuildTrigger, overlay?: Map<string, string | null>): Promise<GiftzBuild>
parseBuildDiagnostics(build: { diagnosticsJson: string | null }): BuildDiagnostics | null
serializeBuild(build: GiftzBuild): SerializedBuild                       // { id, status, trigger, summary, checksRun, durationMs, diagnostics, artifactFileCount, startedAt, createdAt, finishedAt }

// project-versions.ts
VERSION_LIMITS = { keep: 20, maxLcsLines: 1500, maxPatchLines: 400 }
type VersionSource = "ai" | "user" | "publish" | "restore" | "auto"
snapshotProjectVersion(siteId, userId, label, source): Promise<GiftzProjectVersion>  // prunes >20, never "publish"
restoreProjectVersion(site: GiftzSite, versionId, userId): Promise<{ ok: true; fileCount; config: SiteConfig | null } | { ok: false; error }>
unifiedPatch(oldLines: string[], newLines: string[], maxPatchLines: number): string | null
diffVersionAgainstCurrent(site, versionId): Promise<{ ok: true; changed: VersionDiffEntry[] } | { ok: false; error }>
diffVersions(site, aId, bId): Promise<{ ok: true; changed: VersionDiffEntry[] } | { ok: false; error }>
type VersionDiffEntry = { path: string; action: "added"|"removed"|"modified"; patch: string | null }
toVersionSummary(row): { id, label, source, createdAt, fileCount }
toVersionDetail(row): VersionSummary & { files: { path, sizeBytes }[]; config: SiteConfig | null }

// project-activity.ts
recordGiftzActivity(siteId, userId, kind, detail: Record<string, unknown>): Promise<void>  // NEVER throws
listGiftzActivity(siteId, limit = 50): Promise<{ id, kind, detail, createdAt: string }[]>

// preview-serve.ts
PREVIEW_CSP: string
previewNotFound(): NextResponse
loadProposalOverlay(userId, siteId, messageId): Promise<Map<string, string | null> | null | "invalid">
servePreviewFile(siteId, rawPath, overlay): Promise<NextResponse>
```

## 5. Exact response JSON shapes (source of truth for the frontend agent)

- `GET files` → `{ files: [{ path, source, sizeBytes, encoding, updatedAt (ISO), mime }], summary: { fileCount, totalBytes, lastUpdatedAt: string|null } }`
- `GET files/content?path=` → utf8: `{ file: { path, content, encoding: "utf8", source, mime, sizeBytes, updatedAt } }`; base64 WITHOUT `raw=1`: **415** `{ file: { path, encoding: "base64", source, mime, sizeBytes, updatedAt }, binary: true }`; with `raw=1`: `{ file: { path, content: "<base64>", encoding: "base64", ... } }`. Unknown → 404.
- `PUT files/content` `{ path, content, encoding? }` → `{ file: { path, content, encoding, source: "user", mime, sizeBytes, updatedAt }, configSynced: boolean, config?: SiteConfig }` (`config` present only when path === `site.config.json`). Invalid site.config.json → **422** `{ error }` (nothing written). Limits → 413. Rate limit 120/60s → 429.
- `DELETE files/content?path=` → `{ deleted: true }`; `site.config.json` → 400 `{ error }`; missing → 404.
- `POST files/rename` `{ from, to }` → `{ file: { path, content, encoding, source, mime, sizeBytes, updatedAt } }`; target exists → 409; `from === "site.config.json"` → 400.
- `preview/*` → raw file body; headers `Content-Type` (+`; charset=utf-8` for text mimes), `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; img-src * data: blob:; style-src * data: 'unsafe-inline'; font-src * data:; script-src * data: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors *`, `X-Content-Type-Options: nosniff`; missing → plain-text 404 (same CSP).
- `GET builds` → `{ builds: [{ id, status, trigger, summary, checksRun, durationMs, diagnostics, artifactFileCount, startedAt, createdAt, finishedAt }] }` (newest 20; diagnostics = checks array or null)
- `POST builds` `{ trigger?: "manual"|"ai" }` → `{ build: <same shape> }` (synchronous; FAILED builds carry real diagnostics)
- `GET builds/[buildId]` → `{ build: <same shape> }`
- `GET versions` → `{ versions: [{ id, label, source, createdAt, fileCount }] }` (newest 20)
- `POST versions` `{ label? }` → `{ version: { id, label, source: "user", createdAt, fileCount } }`
- `GET versions/[versionId]` → `{ version: { id, label, source, createdAt, fileCount, files: [{ path, sizeBytes }], config: SiteConfig | null } }`
- `GET versions/[versionId]/diff` → `{ changed: [{ path, action, patch }] }` (patch = unified text or null for binary)
- `POST versions/[versionId]/restore` → `{ restored: true, fileCount, config: SiteConfig | null }` (rate limit 10/60s)
- `GET activity` → `{ activity: [{ id, kind, detail, createdAt }] }`
- `GET sites/[id]` additions → `site.deployStatus`, `site.framework`, `site.description`, `site.fileSummary`, `site.lastBuild`, `site.liveDeployment`
- `PUT sites/[id]` → `{ saved: true, savedAt, config, fileSync: { ok, error?, generated, skippedUserFiles, removed } }`
- `GET sites` list items gain → `deployStatus`, `framework`, `hasFiles`; `POST sites` response gains `description`, `deployStatus`, `framework`

## 6. Contract deviations / notes

1. **`src/lib/giftz/preview-serve.ts` (extra lib file)** — §5.1 lists only the `[...path]` route, but "path ends with `/` or empty" cannot match a required catch-all after Next's trailing-slash normalization. The shared helper keeps ONE implementation for the catch-all route AND a small root `preview/route.ts` serving the empty-path case. Route files cannot export helpers (Next route export validation), so the logic lives in a lib module.
2. **`preview/route.ts` (extra route file)** — same reason; serves index.html for `/api/giftz/sites/:id/preview`.
3. **S1 activity kind** — contract offers `"ai.compose"|"file.write"`; `syncGeneratedFiles` cannot know whether the config save originated from AI compose or the visual editor, so it records `"file.write"` with `{ reason: "config-save", generated, skippedUserFiles, removed }`.
4. **Compiled-file caps** — §3.2 says skip files exceeding `maxBase64Bytes`; implementation skips any compiled file exceeding ITS encoding's cap (utf8 → 256KB, base64 → 4MB) so `syncGeneratedFiles` can never violate the write limits, with an honest warning either way.
5. **PUT files/content response** — §4 says `{ file }`; response also carries `configSynced` and (for site.config.json) the normalized `config` so the CodeWorkspace's `onConfigSynced` flow works without a second fetch (2-b re-GETs anyway, so both usages work).
6. **POST versions rate limit** — not in the contract table; added `giftz-version:` 30/60s because each snapshot stores the full tree (unbounded snapshots would be an abuse vector; pruning caps storage, this caps churn).
7. **Rename + site.config.json** — DELETE of the bridge is refused per §4; renaming FROM `site.config.json` is refused with the same class of honest error (renaming would be a delete+create loophole; the file is regenerated by every compile).
8. **S2 media-guard failure status** — invalid schema → 422 per contract; a schema-valid config referencing unowned media returns 422 with the guard's message (the contract does not name a status for that branch; 422 keeps the "invalid site.config.json" family together; nothing is written).
9. **Restore failure status** — transaction failure maps to 500 with the real message (missing version pre-checked → 404).
10. **`deployStatus` on successful manual/ai build** — `PREVIEW` when the site has no deployment rows, `READY_TO_PUBLISH` when at least one exists (monotonic: never downgrades PUBLISHED); failures leave the prior value; `DEPLOYING` is never touched (publish flow owns it).
11. **Exported internals** — `stripCommentsAndStrings`, `balancedDelimiterError`, `resolveLocalRef`, `unifiedPatch`, `VALIDATE_SCRIPT` are exported (used by sanity verification and reusable by Task 3-b's agent pipeline; no behavior coupling).

## 7. Verification

- `bun run lint` → **0 errors**, 13 warnings — all pre-existing baseline in files outside this task (`scripts/loadtest/k6/*`, `PostComments`, `PostComposer`, `PostMediaView`, `VideoCard`, `PostDetailView`). Zero findings in any file I created/modified.
- `bunx tsc --noEmit` filtered to `project-*|preview-serve|api/giftz` → **clean**. (Remaining project tsc issues live in `scripts/`/`tests/` clusters — verification-task baseline.)
- Runtime sanity (transient /tmp scripts, removed afterwards): all 11 invalid-path shapes rejected with the right messages; valid paths normalize (duplicate slashes collapse); MIME map + text classification verified; size/count/per-file caps (incl. replace-at-cap and base64 decoded-size cap) verified; balanced-delimiter scanner verified on good/bad JS + CSS with string/comment immunity; link resolver verified (./ ../ https data mailto tel # //, query+hash strip, %20 decode); LCS patch output matches expected unified form; generated `scripts/validate.js` passed `node --check`, detected a broken reference + unbalanced JS (exit 1) and passed a clean tree (exit 0), 116 lines ≤ 120; package.json emitted via `JSON.stringify` (valid JSON, no comments).
- Not run (per instructions): `bun test`, dev server start. Route smoke-testing over HTTP was skipped because the auto dev server was not accepting connections during this session.

## 8. Handoff notes for later agents

- **Task 3-a (deploy)**: consume `runProjectBuild(site, "publish")` (it does NOT touch deployStatus for the publish trigger) and read `build.artifactJson` (`{ files: [{ path, mime, encoding, content }] }`) into the deployment. `GET sites/[id].liveDeployment` already expects status LIVE + `deployedAt`.
- **Task 3-b (agent pipeline)**: `runProjectBuild`'s third param is the overlay (`Map<string, string|null>`); persist proposals with `proposalJson.kind === "files"` and `fileChanges: [{ path, action: "added"|"modified"|"removed", content?, encoding: "utf8" }]` — `loadProposalOverlay` + `files/apply-proposal` (yours) parse exactly that shape.
- **2-b frontend**: response shapes above match what your `giftz-client.ts` expects (verified against your work record); the 415 binary shape, `{ file }` PUT shape, `fileSync`, and version/build DTOs align as documented.
