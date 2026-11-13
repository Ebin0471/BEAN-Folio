# GIFTZ STANDALONE PLATFORM — IMPLEMENTATION CONTRACT (v1)

This document is the single source of truth for all agents implementing the
GIFTZ → standalone AI website creation platform transformation. Read it fully
before writing code. Follow it exactly; deviations cause integration failures.

## 0. HARD RULES

1. **UI PRESERVATION**: The live GIFTZ UI is `src/views/WebsiteBuilderView.tsx`
   + `src/components/bean/site/studio/ChatPanel.tsx` + `src/views/SiteGiftzSiteView.tsx`
   (mounted via `src/components/bean/SiteShell.tsx` route `#/giftz` and public
   route `/site/<username>/g/<siteId>`). Do NOT redesign, restyle, or reorder
   existing regions. Only ADD style-consistent controls where this contract
   specifies. Match existing visual language: gold accents `#c8a24a`, obsidian
   cards `bg-[#0d0f14] border-white/10` (legacy) and theme tokens
   `border-border/60 bg-card/60`, `bg-gold-soft text-primary` active tabs,
   status tones emerald/red/amber (`border-emerald-500/40 bg-emerald-500/10 text-emerald-300` etc).
2. **NO FAKE RESULTS**: never fabricate build success, deployment success, AI
   output, or published URLs. Every failure is an honest status + message.
3. **NO OLLAMA / no new AI providers**. All AI goes through `aiComplete` from
   `@/lib/ai` (the BEAN Intelligence gateway). Never hardcode model names.
4. **OWNERSHIP on every API**: `getSessionUser()` from `@/lib/auth`, then
   owner-scoped DB queries (`site.userId !== user.id → 404`). Unauthenticated
   routes: ONLY `/api/giftz/sites/[id]/public/...` (published files).
5. **Never touch**: portfolio SiteDesign flows, RIISHE, LAXII, Discover,
   social/feed code, unrelated API routes. Additive changes only.
6. Do not modify files outside your assigned file list without explicit need;
   never edit files another concurrent agent owns (see §9 ownership map).
7. TypeScript strict; run `bun run lint` on your changed files before finishing.
   Do NOT run `bun test` (a separate verification phase handles it).
8. No TODO/FIXME/mock/placeholder left in code. No silent catch swallowing
   errors — log via `logger` and surface honest errors.

## 1. ARCHITECTURE OVERVIEW

```
User prompt (ChatPanel, GIFTZ session)
  → POST /api/me/site/studio/sessions/:id/messages  (existing; UNCHANGED)
  → site-studio/turn.ts executeTurn                  (existing; EXTENDED §6)
      ├─ mode "create" or config-level edit → existing ai-design pipeline →
      │    StudioProposalPayload { kind:"config", config, changedFiles, ... }
      └─ code-level request → NEW file-level agent pipeline (§6) →
           StudioProposalPayload { kind:"files", fileChanges, ... }
  → ChatPanel renders proposal → user previews → Save Draft applies
      ├─ kind "config" → PUT /api/giftz/sites/:id (existing) → server ALSO
      │    recompiles generated project files (§4 sync rule S1)
      └─ kind "files" → POST /api/giftz/sites/:id/files/apply-proposal (§3)

Visual editor (Customization tab + GIFTZ preview interactions)
  → config change → PUT /api/giftz/sites/:id → recompile generated files (S1)

Code editor (NEW, GIFTZ tab → Code zone)
  → PUT /api/giftz/sites/:id/files/content → source becomes "user";
     if path === "site.config.json" → config syncs (S2)

Preview (GIFTZ tab center area, two modes)
  ├─ Rendered canvas: SiteRenderer in DeviceStage iframe (EXISTING, unchanged)
  └─ Code preview: sandboxed iframe → /api/giftz/sites/:id/preview/[...path]
     (opaque origin: sandbox="allow-scripts", CSP connect-src 'none') (§5)

Publish
  → POST /api/giftz/sites/:id/publish (EXTENDED §7): build → deploy →
     artifact served publicly at /api/giftz/sites/:id/public/[...path] and
     SiteGiftzSiteView renders it in a sandboxed iframe when LIVE.
```

**Unification model** (the two editing systems are one system):
- `GiftzSite.config` (SiteConfig JSON) = content/design model.
- `GiftzProjectFile` rows = the real file tree. Compiled output of the
  compiler (`compileGiftzProjectFiles`) counts as the deterministic projection
  of the content model into real files.
- `site.config.json` lives INSIDE the file tree and mirrors `GiftzSite.config`.

### Sync rules (S1/S2)
- **S1 (content → files)**: whenever `GiftzSite.config` is saved via
  `PUT /api/giftz/sites/:id` (route `saveGiftzSiteConfig`), after persisting
  config the server calls `syncGeneratedFiles(siteId, userId)`:
  compile fresh files; for each compiled file: upsert ONLY if the existing
  row is absent or `source === "generated"`; rows with `source user|ai` are
  left untouched and reported. Delete compiled files that no longer exist in
  the fresh compile only if their row `source === "generated"`. Never delete
  user/ai files. Write a `GiftzProjectVersion` snapshot (source "user") of the
  post-sync tree. Append `GiftzActivity { kind: "ai.compose"|"file.write" }`
  summary. On compile failure: keep previous files, set no fake state, log
  + surface via activity kind "build" with severity error? — NO: compile
  failure during save is logged + returned in the save response as
  `fileSync: { ok: false, error: string }` (UI shows a warning toast; the
  config save itself still succeeds — content model is independent).
- **S2 (files → content)**: `PUT /api/giftz/sites/:id/files/content` with
  `path === "site.config.json"`: validate JSON against the SiteConfig schema
  (`normalizeConfig` from `@/lib/site-config` + media guard
  `siteConfigMediaError`); if valid, update `GiftzSite.config` too (single
  transaction-ish sequence); if invalid, return 422 with the parse error and
  do NOT write the file. The file row still gets `source: "user"`.

## 2. PRISMA MODELS (already pushed to db — do NOT re-push; client is generated)

Models `GiftzProjectFile`, `GiftzProjectVersion`, `GiftzBuild`,
`GiftzDeployment`, `GiftzDomain`, `GiftzActivity` exist with relations to
`GiftzSite` (see `prisma/schema.prisma` lines ~940-1066). GiftzSite gained
`description String?`, `framework String @default("standard-static")`,
`deployStatus String @default("DRAFT")` and the relation lists.

## 3. BACKEND LIB MODULES (new, under `src/lib/giftz/`)

### 3.1 `src/lib/giftz/project-files.ts` — file store
Limits (export const PROJECT_FILE_LIMITS):
```ts
{ maxFiles: 300, maxTextBytes: 262_144 /*256KB*/, maxBase64Bytes: 4_194_304 /*4MB decoded*/,
  maxTotalBytes: 31_457_280 /*30MB*/, maxPathDepth: 8, maxPathLength: 200 }
```
Functions:
- `constrainProjectPath(raw: string): string` — throws `ProjectFileError(status, code, message)`
  on: not a string, empty, absolute (`/`-prefixed), contains `\`, `..`, NUL,
  segment starting `.`, exceeds length/depth; normalizes duplicate slashes;
  lowercases nothing (paths case-sensitive); reserved top-level names NOT
  enforced except `.git` prefix forbidden (any segment equal to `.git`).
- `assertProjectLimits(existing: {path,sizeBytes,encoding}[], incoming: {path, content, encoding})` —
  enforce count/total/per-file caps; `ProjectFileError` 413.
- `listProjectFiles(siteId)` → rows ordered by path.
- `readProjectFile(siteId, path)` → row or null.
- `writeProjectFile(siteId, path, content, encoding, source)` — upsert;
  computes sizeBytes from content; `updatedAt` bump.
- `deleteProjectFile(siteId, path)` — returns boolean.
- `projectTreeSummary(siteId)` → `{ fileCount, totalBytes, lastUpdatedAt }`.
- MIME guess: `mimeForPath(path)` — html, css, js, mjs, json, svg, txt, md,
  webmanifest; base64 rows carry their stored mime from a parallel
  `assets.json`? NO — simpler: `encoding === "base64"` rows always store
  `content` base64 and the compiler writes a `mime` hint INSIDE the path
  extension; mime detection purely from extension + a small map
  (png jpg jpeg gif webp svg ico woff2 woff ttf mp4 webm mp3 pdf). Export
  `mimeForPath` from this module (single source, used by preview/public/build).

### 3.2 `src/lib/giftz/project-compiler.ts` — deterministic compiler
- `compileGiftzProjectFiles(input: { siteId, config: SiteConfig, userId, watermark? }): Promise<CompileResult>`
  where `CompileResult = { ok: true, files: CompiledFile[] } | { ok: false, error: string }`,
  `CompiledFile = { path: string; content: string; encoding: "utf8"|"base64"; source: "generated" }`.
- Implementation: call `buildSiteExport` from `@/lib/site-export` with a
  loader that reads MediaAssets owned by `userId` (mirror the loader in
  `src/app/api/me/site/export/route.ts` — read that route first). Use the
  returned `files: ExportFile[]` (paths like `index.html`, `project-<id>.html`,
  `assets/styles.css`, `assets/site.js`, `assets/images/*`, `manifest.json`,
  `README.md`) PLUS append:
  - `package.json`: `{ name: slugified title, version: "0.1.0", private: true,
    description, scripts: { build: "node scripts/validate.js" }, framework: "standard-static", generatedBy: "GIFTZ on BEAN Folio" }`
  - `site.config.json`: `JSON.stringify(config, null, 2)`.
  - `scripts/validate.js`: a small Node script performing the same static
    checks as the server build (link/asset resolution, brace balance) so the
    project is self-validating offline. Keep it ≤120 lines.
  - `.gitignore` (node_modules, .DS_Store).
- Preserve ExportFile `data` Buffers: utf8 text files → content string;
  binary (images/fonts/media) → base64 with encoding "base64". Use
  `looksBinary`-style detection (buffer contains 0x00 in first 8KB) — write a
  local `isBinaryBuffer`.
- Cap: if a single compiled file exceeds `maxBase64Bytes` → skip it and record
  a warning (CompileResult gets optional `warnings: string[]`).
- Export also `syncGeneratedFiles(userId, siteId)` implementing sync rule S1
  (it lives here; uses project-files.ts + records version + activity).
  Returns `{ ok: boolean; error?: string; generated: number; skippedUserFiles: number; removed: number }`.
- Export `syncConfigFromSiteConfigFile(siteId, userId, configText)` for S2.

### 3.3 `src/lib/giftz/project-build.ts` — build validation
`runProjectBuild(site: GiftzSite, trigger: "manual"|"publish"|"ai"): Promise<GiftzBuild>`
- Creates `GiftzBuild` row status QUEUED → BUILDING (immediately; builds are
  fast, in-process) → SUCCEEDED | FAILED. Persist diagnostics + artifact.
- Checks (each produces `{ path, severity: "error"|"warning", message }`):
  1. Entry exists: `index.html` at root (error).
  2. Every local reference in each `.html` file (`src=`, `href=`, excluding
     `http://`, `https://`, `data:`, `mailto:`, `tel:`, `#...`, `//`) resolves
     to an existing file in the tree (error if missing; resolve relative to
     the referencing file; strip query/hash; decode URI components).
  3. Every `.css`/`.js`/`.json` file is valid at a syntax level: JS via
     `new Function` is NOT allowed — use `node --check`-free approach:
     JSON.parse for .json; for .js use a lightweight check: balanced
     brackets/parens/braces outside strings & comments (write a small
     scanner; honest "syntax check is heuristic" wording in diagnostics is
     NOT needed — keep message factual: "balanced-delimiter check failed: unclosed { at line N").
     For .css: balanced braces + every `{` has a `}`.
  4. `site.config.json` parses + passes `normalizeConfig` (warning on drift).
  5. Total size + file count within limits (error).
  6. UTF-8 validity of text rows (error on mojibake replacement chars ratio > 0.1).
- Artifact on success: `{ files: [{ path, mime, encoding, content }] }` —
  ALL files of the tree (the deployment serves exactly this).
- Also update `site.deployStatus`: on success from DRAFT → "PREVIEW"
  (or "READY_TO_PUBLISH" if a deployment already exists and is older than
  this build); FAILED builds set "FAILED" only if current deployStatus is
  BUILDING/PREVIEW-because-of-this-build... keep simple: manual/ai builds set
  deployStatus "PREVIEW" on success / leave prior value on failure but record
  diagnostics. Publish flow manages DEPLOYING/PUBLISHED itself.
- Record `GiftzActivity { kind: "build" }` with summary + ok flag.

### 3.4 `src/lib/giftz/project-versions.ts` — versions
- `snapshotProjectVersion(siteId, userId, label, source)` → creates
  `GiftzProjectVersion` with full tree + current config (JSON string).
  Pruning: keep newest 20; NEVER delete rows with `source === "publish"`.
- `restoreProjectVersion(site, versionId, userId)` → replaces the file tree
  atomically (delete rows not in snapshot, upsert all snapshot rows with
  source "restored"→ store as "user"? NO — restore writes source "user" for
  previously-user files and "generated" for previously-generated files
  (preserve each file's original `source` from the snapshot); if snapshot has
  `config`, also update `GiftzSite.config`; then create a NEW version labeled
  "Restore of '<label>'" source "restore". Returns counts.
- `diffVersionAgainstCurrent(site, versionId)` → `{ changed: [{ path, action:
  "added"|"removed"|"modified", patch: string|null }] }` where patch is a
  small unified diff for text files (implement a simple LCS line diff in this
  module — no new deps).
- `diffVersions(site, aId, bId)` same shape between two versions (for compare).

### 3.5 `src/lib/giftz/project-activity.ts`
- `recordGiftzActivity(siteId, userId, kind, detail: Record<string, unknown>)` —
  insert row; never throws (log on failure). `listGiftzActivity(siteId, limit=50)`.

### 3.6 `src/lib/giftz/project-agent.ts` — file-level AI pipeline (Task 3-b only)
See §6.

## 4. API ROUTES (new)

All under `src/app/api/giftz/sites/[id]/`. EVERY route: `getSessionUser()`,
load site `findFirst({ id, userId })` (404 on miss) — EXCEPT `/public/*`.
Use `handler()` + `ERR.*` helpers from `@/lib/api-helpers`; parse bodies with
`parseBodySized`. Add `export const maxDuration = 120` where AI is used.

| Route | Method | Body/Query | Response |
|---|---|---|---|
| `files` | GET | — | `{ files: [{ path, source, sizeBytes, encoding, updatedAt, mime }], summary }` (NO content — tree only) |
| `files/content` | GET | `?path=` | `{ file: { path, content, encoding, source, mime, updatedAt } }` (404 unknown; 415 for base64 rows: return `{ file: { path, encoding:"base64" }, binary: true }` with NO content unless `?raw=1`) |
| `files/content` | PUT | `{ path, content, encoding? }` | `{ file }` — writes with source "user"; S2 config sync; creates `GiftzProjectVersion` (source "user") on change; rate limit `rateLimitShared("giftz-file:"+user.id, 120, 60_000)`; activity `file.write` |
| `files/content` | DELETE | `?path=` | `{ deleted: true }` — activity `file.delete`; refuse deleting `site.config.json` (400 honest message: remove via save/discard instead) |
| `files/rename` | POST | `{ from, to }` | `{ file }` — source preserved; refuses if `to` exists |
| `files/apply-proposal` | POST | `{ messageId }` | applies the kind-"files" proposal stored on that SiteStudioMessage (§6); creates version (source "ai"); activity `ai.edit`; returns `{ applied: number, files: [...], config?: SiteConfig }` |
| `preview/*` | GET | path | raw file from WORKING tree with proposal overlay (§5) |
| `builds` | GET | — | `{ builds: [ {id, status, trigger, summary, checksRun, durationMs, createdAt, finishedAt} ] }` newest 20 |
| `builds` | POST | `{ trigger? }` | runs `runProjectBuild` synchronously → `{ build: {id, status, diagnostics, ...} }` rate limit 20/60s |
| `builds/[buildId]` | GET | — | full build incl. diagnostics |
| `versions` | GET | — | `{ versions: [{ id, label, source, createdAt, fileCount }] }` newest 20 |
| `versions` | POST | `{ label? }` | `{ version }` manual snapshot (source "user") |
| `versions/[versionId]` | GET | — | `{ version: { id, label, source, createdAt, files: [{path, sizeBytes}] } }` |
| `versions/[versionId]/diff` | GET | — | `{ changed: [{path, action, patch}] }` vs current |
| `versions/[versionId]/restore` | POST | — | `{ restored: true, fileCount, config }` rate limit 10/60s |
| `deployments` | GET | — | `{ deployments: [...] }` newest 20 |
| `deployments/[deploymentId]/rollback` | POST | — | `{ deployment }` (§7) |
| `domains` | GET | — | `{ domains }` |
| `domains` | POST | `{ hostname }` | `{ domain }` (validation: hostname regex, ≤253 chars; unique) rate limit 10/60s |
| `domains/[domainId]` | DELETE | — | `{ deleted: true }` |
| `domains/[domainId]/verify` | POST | — | real DNS check (§7.3) → `{ domain }` |
| `activity` | GET | — | `{ activity: [{ id, kind, detail, createdAt }] }` |

**Modify** (additive, keep all existing response fields):
- `GET /api/giftz/sites/[id]` (route file exists): response gains
  `deployStatus`, `framework`, `description`, `fileSummary: { fileCount, totalBytes, lastUpdatedAt } | null`,
  `lastBuild: { id, status, createdAt, summary } | null`,
  `liveDeployment: { id, deployedAt } | null`.
- `GET /api/giftz/sites` (list): each summary gains `deployStatus`, `framework`, `hasFiles: boolean`.
- `POST /api/giftz/sites`: accept optional `description` (≤300) — keep rate limit.
- `PUT /api/giftz/sites/[id]`: keep existing behavior; after save run S1 sync
  (await it inline; response gains `fileSync: { ok, error?, generated, skippedUserFiles, removed }`).
  Also accept optional `description`.

## 5. PREVIEW + PUBLIC SERVING (routes, not lib)

### 5.1 `src/app/api/giftz/sites/[id]/preview/[...path]/route.ts`
- Auth: owner session REQUIRED.
- Resolves `path` (join catch-all segments; `constrainProjectPath`).
- Proposal overlay: `?proposalMessageId=<SiteStudioMessage id>` — load that
  message (must belong to a session owned by the user AND targetSiteId === id),
  parse `proposalJson.kind === "files"`, apply its `fileChanges` (content
  overrides / deletions) on top of the working tree for THIS request only.
- Serve file: text rows → `new NextResponse(content, { headers })`; base64
  rows → decode to Buffer.
- Headers: `Content-Type` from `mimeForPath` (+ charset utf-8 for text),
  `Cache-Control: no-store`, and **CSP**:
  `Content-Security-Policy: default-src 'none'; img-src * data: blob:; style-src * data: 'unsafe-inline'; font-src * data:; script-src * data: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors *`
  (websites can render/inline-interact but CANNOT fetch — real network
  restriction; documented honestly in the report). Plus
  `X-Content-Type-Options: nosniff`.
- 404 (plain text) for missing files. Directory-style requests (`path` ends
  with `/` or empty) resolve to that dir's `index.html` if present.

### 5.2 `src/app/api/giftz/sites/[id]/public/[...path]/route.ts`
- NO auth. Loads site; requires a `GiftzDeployment` with `status === "LIVE"`
  (newest). Serves from `deployment.filesJson` artifact with the same CSP +
  `Cache-Control: public, max-age=60`. Site not published/no LIVE deployment →
  404 JSON `{ error: "not-published" }`.
- This is the URL visitors hit: `/site/<username>/g/<siteId>` renders an
  iframe → `/api/giftz/sites/<id>/public/index.html`.

### 5.3 `SiteGiftzSiteView.tsx` extension (FRONTEND, Task 2-b)
When `GET /api/giftz/sites/:id/public` response contains
`deployment: { id }` (new optional field the public route returns; only when
file-based LIVE deployment exists), render instead of `<SiteRenderer>`:
```tsx
<iframe src={`/api/giftz/sites/${id}/public/index.html`} sandbox="allow-scripts allow-popups allow-forms"
  className="h-full w-full" title={`${title} — live website`} />
```
(plus keep loading skeleton + error states as-is). Keep SiteRenderer fallback
for legacy JSON-only published sites (no deployment).

## 6. FILE-LEVEL AGENTIC PIPELINE (Task 3-b)

`src/lib/giftz/project-agent.ts`:
- `runProjectTurn(params: { userId, site, request, sessionId, assistantMessageId, taskId })`
  called from `site-studio/turn.ts executeTurn` when the router picks file mode.
- **Router** `classifyProjectRequest(request, siteContext)`: ONE `aiComplete`
  call (temperature 0, JSON out `{ intent: "config" | "files", reason }`,
  system prompt explains: files = new pages/components/scripts/forms/route
  logic/build fixes/file ops; config = colors/fonts/text/layout/sections/
  content/design). On AI failure → deterministic default "config" (honest
  note in summary). Update message `metaJson.stage` along the way.
- **File pipeline**:
  1. Gather context: current tree (paths + sizes + source), current build
     diagnostics (last build), the full content of files likely relevant
     (include ALL text files ≤48KB each, total ≤ 220KB budget; base64 files
     only as path list).
  2. PLAN: `aiComplete` (thinking: true, AI_DEEP_TIMEOUT_MS) → JSON:
     `{ summary, files: [{ path, action: "create"|"modify"|"delete", instructions }] }`
     validated manually (zod schema `filePlanSchema`); ONE repair round on
     invalid output (reuse provider repair pattern from `src/lib/giftz/provider.ts`).
  3. EXECUTE: for each plan step (bounded ≤ 12 files, batched ≤ 4 files per
     AI call): `aiComplete` with current file contents + instructions → JSON
     `{ files: [{ path, content }] }` full-file writes. Deletes are executed
     WITHOUT AI (deterministic). Parse via `parseJsonFromText`; per-file
     `constrainProjectPath` + limits; write to an OVERLAY map (never directly
     to working tree).
  4. BUILD: run `runProjectBuild` against overlay+working tree (add param
     `overlay?: Map<string,string|null>` to runProjectBuild) → if errors,
     REPAIR: one AI round with diagnostics → overlay updates → rebuild (max
     2 repair rounds). If still failing → proposal kind "files" with
     `verification: { ok: false, diagnostics }` and honest summary (user can
     still preview/save or discard — never report success).
  5. PROPOSAL: persist on the assistant message `proposalJson`:
     ```json
     { "kind": "files", "summary": "...", "jobId": "<taskId>",
       "fileChanges": [{ "path": "...", "action": "modified|added|removed",
                         "content": "full new content (absent for removed)",
                         "encoding": "utf8", "summary": "per-file note" }],
       "planNotes": "...", "verification": { "ok": true, "summary": "12 checks passed" },
       "configSynced": false }
     ```
     If the AI also provided a complete `site.config.json` in overlay AND it
     passes normalizeConfig, include `config: SiteConfig` +
     `configSynced: true` (apply route will sync both).
  - Message status: DONE with proposal; FAILED with honest error + proposal
    preserved if partial. Follow existing turn.ts status/stage conventions
    (STAGE_LABELS gains "reading files", "writing files", "building" — add
    labels in ChatPanel).
- `POST files/apply-proposal` (§4) applies overlay to working tree with
  `source: "ai"`, syncs config if `configSynced`, creates version (source
  "ai"), activity `ai.edit`, and returns applied inventory.

## 7. PUBLISHING / DEPLOYMENT (Task 3-a)

### 7.1 `src/lib/giftz/project-deploy.ts`
- `publishGiftzSiteProject(user, site): Promise<PublishResult>`
  1. site must have files (compile happens on save; if NO files but config
     exists → run `syncGeneratedFiles` first; if still none → honest 400).
  2. `runProjectBuild(site, "publish")` → FAILED build → return
     `{ ok: false, stage: "build", buildId, diagnostics }` (route → 422 with
     diagnostics; site.deployStatus → "FAILED").
  3. Create `GiftzDeployment` status DEPLOYING (provider
     "bean-folio-hosting"), copy artifact filesJson, then status LIVE,
     `deployedAt`, `url = publicSiteGiftzPath(username, site.id)` path form
     (also compute absolute URL via `resolveShareOriginForRequest(headers)` —
     mirror `/api/me/site/publish` usage; store the PATH in `url`; absolute in
     route response only).
  4. Mark previous LIVE deployments → ROLLED_BACK? NO — previous LIVE stay
     "LIVE"?? Serving rule picks NEWEST LIVE → older LIVE rows are implicitly
     inactive; set their status to "ROLLED_BACK" ONLY via explicit rollback.
     Instead mark older LIVE rows as "SUPERSEDED"?? — keep vocabulary finite:
     on new LIVE, set older `status === "LIVE"` rows to "ROLLED_BACK" with
     error field noting "superseded by <newId>" (honest, keeps enum small).
  5. Update site: `deployStatus: "PUBLISHED"`, `publishedConfig` = current
     config (KEEP legacy field semantics for SiteRenderer fallback), `status:
     "PUBLISHED"`, `publishedAt` (keep first).
  6. Version snapshot source "publish" + activity `publish`.
- `rollbackDeployment(user, site, deploymentId)`: target must be LIVE or
  ROLLED_BACK-with-artifact → create NEW deployment LIVE copying target's
  artifact (label in error field "rollback of <id>"), current newest LIVE →
  ROLLED_BACK. deployStatus stays PUBLISHED. Activity + version (source
  "publish", label "Rollback to <ts>").
- `unpublish`: set newest LIVE → ROLLED_BACK ("unpublished"), deployStatus
  "DRAFT", site.status "DRAFT". Keep `publishedConfig` (legacy viewers)... NO —
  existing unpublish nulls it; PRESERVE existing unpublish behavior exactly,
  just add deployment state changes.
- `deploymentAdapterStatus()`: `{ configured: false, provider: "bean-folio-hosting",
  externalProviders: [], note: "External hosting adapters are not configured in this environment" }`
  returned in publish response + deployments GET (`adapter` field) — honest.

### 7.2 Publish route changes
`POST /api/giftz/sites/[id]/publish`: if site HAS project files → the NEW
pipeline above (response: existing fields PLUS `deployment: { id, status,
url, provider }`, `build: { id, status, summary }`, `adapter`). If no files
(legacy JSON-only) → existing behavior UNCHANGED. deployStatus transitions:
set "DEPLOYING" at start, "PUBLISHED" or "FAILED" at end — persist per stage
so UI sees honest intermediate states on error.

### 7.3 Domain verification
`verifyGiftzDomain(domain)`: real check via `node:dns` `promises.resolveCname`/
`resolve4`/`resolveTxt`: VERIFIED only if a TXT record
`bean-giftz-verification=<token>` exists OR the hostname resolves (A/CNAME)
to the currently-serving host (from `resolveShareOrigin` URL hostname).
Otherwise FAILED with real DNS error message in `lastError` (PENDING stays if
DNS lookup returns NXDOMAIN — that's "not found yet", status stays PENDING +
lastError explains). Never auto-VERIFIED. Response includes honest
`routingNote`: "DNS verified ≠ traffic routed; external proxy/DNS configuration is required and is not available in this environment."

## 8. FRONTEND (Task 2-b) — GIFTZ tab center area

GIFTZ mode center area gains a small tab strip ABOVE the existing toolbar row
(rendered ONLY in `mode === "giftz"`; styling identical to STUDIO_MODES
tablist): tabs `Preview | Code | Build` (local state `giftzCanvasTab`).
- **Preview tab**: EXACTLY the existing DeviceStage/preview block (unchanged
  DOM/behavior). Proposal overlay preview: when `proposalPreview` has
  `kind === "files"`, the Preview tab renders
  `<iframe src={`/api/giftz/sites/${giftzSite.id}/preview/index.html?proposalMessageId=${proposalPreview.messageId}&nonce=${previewNonce}`}
  sandbox="allow-scripts" className="h-full w-full rounded-lg border border-border/60 bg-background">`
  inside DeviceStage instead of the SiteRenderer children (keep device widths).
- **Code tab** (`src/components/bean/site/giftz/CodeWorkspace.tsx` NEW):
  file tree (left, 200px, grouped dirs, icons, source badge dot: generated
  gray / user gold / ai emerald) + editor (fills). Editor: use
  `react-syntax-highlighter` for the read-only rendered view and a
  monospace `<textarea>` overlay for editing (NO new deps; `Prism` oneDark
  theme already used in widgets.tsx). Toolbar: file path breadcrumb, Save
  (PUT files/content; Cmd/Ctrl+S), Revert (re-GET), New file (inline prompt
  dialog styled like existing dialogs), Rename, Delete (confirmation
  dialog), binary-file notice (no editor, download hint only), dirty dot.
  On save of `site.config.json` → also call `onConfigSynced(newConfig)` so
  WebsiteBuilderView updates its canvas config state.
- **Build tab** (`src/components/bean/site/giftz/BuildWorkspace.tsx` NEW):
  Run build button; latest build card (status, duration, checks run, summary);
  diagnostics list (error red / warning amber, path + message, monospace);
  build history list; **Deployment history** (id, status, provider, url chip,
  deployedAt, Rollback button on non-live LIVE rows); **Custom domains**
  section (add hostname, status badge, verify button, delete, honest
  routingNote text); **Activity feed** (latest 30, kind icon + relative time).
- Header integration (minimal, additive):
  - Generated-sites dropdown items: append `deployStatus` badge (PUBLISHED →
    green "live"; FAILED → red "build failed"; PREVIEW → amber "preview").
  - The publish review dialog (lines ~2821-2878) gains a build pre-check:
    before POST publish, if `fileSummary` exists → POST `/builds` first; show
    inline build diagnostics if FAILED and abort with honest message.
  - SaveControls: in giftz mode, after successful save also refresh files tree.
  - More-menu: add "Version history" item → dialog (NEW
    `GiftzVersionDialog.tsx`): list versions (label/source badge/created),
    Compare toggle (choose two → changed-files list with expandable unified
    patch, styled like legacy GiftzView DiffViewer colors), Restore button
    (confirmation; warns current unsaved draft replaced; calls restore then
    reloads site + files + config).
- **ChatPanel** (`studio/ChatPanel.tsx`): ProposalCard gains `kind === "files"`
  branch: file inventory from `fileChanges` (modified/added/removed chips +
  per-file summary), verification badge (ok → emerald "Build passed", fail →
  red "Build has errors"), footer text unchanged. "Preview changes" →
  `onPreviewProposal({ messageId, kind: "files" })`. STAGE_LABELS gains
  reading-files/writing-files/building. Composer unchanged.
- **WebsiteBuilderView state additions**: `giftzFilesSummary`,
  `giftzCanvasTab`, extend `ProposalPreview` type with `kind?: "config"|"files"`;
  SaveDraft handler: if proposalPreview.kind === "files" → POST apply-proposal
  then refresh (config may change → setGiftzSite config + canvas). Discard →
  clear (no server call). Keep all existing handlers/labels intact.

## 9. AGENT FILE OWNERSHIP MAP (concurrent edits forbidden across agents)

- Agent 2-a (backend core): `src/lib/giftz/project-{files,compiler,build,versions,activity}.ts`,
  routes: `files/*`, `preview/*`, `builds/*`, `versions/*`, `activity`,
  modifications to `api/giftz/sites/route.ts`, `api/giftz/sites/[id]/route.ts`.
- Agent 2-b (frontend): `WebsiteBuilderView.tsx`, `ChatPanel.tsx`,
  `SiteGiftzSiteView.tsx`, `components/bean/site/giftz/*`, `lib/giftz-client.ts`
  (add new functions; do not remove existing).
- Agent 3-a (backend publish): `src/lib/giftz/project-deploy.ts`,
  routes `publish`, `unpublish`, `deployments/*`, `domains/*`,
  `api/giftz/sites/[id]/public/*`. (Runs AFTER 2-a completes.)
- Agent 3-b (backend agent pipeline): `src/lib/giftz/project-agent.ts`,
  `src/lib/site-studio/turn.ts`, `files/apply-proposal` route. (Runs AFTER 2-a.)
- Task G (verification): tests under `tests/`, report only.

## 10. UI PRESERVATION CHECKLIST (verify at the end)

- [ ] `#/giftz` header: GIFTZ wordmark, Customization|GIFTZ tablist, sites
      dropdown, SaveControls, device switcher, undo/redo (customization only),
      Download code, More menu, live-address chip — all present & unchanged.
- [ ] Chat resize divider behavior unchanged; chat panel session management
      unchanged; composer (Edit site | From profile) unchanged.
- [ ] Preview tab renders the same DeviceStage + interactive canvas as before.
- [ ] Customization tab: ContentEditor + StudioRail unchanged.
- [ ] Mobile zone tabbar per-mode unchanged (GIFTZ: Chat | Preview).
- [ ] Publish dialogs (portfolio + giftz) keep their copy; only additive
      build/deploy info appended.
- [ ] `SiteGiftzSiteView` keeps its skeleton/empty/error states; iframe added
      only in the deployment branch.
- [ ] No changes to Discover/Explore/Folio/Create Studio/Settings/auth screens.
