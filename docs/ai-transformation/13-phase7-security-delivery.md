# Phase 7 delivery — production security hardening & operational readiness

Delivery record for Phase 7. The audit-first record is
`12-phase7-security-audit.md` (findings H1–H7, M1–M4, L1–L7); this document
records what was implemented, what was really executed (with exit codes and
counts), and what remains for an actual production deployment. Phases 3–6 are
preserved: the 336-test baseline grew to **369** (nothing removed), Prisma
model parity is now **40/40** (39 + the additive `RateLimitBucket`), tsc stays
at **0 errors**, and no approval gate, validator, or isolation control was
weakened. No Ollama, no destructive migration, no fabricated deployment
evidence — §8 states plainly what is NOT claimed.

---

## 1. Implemented controls (audit finding → implementation)

| Finding | Control | Where | Regression test |
|---|---|---|---|
| H1 | Enforced Content-Security-Policy (same-origin defaults; `frame-ancestors` deliberately omitted so the sandbox preview panel and the studio iframe keep working; `CSP_FRAME_ANCESTORS` env for production deployers; `CSP_ENABLED=0` escape hatch) | `next.config.ts` | live header check (§6) |
| H2 | AI private-context consent gate: `buildStructuredBannerBrief` and `prepareDelegation` include portfolio-derived private context (own projects incl. drafts, headline, professions, site-identity palette/typeface) ONLY when `User.aiConsent` — route-level `aiGate` remains the first gate, the builder gate is the defense-in-depth backstop. LAXII studio behavior unchanged (it never embedded portfolio context and still works without consent) | `src/lib/intelligence/delegation.ts` | `security-hardening.test.ts` §7 (2 tests: unconsented brief carries NO private context; consented brief does) |
| H3 | Startup environment validation — production requires `DATABASE_URL`; `SESSION_SECURE_COOKIES=false` in production is a hard error unless `BEAN_ALLOW_INSECURE_COOKIES=1`; unknown values of known variables are errors; partial S3 config is an error; dev warns only. Runs once via `src/instrumentation.ts`; exits non-zero. Never prints values — names only | `src/lib/startup-validation.ts`, `src/instrumentation.ts` | `security-hardening.test.ts` §5 (8 tests) + live boot evidence (§6) |
| H4 | Recovery-key rotation revokes EVERY session for the user (credential-rotation semantics), atomic with the key replace | `src/app/api/me/recovery-key/route.ts` | `security-hardening.test.ts` §3 |
| H5 | Cross-origin defense-in-depth: `validateOrigin` on POST/PATCH/PUT/DELETE inside `handler()` — cross-host Origin → 403; no-Origin (server clients) and embed-marked (CHIPS) requests pass; hostname comparison port-normalized, `x-forwarded-host` honored behind the gateway. **Production-build bug found and fixed — see §3** | `src/lib/api-helpers.ts` | `security-hardening.test.ts` §1 (9 tests) + live production 403 (§6) |
| H6 | Optional multi-instance rate limiting: `RATE_LIMIT_BACKEND=db` → fixed-window buckets in the additive `RateLimitBucket` table (atomic conditional UPDATEs, insert-race fallback, sampled lazy cleanup, fail-OPEN to in-memory on store outage). Default remains in-memory (single-instance deployment target). `rateLimit()` is now async — all call sites updated | `src/lib/api-helpers.ts`, both schema mirrors | `security-hardening.test.ts` §4 (3 tests incl. fail-open) |
| H7 | Self-describing scrypt hashes: new hashes `scrypt$N$r$p$salt:key`; legacy `salt:key` hashes verify forever against Node defaults (migration-compatible by construction); `SCRYPT_COST=hardened` (N=2^17, OWASP) opt-in; verification reads params FROM the stored hash with sanity bounds (floor = historical cost, ceiling within maxmem) so cost rotation never breaks existing accounts | `src/lib/auth.ts` | `security-hardening.test.ts` §2 (5 tests incl. legacy + hardened vectors) |
| M1 | Upload body-size precheck: 413 when `Content-Length` exceeds the largest per-kind cap + multipart overhead — BEFORE buffering; per-kind caps still enforced in `saveUpload()` after sniffing | `src/app/api/media/upload/route.ts` | `security-hardening.test.ts` §8 |
| M2 | Readiness probe distinct from liveness: `/api/health` stays process-up (liveness); `/api/ready` = DB `SELECT 1` + storage-driver probe (`probeStorage()` — S3 HeadObject 404-proves credentials, local mkdir-or-fail). Coarse responses name only the failing dependency | `src/app/api/ready/route.ts`, `src/lib/storage.ts` | live 200/503 semantics (§6) |
| M3 | Structured JSON-line logging (`log.debug/info/warn/error`, `LOG_LEVEL` gated, warn+ to stderr) with secret redaction on every string field (reuses the CODE GIFTZ redaction rules). Metadata-only by design — no bodies, prompts, tokens | `src/lib/logger.ts` | `security-hardening.test.ts` §6 |
| M4 | Error-monitoring hook: `reportError()` always emits a structured event; when `ERROR_WEBHOOK_URL` is set it POSTs the same redacted payload fire-and-forget (3 s timeout, failures swallowed). No external service required or claimed | `src/lib/monitoring.ts` | adopted in the `handler()` error path |
| §2.1 | CRITICAL live breakage fixed during the audit: `POST /api/media/upload` restored byte-identical from git history (`99ae27a` blob, diff-verified) + its 4-test wire-contract suite re-enabled (`tests/media-upload-route.test.ts`) | `src/app/api/media/upload/route.ts` | `media-upload-route.test.ts` (4 tests) |

Embedded-workflow preservation (audit §7): verified by the browser E2E (§6) —
first-party auth works, the studio and Giftz surfaces render, and no blanket
`frame-ancestors` / `X-Frame-Options` was introduced.

## 2. Dependency security — Prisma 7 advisory chain (audit L1)

- **Affected packages (verified via the advisory graph on the exact lockfile)**:
  `prisma` CLI 6.19.2 → `@prisma/config` 6.19.2 → `deepmerge-ts` 7.1.5
  (GHSA-ggr8-5vv4-36mx, high). Also eslint → minimatch (moderate ×16, dev lint only).
- **Production runtime NOT affected**: `@prisma/client` 6.19.2 ships zero
  runtime dependencies; the chain exists only in CLI/dev/build paths
  (`db push`, `generate`, `vercel-build`). Runtime advisories remain **zero**
  (sharp was fixed to 0.35.5 in Phase 6).
- **Upgrade-only-where-safe check**: no safe in-range upgrade exists — npm's
  only non-breaking "fix" is a downgrade to prisma 6.12.0 (loses 6.13–6.19
  fixes; rejected); the real fix is the Prisma 7/8 major migration (driver-
  adapter runtime model over a 39-model dual-mirror system — a dedicated data-
  layer phase, out of hardening scope).
- **Decision: accepted as documented dev-toolchain risk.** Database +
  application regression suites were run anyway (§7) — 369/0.

## 3. Production-build finding (new in Phase 7 — fixed and re-verified)

The Phase 6 build procedure was repeated this phase, and browser-level
verification against the standalone server surfaced a defect that unit tests
and dev-mode CANNOT catch:

- **Symptom**: cross-origin POST to a `handler()`-wrapped route returned 400
  (fell through to zod validation) in the production standalone build; the
  same request correctly returns 403 in dev and in the bun test suite.
- **Root cause (proven with a diagnostic route in the throwaway build copy)**:
  in the Turbopack production build `req instanceof NextRequest` is **false**
  — Next's runtime constructs requests with its own copy of the class
  (`constructor.name === "bound m"`), a different module instance than the
  imported `next/server` class. The `handler()` origin check was silently
  dead in production (fail-OPEN), and `file instanceof File` checks in the
  upload/resume routes were exposed to the same class-identity hazard
  (those fail closed — an availability risk, not a security hole).
- **Fix**: structural (duck-typed) checks — `headers.get` function + string
  `method` for requests (`handler()`), `arrayBuffer` function + numeric
  `size` for form values (`isFileLike()`), with the hazard documented at both
  sites. No behavior change in dev/tests; the check is now LIVE in all three
  environments.
- **Re-verification (real)**: rebuilt → cross-origin POST → **403
  "Cross-origin request rejected"**; same-origin and no-Origin POSTs pass to
  normal validation; production upload happy-path 200 / MIME-disguised 400 /
  unauthenticated 401 (§6). This finding is the concrete payoff of the
  "no production-ready claim without real production verification" rule.

## 4. Operational readiness

| Item | State | Evidence |
|---|---|---|
| DB backup | `scripts/ops/backup-db.ts` — SQLite `VACUUM INTO` snapshot + `PRAGMA integrity_check` + key-table row-count parity; Postgres `pg_dump --format=custom` + `pg_restore --list` verification; connection string never printed | rehearsal: exit 0, parity verified for User 20 / Project 14 / MediaAsset 38 / AgentTask 29 / AgentArtifact 10 / Session 23 (0.83 MB) |
| Restore rehearsal | `scripts/ops/restore-db.ts --from … --to /tmp/...` — restores to a TARGET FILE (live DB untouched without `--replace-live --yes`; refuses otherwise — verified refusal exit 1), integrity + parity verification on both artifacts | rehearsal: exit 0, restored integrity ok, all six key tables row-identical to source; live DB untouched |
| Media/artifact backup | `scripts/ops/backup-media.ts` — tar.gz of `uploads/` with file-count verification; GIFTZ workspaces deliberately excluded (reproducible from git baselines + task records); S3 deployments directed to provider-side versioning | rehearsal: exit 0, 638 files / 224.87 MB verified |
| Health/readiness | `/api/health` (liveness) + `/api/ready` (DB + storage) | standalone boot: both 200 |
| Structured logging | JSON lines, levels, redaction (§1 M3) | production standalone log shows `startup.env_validated` JSON events |
| Error monitoring | pluggable webhook sink (§1 M4) | code + redaction tests |
| Rollback procedure | documented: previous standalone release retained on host, DB rollback = backup restore, additive-only schema policy | `docs/deployment/production-deployment.md` §10 |
| Env validation at startup | fail-fast instrumentation (§1 H3) | live: production boot logged `startup.env_validated`, warned on SQLite-in-prod, and served traffic |

Log-content rule honored everywhere: no passwords, tokens, prompt contents,
or secret env values — string fields pass the GIFTZ secret-redaction rules
before output.

## 5. Deployment preparation

`docs/deployment/production-deployment.md` (new) documents the ACTUAL
architecture: topology (reverse proxy → standalone Node server), PostgreSQL
setup with the 40-table `initial-schema.sql` / additive delta + readiness
probe (`scripts/check-postgres-schema-readiness.ts`, updated for
`RateLimitBucket`), persistent media storage (local volume or private S3 —
partial S3 config is a startup error), session/cookie configuration table
(CHIPS embed mode incl. recovery-rotation invalidation), environment
variables (`.env.example` carries the annotated Phase 7 block), HTTPS
requirements (rightmost-XFF rule, Secure cookies, CSP/frame-ancestors
guidance), process startup, health-check matrix, backup schedule with
retention, restore/rollback steps, operational logging, and an explicit
deployment-authorization section. **No production migration or deployment was
executed — none is authorized from this repository alone.**

## 6. Verification actually executed (numbers + exit codes)

- **Full suite**: `bun test` → **369 pass / 0 fail**, 2,185 assertions, 23
  files, exit 0 (340 audit baseline + 29 `security-hardening.test.ts`; the
  baseline already included the 4 restored upload-contract tests). Re-run
  after the §3 fix: unchanged 369/0.
- **Targeted battery** (security-adjacent): giftz-api, giftz-engine,
  phase5-integration, intelligence-gateway, design-agent, auth, auth-routes,
  recovery, laxii-banner-phase3 → **163 pass / 0 fail**. These are the CODE
  GIFTZ isolation + LAXII/Phase 5 handoff regression suites required by the
  brief (isolation allowlist/redaction/confinement tests live in
  giftz-*; consent/handoff in intelligence-gateway + phase5-integration).
- **Lint**: `bun run lint` → 0 problems, exit 0.
- **TypeScript**: `bunx tsc --noEmit` → exit 0 (Phase 6 parity held).
- **Production build**: `bun run build` in an isolated copy (Phase 6
  procedure: dev server stopped, throwaway SQLite DB, throwaway directory) →
  **exit 0** (three times: pre-fix, diagnostic, post-fix), full route table
  incl. `/api/ready`.
- **Standalone server** (`NODE_ENV=production`, port 3100): `✓ Ready in
  109ms`; `GET /` → 200; `/api/health` → 200; `/api/ready` → 200
  `{"ok":true}`; production CSP header present on responses
  (`default-src 'self'; script-src 'self' 'unsafe-inline'; … object-src
  'none'; base-uri 'self'; form-action 'self'; frame-src 'self'`, no
  frame-ancestors by design) alongside `X-Content-Type-Options` and
  `Referrer-Policy`; no `X-Powered-By`.
- **Security headers/flows live in production build**: cross-origin POST →
  **403**; same-origin/no-Origin POSTs pass to normal validation; register →
  200; session cookie `HttpOnly` + `Secure` in production; upload happy path
  → 200 with the exact media contract; MIME-disguised text-as-png → 400
  "Unsupported or unrecognized file type" (magic bytes win); unauthenticated
  upload → 401; oversized `Content-Length` → 413 (suite).
- **Startup validation live**: production boot logged
  `{"level":"warn","event":"startup.env_warning",…SQLite…}` +
  `{"level":"info","event":"startup.env_validated","production":true,"warnings":1}`
  then served traffic; invalid-production cases are pinned by §5 tests
  (hard-exit path is `process.exit(1)` — deliberately not exercised against
  the live server).
- **Backup/restore rehearsal**: real execution, exit codes + row parity in
  §4; destructive-overwrite guard refusal verified (exit 1).
- **Browser E2E (authentication, agent-browser against the dev server)**:
  register → "Account created" + recovery-key modal (key displayed exactly
  once, checkbox gate, continue) → onboarding → signed-in navigation →
  reload keeps the session (cookie persists) → LAXII studio renders (banner
  composer) → Code Giftz renders (repositories) → Sign out → Sign in again →
  signed-in state restored. No page errors after fresh loads; mobile 390×844
  has no horizontal overflow; footer behavior unchanged. Screenshots:
  `/tmp/p7-e2e-1-dashboard.png`, `/tmp/p7-e2e-2-laxii.png`,
  `/tmp/p7-e2e-3-giftz.png`.
- **Schema**: `RateLimitBucket` added to BOTH mirrors; `prisma validate`
  clean on both (postgres mirror validated with a placeholder URL — the
  datasource is env-driven); live SQLite DB has 40 tables incl.
  `RateLimitBucket`; `initial-schema.sql` + `additive-schema.sql`
  regenerated (40-table DDL / CREATE-only delta); readiness probe updated to
  40 tables + indexes/FKs. `db push` clean, no destructive migration.
- **A stale-console scare, resolved honestly**: the browser console showed a
  parse error for `src/app/api/auth/me/route.ts:10`. Ground-truth checks
  (git diff, `sed -n 10p | cat -A`, md5) proved the on-disk file is the
  balanced Phase 7 version; a fresh reload with a cleared console produces
  zero errors and `/api/auth/me` → 200. The lines were stale Turbopack
  history from a same-minute botch-and-fix in the prior session, kept alive
  in the console buffer — recorded here because "errors seen and explained"
  belongs in an honest delivery.

## 7. Files touched (Phase 7)

New: `src/instrumentation.ts`, `src/lib/startup-validation.ts`,
`src/lib/logger.ts`, `src/lib/monitoring.ts`, `src/app/api/ready/route.ts`,
`src/app/api/media/upload/route.ts` (restored), `scripts/ops/{backup-db,
restore-db,backup-media}.ts`, `tests/security-hardening.test.ts`,
`tests/media-upload-route.test.ts` (re-enabled),
`docs/deployment/production-deployment.md`,
`docs/ai-transformation/12-phase7-security-audit.md` (audit), this document.
Modified: `next.config.ts` (CSP), `src/lib/api-helpers.ts` (origin validation,
async shared limiter, logger/monitoring wiring, §3 fixes),
`src/lib/auth.ts` (scrypt format), `src/lib/storage.ts` (probeStorage),
`src/lib/intelligence/delegation.ts` (H2), `src/app/api/me/recovery-key/
route.ts` (H4), `src/app/api/laxii/resume/parse/route.ts` (§3),
both `prisma/schema*.prisma`, `scripts/check-postgres-schema-readiness.ts`,
`docs/deployment/*.sql`, `.env.example`, and the mechanical
`await rateLimit(...)` update across route files.

## 8. Residual risks, accepted risks, and what is NOT claimed

- **Accepted dev-toolchain advisories (documented, monitored)**: prisma CLI →
  deepmerge-ts (high ×3) and eslint → minimatch (moderate ×16). Zero runtime
  exposure. The Prisma 7/8 major migration is the real fix and needs its own
  dedicated phase over the dual-mirror data layer.
- **In-memory rate limiting remains the default** — correct for the
  documented single-instance deployment; `RATE_LIMIT_BACKEND=db` exists for
  multi-instance and is tested, but a multi-instance deployment has not been
  exercised end-to-end.
- **`unsafe-inline` scripts in CSP** is the documented Next.js App Router
  requirement without a nonce infrastructure; noted for a future nonce-based
  tightening.
- **`frame-ancestors` intentionally unset by default** (embed preservation);
  production deployers MUST set `CSP_FRAME_ANCESTORS` once their embedding
  story is fixed — stated in the deployment doc.
- **No password-change flow** (L4), **no sliding session renewal** (L5),
  **RIISHE delegation briefs persist bounded private excerpts in
  owner-scoped AgentTask rows** (L6) — carried from the audit as documented
  product/data-minimization gaps for a future phase.
- **NOT claimed**: production readiness beyond the evidence above. No
  production host was deployed to; no production migration was run; the
  deployment doc is a procedure, not evidence. An owner must perform §12 of
  the deployment doc (provision, apply schema, configure, smoke-test on the
  real host) before any production-ready claim. The startup hard-exit path
  (`process.exit(1)`) is test-pinned, not live-exercised.

## 9. Conclusion

Phase 7 implemented every audit work item (H1–H7, M1–M4; L-items accepted
with documentation or recorded as future gaps), hardened the operational
story (backup/restore rehearsals with real exit codes, readiness probes,
structured redacted logging, monitoring seam, fail-fast env validation),
documented the full deployment configuration, and verified everything with
real executions — including the production-build class-identity defect that
only real production verification could catch, now fixed and re-proven.
Phases 3–6 preserved (369/0, lint 0, tsc 0, parity 40/40); embedded
authentication and the studio workflows verified intact in the browser.
