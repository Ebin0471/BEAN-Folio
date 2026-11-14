# Task 3-a (backend publish/deployment/domains) — GIFTZ standalone platform — Work Record

Agent: 3-a (publishing / deployment / domains / public file-serving). Contract:
`CONTRACT.md` §5.2, §7, §5.3 backend half. Ran AFTER 2-a (consumed its lib
signatures) and alongside 2-b/3-b (their files untouched).

Scope honored: ownership (`getSessionUser` + `findFirst({ id, userId })`) on
every authenticated route; the ONLY unauthenticated route is the public file
serving; no fabricated build/deploy/DNS results anywhere; additive changes
only to existing routes; TypeScript strict.

---

## 1. Files created

| File | Purpose |
|---|---|
| `src/lib/giftz/project-deploy.ts` | Publishing pipeline (§7.1): `publishGiftzSiteProject(user, site, headers)`, `rollbackDeployment(user, site, deploymentId)`, `unpublishGiftzSiteProject(user, site)`, `deploymentAdapterStatus()`, `serializeDeployment(row)`, `DeployUser`/`PublishResult`/`RollbackResult`/`SerializedDeployment` types, `DEPLOYMENT_PROVIDER = "bean-folio-hosting"`. |
| `src/lib/giftz/project-domains.ts` | Domains (§7.3): `validateHostname` (lowercase-trim + `HOSTNAME_RE` + ≤253 total + ≤63/label), `newVerificationToken()` (32-hex), `verifyGiftzDomain(domain, userId)` — REAL DNS via `node:dns` `promises.Resolver({ timeout: 5000, tries: 2 })` (resolveTxt / resolveCname / resolve4), `serializeDomain`, `DOMAIN_ROUTING_NOTE`. |
| `src/app/api/giftz/sites/[id]/deployments/route.ts` | GET newest 20 + honest `adapter`. |
| `src/app/api/giftz/sites/[id]/deployments/[deploymentId]/rollback/route.ts` | POST, rate limit `giftz-rollback:<userId>` 10/60s, `maxDuration 120`. |
| `src/app/api/giftz/sites/[id]/domains/route.ts` | GET list (createdAt desc) / POST add (rate limit `giftz-domain:<userId>` 10/60s, friendly 409 on taken hostname). |
| `src/app/api/giftz/sites/[id]/domains/[domainId]/route.ts` | DELETE (owner-scoped through the site). |
| `src/app/api/giftz/sites/[id]/domains/[domainId]/verify/route.ts` | POST real DNS check (rate limit `giftz-domain-verify:<userId>` 10/60s), response carries `routingNote`. |
| `src/app/api/giftz/sites/[id]/public/[...path]/route.ts` | §5.2 public artifact serving (NO auth). |

## 2. Files modified (additive — every existing field/behavior preserved)

| File | Change |
|---|---|
| `src/app/api/giftz/sites/[id]/publish/route.ts` | Branches on `db.giftzProjectFile.count({ where: { siteId } }) > 0`. NO files → the ORIGINAL body byte-for-byte (normalizeConfig → 400 honest message / media IDOR guard → status PUBLISHED + publishedConfig + publishedAt keep-first → `{ status, publishedAt, publicPath }`). WITH files → new pipeline; response = existing fields PLUS `deployment { id, status, url, provider }`, `canonicalUrl/canonicalKind/canonicalUrlUnavailable` (absolute URL is response-only, from `resolveShareOriginForRequest(headers)` — same VERIFIED-origin policy as `/api/me/site/publish`), `build { id, status, summary }`, `adapter`. Build-gate failure → 422 `{ error, stage: "build", buildId, build: SerializedBuild, diagnostics }`. `maxDuration = 300`. Rate limit `giftz-publish:<userId>` 10/60s applied to the NEW branch only (legacy branch had none before → none now, see deviations). |
| `src/app/api/giftz/sites/[id]/unpublish/route.ts` | Existing update kept; `deployStatus: "DRAFT"` added to the same write; then `unpublishGiftzSiteProject` (LIVE deployments → ROLLED_BACK "unpublished" + activity). Response unchanged `{ status: "DRAFT", publishedAt: null }`. |
| `src/app/api/giftz/sites/[id]/route.ts` | GET `liveDeployment` now `{ id, deployedAt, status }` (field names kept, `status` added). |
| `src/app/api/giftz/sites/[id]/public/route.ts` | Additive `deployment: { id, deployedAt } | null` (newest status LIVE) — §5.3; all existing fields untouched. |

## 3. Pipeline semantics (§7.1 exactly)

`publishGiftzSiteProject`:
1. **File gate** — 0 files + config → `syncGeneratedFiles(user.id, site.id)` first; still 0 → honest 400 (`stage: "files"`).
2. `deployStatus → DEPLOYING` persisted BEFORE the build (honest intermediate state).
3. **Build gate** — `runProjectBuild(site, "publish")` (trigger "publish" leaves deployStatus alone per 2-a). FAILED → `deployStatus FAILED` + activity + `{ ok:false, stage:"build", status:422, buildId, build, diagnostics }` → route 422. NO deployment.
4. Artifact validated (`build.artifactJson` must parse to a non-empty files array); missing → honest 500 `stage:"deploy"` + `deployStatus FAILED` (never fabricate).
5. `GiftzDeployment` DEPLOYING (buildId + artifact copied verbatim into `filesJson`) → older `status==="LIVE"` rows → ROLLED_BACK with `error: "superseded by <newId>"` → row becomes LIVE with `deployedAt` and `url = publicSiteGiftzPath(username, siteId)` (PATH form; null when no claimed username — response `canonicalUrl` then honestly null too).
6. Site: `deployStatus PUBLISHED`, `status PUBLISHED`, `publishedConfig = JSON.stringify(normalizeConfig(site.config))` (legacy semantics; left untouched when config is missing/invalid so the SiteRenderer fallback never gets something worse), `publishedAt` keeps first.
7. `snapshotProjectVersion(..., "Publish <ISO>", "publish")` (never pruned) + activity **`deploy`** (deploymentId, buildId, status, provider, url) + activity **`publish`** (ok, ids, url, files count).
8. Crashes inside 4–6: created deployment row → FAILED with the real error (no dangling DEPLOYING), site `deployStatus FAILED`, activity deploy ok:false, honest 500 result.

`rollbackDeployment`: target must be LIVE or ROLLED_BACK **with** `filesJson` (else 404 / honest 400 naming the status / 400 "no stored artifact"). Copies the artifact into a NEW deployment (`error: "rollback of <id>"` label, buildId preserved) → supersedes current LIVE rows (`"superseded by <newId>"`) → LIVE (deployedAt, url = target.url recomputed if absent). deployStatus stays PUBLISHED (set only when it wasn't — monotonic fix); site.status/publishedAt/publishedConfig restored ONLY when missing (publishedConfig derived from the artifact's own site.config.json via normalizeConfig — honest source, null when absent). `snapshotProjectVersion(..., "Rollback to <target deployedAt ISO>", "publish")` + activity `deploy { rollbackOf }`. Working tree untouched.

`unpublishGiftzSiteProject`: `updateMany(LIVE → ROLLED_BACK, error "unpublished")` + one activity when count > 0.

`deploymentAdapterStatus()`: `{ configured: false, provider: "bean-folio-hosting", externalProviders: [], note: "External hosting adapters are not configured in this environment" }`.

## 4. Exact response JSON shapes

- `GET deployments` → `{ deployments: [{ id, buildId, status, provider, url, error, deployedAt, createdAt }] }` (newest 20, ISO strings) + `adapter: { configured: false, provider, externalProviders: [], note }`.
- `POST deployments/[deploymentId]/rollback` → `{ deployment: <same shape> }`; errors: 404 `{ error }`, 400 `{ error }` (non-restorable status / no artifact), 500 `{ error }`.
- `GET domains` → `{ domains: [{ id, hostname, status, verificationToken, verifiedAt, lastError, createdAt }] }` (createdAt desc).
- `POST domains` `{ hostname }` → `{ domain: <same shape> }` (201-free, 200); 400 honest validation message; **409** `{ error }` — taken by another site or already on this site (message distinguishes); rate limit 10/60s. The TXT record to create is `bean-giftz-verification=<verificationToken>`.
- `DELETE domains/[domainId]` → `{ deleted: true }`; foreign site/domain → 404.
- `POST domains/[domainId]/verify` → `{ domain, routingNote: "DNS verified ≠ traffic routed; external proxy/DNS configuration is required and is not available in this environment." }` always; outcomes: **VERIFIED** (status VERIFIED, verifiedAt set, lastError null, method recorded in activity as txt|address) / **PENDING** (NXDOMAIN → "does not exist yet…", transient DNS error → real code/message, or records-exist-but-no-serving-host-configured → honest explanation) / **FAILED** (records exist, none match: no verification TXT AND no A/CNAME to the serving host). Re-verifying a VERIFIED domain that now fails flips status honestly and clears verifiedAt.
- `GET /public/[...path]` → raw artifact body; headers `Content-Type` (+`; charset=utf-8` for text), **`Cache-Control: public, max-age=60`**, `Content-Security-Policy` = PREVIEW_CSP (`connect-src 'none'` sandboxing model, same string as preview-serve), `X-Content-Type-Options: nosniff`; directory-style/extensionless → `<path>/index.html`; missing file inside a live deployment → plain-text 404 (no-store); no LIVE deployment / deleted owner / unparsed artifact → 404 JSON `{ error: "not-published" }` (no-store).
- `GET /public` (JSON, extended) → existing `{ site: { id, title, config, publishedAt }, owner: { username, name } }` PLUS `deployment: { id, deployedAt } | null`.
- `POST publish` (files branch) → `{ status: "PUBLISHED", publishedAt, publicPath, deployment: { id, status, url, provider }, canonicalUrl, canonicalKind, canonicalUrlUnavailable: { reason, message } | null, build: { id, status, summary }, adapter: { configured, provider, externalProviders, note } }`. Build failure → 422 `{ error, stage: "build", buildId, build, diagnostics }`.
- `GET sites/[id]` → `liveDeployment: { id, deployedAt, status } | null`.
- `POST unpublish` → `{ status: "DRAFT", publishedAt: null }` (unchanged).

## 5. Legacy (no-files) publish path preservation

The legacy branch is the ORIGINAL handler body, unchanged: same config normalize + same 400 message, same media IDOR guard, same site update, same response fields `{ status, publishedAt, publicPath }`. No rate limit existed there before → none added there. deployStatus is not written by the legacy branch.

## 6. Verification

- `bun run lint` → **0 errors, 13 warnings** — all pre-existing baseline (scripts/loadtest/k6/*, PostComments, PostComposer, PostMediaView, VideoCard, PostDetailView). Zero findings in any file I created/modified.
- `bunx tsc --noEmit | grep -E "project-deploy|deployments|domains|public"` → **clean (0 lines)**. Broader filter `project-deploy|project-domains|src/app/api/giftz` → also clean. (Remaining repo tsc errors are the pre-existing `scripts/`, `portfolio` and `tests/` clusters — verification-task baseline.)
- dev.log: compiles clean (only the pre-existing `src/instrumentation.ts` Edge-Runtime warnings); giftz routes serving 200s.
- Not run (per instructions): `bun test`, manual dev-server publishing flow.

## 7. Contract deviations / notes

1. **`src/lib/giftz/project-domains.ts` (extra lib file)** — §7.3 names `verifyGiftzDomain(domain)` as a function; route files cannot share helpers cleanly, so validation + serialization + the DNS check live in a lib module (same pattern as 2-a's `preview-serve.ts`). Routes stay thin.
2. **Publish rate limit scope** — the task said "Keep rate limit" but the existing giftz publish route had none; to keep the legacy path byte-identical, the limit (`giftz-publish:` 10/60s) guards only the NEW file-pipeline branch.
3. **DNS resolver** — uses `dns.promises.Resolver({ timeout: 5000, tries: 2 })` so a dead DNS resolver can never hang the request; ENOTFOUND → "not found yet" (PENDING), ENODATA → "no records of that type" (no-match evidence), anything else → PENDING with the real error string. Serving host for A/CNAME comes ONLY from `resolveShareOrigin()` (deployment configuration) — request headers never trusted; when no production origin is configured, A/CNAME comparison is impossible and that is stated verbatim in lastError (PENDING, not FAILED — the domain is not proven wrong).
4. **Rollback side-state** — contract says "deployStatus stays PUBLISHED"; additionally, when the site was left non-PUBLISHED (e.g. after a FAILED publish or an unpublish), rollback restores `status/publishedAt/publishedConfig` (config extracted + normalized from the rolled-back-to artifact) so the LIVE deployment and the site state can never contradict each other. Normal published operation is unaffected.
5. **Rollback version snapshot** — per contract, `snapshotProjectVersion(..., "Rollback to <ts>", "publish")` snapshots the CURRENT working tree (rollback never modifies it); the row records when/what was rolled back, source "publish" (unprunable).
6. **Deployment `url` may be null** — when the owner has no claimed username, `publicSiteGiftzPath` returns null and the deployment stores null (`canonicalUrl` likewise null with `canonicalUrlUnavailable` explaining). Honest; serving via the API public path still works.
7. **Domain delete has no activity row** — the schema's kind vocabulary lists `domain.add`/`domain.verify` but no `domain.delete`; inventing a kind would break the documented feed contract, so delete is silent (the row is gone).
8. **Public JSON `deployment` shape** — task instruction (`{ id, deployedAt }`) is authoritative over §5.3's `{ id }`; 2-b's `deployment?: { id }` type is satisfied either way.
