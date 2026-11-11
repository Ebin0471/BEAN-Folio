# Phase 7 audit — production security hardening & operational readiness

Audit-first record (no Phase 7 hardening code was changed before this document,
with one exception documented in §2.1: a lost route restored from git — a live
breakage, not a hardening change). Sources read: Phase 6 audit + delivery
(`10-phase6-production-readiness-audit.md`, `11-phase6-production-readiness-delivery.md`),
Phase 3–5 delivery reports (`05`, `07`, `07a`, `08`, `09`), `worklog.md` through
Task 37, `src/lib/auth.ts`, `src/lib/recovery.ts`, `src/lib/session.tsx`,
`src/lib/client.ts`, `src/lib/admin.ts`, `src/lib/api-helpers.ts`, `src/lib/media.ts`,
`src/lib/storage.ts`, `src/lib/giftz/{commands,workspace,jobs,plan,diff,redact}.ts`,
`src/lib/intelligence/{artifacts,handoff,gateway,context,delegation}.ts`,
`src/lib/laxii/design-brief.ts`, `src/lib/ai.ts`, `next.config.ts`, `Caddyfile`,
`.env.example`, `package.json` + lockfile, the full API route inventory
(106 tracked route files), and the advisory graph via `npm audit` on a
lockfile generated in an isolated directory.

---

## 1. Verified baseline (before any Phase 7 change)

| Check | Result |
|---|---|
| `bun test` | **340 pass / 0 fail** (22 files, 2,117 assertions) — 336 Phase-6 baseline + 4 (see §2.1) |
| `bun run lint` | 0 problems (exit 0) |
| Advisories | 19 (16 moderate / 3 high) — unchanged from Phase 6 end state |
| Prisma (lockfile) | `prisma` / `@prisma/client` 6.19.2 |
| Schema mirrors | 39 / 39 models (Phase 6 parity held) |
| Git tree | clean at `49fbd6f`; `src/app/api/media/upload/` ABSENT from HEAD |

## 2. Live-breakage finding (restored during audit)

### 2.1 CRITICAL — `POST /api/media/upload` missing from HEAD

`src/lib/client.ts` `uploadFile()` posts to `/api/media/upload`; **no route file
existed at HEAD** (`git ls-tree HEAD src/app/api/media` contains only `[id]/`).
Every upload surface (avatar, cover/banner, project gallery, LAXII references,
Giftz materials) falls through to `/api/media/[id]` (no POST export) → 405.
`worklog.md` records this file being deleted by automated snapshot commits
(d418f2f, 31bd03d, d64d402) and restored repeatedly — it was lost again after
the last restore.

**Action taken during the audit (not a hardening change)**: restored the route
byte-identical from git history (`99ae27a` blob, verified with `diff`), and
re-enabled its regression suite `tests/media-upload-route.test.ts.disabled` →
`tests/media-upload-route.test.ts` (4 tests pinning the wire contract: 401 / 400
no-file / 200 happy path / 400 garbage-nothing-stored). This is the +4 delta on
the baseline above. The route itself already carries the security-relevant
contract: session-gated, per-user rate limit (30/h), `UploadError` mapping,
validation in `saveUpload()` (client MIME never trusted).

## 3. Security posture — verified strong (evidence cited)

Controls confirmed by code reading + targeted suites; a passing suite is NOT
treated as proof on its own.

- **Passwords**: scrypt (Node defaults N=16384, r=8, p=1, 64-byte key),
  per-user 16-byte random salt, length-guarded `timingSafeEqual` compare
  (`auth.ts:19-32`). Min length 8 / max 200 at the zod boundary.
- **Sessions**: 256-bit opaque tokens, stored ONLY as SHA-256 (`Session.token`),
  30-day TTL, lazy expiry deletion, soft-deleted users rejected. Cookie
  `bean_session`; first-party `HttpOnly; SameSite=Lax; Secure (prod)`;
  embedded clients (`X-Bean-Embed: 1`, set by `client.ts` only when
  `window.self !== window.top`) get `SameSite=None; Secure; Partitioned`
  (CHIPS) — a cross-site attacker document cannot read or send the
  partitioned cookie.
- **Session/token invalidation**: logout revokes the current row; password
  reset (recovery flow) revokes ALL sessions in the same transaction as the
  password replace; account deletion revokes all sessions.
- **Recovery**: 125-bit Crockford keys, stored as SHA-256 of the normalized
  key only, timing-safe digest compare, plaintext shown exactly once; reset
  tokens 256-bit, SHA-256 at rest, 15-min TTL, single-use with a race-safe
  conditional `updateMany`; recover/request rate-limited 5/h per IP AND per
  email with timing-equalized dummy hash; no email provider — token returned
  only to the client that proved recovery-key possession.
- **Authorization**: every agent/artifact/media/giftz route is userId-scoped
  with 404-indistinguishable refusals (Phase 5 suite asserts cross-user
  refusals); admin routes require `role === "ADMIN"`.
- **Uploads**: magic-byte sniffing (client MIME never trusted), per-kind caps
  (IMAGE 8 MB / VIDEO 64 MB / AUDIO 20 MB / DOCUMENT 10 MB), full-buffer
  re-sniff + no-NUL/UTF-8 validation for text, zero-byte rejection, storage
  keys `uploads/<owner>/<time><random>.<ext>` (owner + ext sanitized),
  `resolveLocalPath` traversal guard, documents served `attachment`, media
  served `inline` + `nosniff` + `Cache-Control: private`.
- **CODE GIFTZ isolation**: workspace dirs derived from DB row ids only
  (regex-validated `[a-zA-Z0-9_-]{10,64}`), per-operation path confinement
  incl. ancestor symlink walk (`constrainWorkspacePath`), secret-path refusal
  (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `.npmrc`, `.netrc`),
  command allowlist (`bun`/`bunx`/`node`; `bun test` plain-path patterns,
  `bun run` only scripts read server-side from the workspace package.json,
  `bunx tsc`/`bunx eslint` flag-style, `node --version`), argv-only
  `shell:false`, `minimalEnv()` scrub (test-asserted: no `DATABASE_URL`,
  no provider keys), 120 s hard SIGKILL, 64 KB output caps with 6-rule
  secret redaction before storage, per-task kill registry + cooperative
  cancel flags, git baseline + path-exact revert, plan-scoped writes with
  asset bytes only ever from APPROVED artifacts (`readArtifactBytes`).
- **Artifacts**: ownership re-verified at every touch, MIME allowlist
  (png/jpeg/webp), 10 MB cap, 24 h TTL with honest EXPIRED/MISSING
  degradation, single-shot consumption keyed by destination task
  (retry-of-same-destination idempotent, other consumers 409).
- **Handoffs**: owner-only approval from `AWAITING_APPROVAL` only,
  `requiredCreates` enforced at planning (`missing-asset-declaration`),
  duplicate-active-per-media prevention, cancel kills child processes.
- **AI consent & quotas**: `aiGate` = `User.aiConsent` 403 + burst 6/min +
  30/day UTC-metered `AiUsage`; applied on all RIISHE/design/giftz/handoff
  AI routes; LAXII runs its own regime (burst 6/min, 80 images/day, $5/day
  gateway cost cap) — see finding H2 for the consent nuance.
- **Logging/redaction**: command output and agent-captured text pass
  `redactText()` (bearer/basic, secret key-values, PEM blocks, AWS ids,
  40+-hex tokens, URL credentials); API errors map to generic 500s without
  internals; gateway observability logs metadata only (never prompts).
- **Server hardening already present**: `poweredByHeader: false`,
  `X-Content-Type-Options: nosniff` + `Referrer-Policy` on all paths,
  rightmost-XFF rate-limit keys behind the single Caddy hop
  (`X-Forwarded-For {remote_host}`).

## 4. Findings (severity-ranked; each becomes work or an accepted risk)

### HIGH

- **H1 — No Content-Security-Policy** (carried from Phase 6 L1; only
  nosniff + Referrer-Policy exist). Work: enforced CSP with production-safe
  directives; `frame-ancestors` intentionally configurable — see the
  constraint in H1a.
  - **H1a constraint**: the sandbox preview panel frames the app
    cross-origin, and the Website-Studio preview iframe is same-origin. A
    blanket `frame-ancestors 'self'` (or `X-Frame-Options: SAMEORIGIN`)
    would break the preview-panel embed the task forbids breaking. Work:
    default CSP omits frame-ancestors; `CSP_FRAME_ANCESTORS` env allows a
    production deployer to set it explicitly (documented in the deployment
    doc).
- **H2 — AI private-context consent asymmetry (LAXII)**: LAXII generation
  routes do not check `User.aiConsent` (by design — the studio has its own
  quotas and no consent UI; forcing the gate would change Phase 3 behavior).
  BUT the structured brief enrichment embeds PRIVATE portfolio context
  (up to 10 projects incl. drafts, 500-char descriptions; own SiteDesign
  palette) into prompts sent to the external managed gateway. Work: keep the
  studio open (no behavior break), but include portfolio-derived private
  context in LAXII briefs ONLY when the user has enabled BEAN Intelligence
  (`aiConsent=true`); otherwise the brief is built from the user's explicit
  request alone. This makes the consent flag govern exactly the
  private-data-to-external-model path without breaking the studio.
- **H3 — No startup environment validation** (missing/typo'd env fails lazily
  at first use; `SESSION_SECURE_COOKIES=false` silently permits non-TLS
  cookies in production — Phase 6 L3). Work: `instrumentation.ts` startup
  validation: production requires `DATABASE_URL`; production +
  `SESSION_SECURE_COOKIES=false` is a hard error unless
  `BEAN_ALLOW_INSECURE_COOKIES=1` (explicit escape hatch for plain-HTTP
  LAN/self-host, documented); non-Postgres + S3-driver mismatch warning;
  process exits non-zero on hard errors.
- **H4 — Recovery-key rotation does not revoke sessions**: the recovery key
  is a credential; rotating it (or being rotated after suspected compromise)
  leaves existing sessions alive. Work: rotate → revoke all sessions for the
  user (they re-authenticate with the fresh password; consistent with
  password-reset semantics).
- **H5 — No cross-origin (CSRF) defense-in-depth**: protection today is
  SameSite cookies only (Lax first-party; None+Partitioned embeds).
  SameSite=Lax already blocks cross-site POSTs carrying first-party cookies,
  and CHIPS partitions embed cookies per top-level site, but there is no
  explicit Origin validation to catch browser/regression edge cases. Work:
  `handler()` validates `Origin` on state-changing methods (POST/PATCH/PUT/
  DELETE): requests without Origin (non-browser clients) pass; embed-marked
  requests pass (partitioned cookies are not cross-site usable by
  construction); a present-but-mismatched Origin is rejected 403. No CORS
  surface exists to regress (none is served today).
- **H6 — Rate limiting is in-process** (Phase 6 M1): resets on restart;
  unbounded per-instance counts under horizontal scaling. Work: optional
  DB-backed fixed-window limiter (`RATE_LIMIT_BACKEND=db`) using an additive
  `RateLimitBucket` table (both schema mirrors); in-memory remains the
  default for the single-instance deployment; DB path exercised by tests.
- **H7 — scrypt cost parameters are Node defaults and unstored** (Phase 6
  L2): the stored format `salt:key` encodes no parameters, so any future cost
  change would break verification of existing hashes. Work: extend new hashes
  to a parameterized format `scrypt$N$r$p$salt$key` while keeping the legacy
  format verifiable forever (migration-compatible); `SCRYPT_COST=hardened`
  opt-in (N=2^17) for production deployments; default `standard` = today's
  values (zero behavior change).

### MEDIUM

- **M1 — Upload size enforced only after full buffering**: caps are applied
  in `saveUpload()` after `req.formData()` has buffered the whole body; a
  10 GB body would consume memory/bandwidth before rejection. Work: early
  `Content-Length` rejection in the upload route (strictly above the largest
  per-kind cap + multipart overhead).
- **M2 — No readiness-vs-liveness distinction**: `/api/health` is static
  (process-up only). Work: keep `/api/health` as liveness; add `/api/ready`
  (DB `SELECT 1` + storage root probe, no internal details in responses).
- **M3 — Unstructured operational logging**: ad-hoc `console.error` across
  modules (acceptable content-wise: messages/ids only — a call-site audit
  found no request-body/token/prompt logging), but not machine-parseable and
  without levels. Work: JSON-line logger with levels + redaction integration,
  adopted in the API error path and monitoring hook; no behavior change.
- **M4 — No error-monitoring hook**: failures are visible only in server
  logs. Work: pluggable sink (`ERROR_WEBHOOK_URL`, optional, fire-and-forget,
  redacted payloads) + always-on structured event; no external service
  claimed or required.

### LOW / accepted-with-documentation

- **L1 — Prisma advisory chain (deepmerge-ts GHSA-ggr8-5vv4-36mx, high ×3)**:
  verified affected packages = `prisma` CLI → `@prisma/config` 6.19.2 →
  `deepmerge-ts` 7.1.5 (pinned exact). **Production runtime is NOT affected**:
  `@prisma/client` 6.19.2 ships ZERO runtime dependencies — the chain exists
  only in CLI/dev/build paths (`db push`, `generate`, `vercel-build`). Fix
  landscape verified against the registry: `@prisma/config` ≤7.10.x is in the
  advisory range and pins deepmerge-ts <8; config 7.10.1+ uses deepmerge-ts
  8.0.2 (fixed), but no `prisma` release maps to it (latest 7.x = 7.10.1,
  latest 6.x = 6.19.3 — both in range); npm's only "non-breaking fix" is a
  **downgrade to prisma 6.12.0** (rejected in Phase 6 — loses 6.13–6.19
  fixes); the real fix requires the Prisma 7/8 major migration (driver-
  adapter runtime model — a data-layer migration of a 39-model, dual-mirror
  system, out of hardening scope). **Decision: accept as dev-toolchain risk**;
  runtime exposure = none; revisit on the next Prisma major with a dedicated
  migration phase.
- **L2 — eslint → minimatch (moderate ×16)**: dev/build tooling only; the
  only npm fix path is eslint@4 (nonsense). Accepted (Phase 6 decision
  stands).
- **L3 — `SESSION_SECURE_COOKIES=false` footgun**: addressed by H3 startup
  validation.
- **L4 — No password-change flow** (recovery reset is the only password
  mutation): product gap, not an exposure; recovery reset revokes all
  sessions. Documented for a future phase.
- **L5 — 30-day fixed session TTL, no sliding renewal**: acceptable;
  documented.
- **L6 — RIISHE delegation briefs persist private-project excerpts in
  `AgentTask.resultJson`**: owner-only visibility (rows are userId-scoped);
  data-minimization nuance for a future phase; consent already gates the
  generation path.
- **L7 — `/api/ai/conversations*` enforce consent but not burst/day limits**
  (read-only listing): accepted; the mutation paths are all gated.

## 5. Operational readiness (current state → target)

- **Backup**: none implemented. Target: `scripts/ops/backup-db.ts` (SQLite:
  `VACUUM INTO` + `integrity_check` + row-count parity; Postgres: `pg_dump`
  invocation), `scripts/ops/restore-db.ts` (restore to a target file +
  integrity verification), `scripts/ops/backup-media.ts` (deterministic
  media-tree archive). A real restore rehearsal is executed in this phase.
- **Health**: static `/api/health` → keep (liveness) + add `/api/ready`
  (readiness: DB + storage).
- **Logging/monitoring**: see M3/M4.
- **Rollback**: not documented. Target: documented procedure in the
  deployment doc (previous standalone build retained on disk; DB rollback =
  backup restore; schema policy is additive-only SQL artifacts — never
  destructive).
- **Env validation**: see H3.

## 6. Dependency security (summary; full evidence in §4-L1)

19 advisories (16 moderate / 3 high) — all dev/build toolchain; **zero
runtime production dependencies carry a known advisory** (verified:
`@prisma/client` has no dependency subtree; `sharp` was fixed in Phase 6 at
0.35.5). The Prisma 7 chain is accepted as documented toolchain risk (L1);
no upgrade in this phase satisfies "upgrade only where safe" (the only
non-breaking npm path is the rejected 6.12 downgrade; the real fix is a
major-version data-layer migration).

## 7. Embedded-workflow preservation constraints (hard requirements)

1. The sandbox preview panel frames the app cross-origin → no default
   `frame-ancestors` / `X-Frame-Options` (H1a).
2. Embedded auth uses `X-Bean-Embed: 1` + CHIPS-partitioned cookies → the
   Origin check (H5) must exempt embed-marked requests; cookie attributes
   are untouched.
3. LAXII studio works without BEAN Intelligence consent (H2 fixes the
   private-context path only, not studio access).
4. Single-instance deployments keep working with zero new required env
   (DB limiter, hardened scrypt, CSP enforcement are opt-in).

## 8. Regression protection protocol

After each hardening group: `bun run lint`, `bunx tsc --noEmit`, full
`bun test` (340+ baseline must hold), plus targeted suites for the touched
area (`media-upload*`, `auth*`, `recovery`, `giftz-*`, `phase5-integration`,
`intelligence-gateway`, `laxii-*`, `design-agent`). End-to-end: production
build in an isolated copy (Phase 6 procedure), browser verification of the
auth flows + CSP headers + studio + Giftz surfaces, and the backup/restore
rehearsal. Schema additions (RateLimitBucket) must land on BOTH mirrors with
`prisma validate` clean and the deployment SQL artifacts regenerated.
