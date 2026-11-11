# BEAN Folio — Go-Live Checklist (final gate before production)

> Companion to `docs/ops/PRODUCTION_READINESS.md` (infrastructure verification),
> `docs/deployment.md` (full walkthrough) and `docs/ops/MIGRATIONS.md` (DB procedure).
> This file is the single pre-flight list to run IN ORDER before flipping traffic.
> Rule of the house: **do not check a box you did not verify.**

## 1. Production deployment checklist

- [ ] `vercel-build` succeeds on a clean checkout: `prisma generate --schema prisma/schema.postgres.prisma && next build` (typecheck must be clean: `bunx tsc --noEmit`).
- [ ] `bun run lint` — 0 errors (5 pre-existing k6-script warnings are acceptable).
- [ ] `bun test` — all suites green except the documented DB-fixture-dependent set (seed the target DB or run against staging).
- [ ] Node/runtime compatibility: Vercel Node runtime; `serverExternalPackages: ["pdf-parse"]` preserved (next.config.ts) — verify resume upload still parses in the deployed preview.
- [ ] `next.config.ts` security headers present in a deployed response (X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP; HSTS only in production).
- [ ] Public/private route behavior: `/u/*` and `/p/*` serve the public shell (src/proxy.ts); every `/api` route that must be private returns 401 unauthenticated (spot-check: `/api/me/site`, `/api/laxii/resume`, `/api/me/export`).
- [ ] Background workers: decide per environment — `QUEUE_ENABLED=false` on web instances + a dedicated worker (`bun scripts/queue-drain.ts`), or in-process for single-instance. See `.env.example` queue section and `docs/ops/RUNBOOK-QUEUE.md`.
- [ ] Rate-limit + cache backends: `RATE_LIMIT_BACKEND=postgres` and `CACHE_BACKEND=postgres` when running >1 instance (same DATABASE_URL; no extra service).
- [ ] LAXII V1 engine: `LAXII_DEFAULT_PROVIDER=managed` (the only user-facing engine; other provider ids are internal and refused for user requests). Generation verified against the managed gateway.

## 2. Environment variable checklist (exact names — see .env.example for semantics)

Required in Production:
- [ ] `DATABASE_URL` — managed PostgreSQL string, `sslmode=require`, copied from the provider dashboard (never hand-typed; P1000 note in docs/deployment.md §0.4).
- [ ] `NEXT_PUBLIC_APP_URL` — the exact HTTPS production origin (set BEFORE build; NEXT_PUBLIC_ vars are inlined at build time).

Strongly recommended:
- [ ] `RATE_LIMIT_BACKEND=postgres`, `CACHE_BACKEND=postgres` (>1 instance).
- [ ] `QUEUE_ENABLED` / `QUEUE_CONCURRENCY` / `QUEUE_USER_CONCURRENCY` (worker topology).
- [ ] `SESSION_SECURE_COOKIES=true` (or rely on automatic HTTPS detection).
- [ ] `INTELLIGENCE_DAILY_COST_LIMIT_USD` (per-user daily guardrail, default 5).

Feature flags (leave empty = feature honestly disabled):
- [ ] `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — Google sign-in. Redirect URI MUST byte-match Google Cloud Console. Production: `https://<your-domain>/api/auth/google/callback`.
- [ ] `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` — REQUIRED on stateless hosts (Vercel local FS is ephemeral; uploads would be lost).
- [ ] `AI_PROVIDER_API_KEY` — only if swapping off the sandbox text gateway.
- [ ] `GEMINI_API_KEY` / `OPENAI_API_KEY` / `LAXII_DIFFUSERS_URL` — internal LAXII provider plumbing; the user-facing engine stays LAXII V1 regardless.

Never set / never expose:
- [ ] No `SUPABASE_*` values (placeholders, not used). No DB credentials in client code (`NEXT_PUBLIC_` prefix audit).

## 3. Migration procedure (additive-only; full text: docs/ops/MIGRATIONS.md)

- [ ] Step 0: backup (`pg_dump` or `bun scripts/backup-db.ts`) and verify the backup restores.
- [ ] Edit BOTH schemas identically → `bun scripts/check-schema-parity.ts` must print `SCHEMA PARITY OK`.
- [ ] Generate DDL: `prisma migrate diff --from-url <staging> --to-schema-datamodel prisma/schema.postgres.prisma --script` — review statement-by-statement. CREATE TABLE / ADD COLUMN / CREATE INDEX only; any DROP/ALTER-RENAME = STOP (destructive path is banned).
- [ ] Apply ONCE by hand against production; verify with `check-postgres-schema-readiness.ts`, `verify-postgres-migration.ts`, then `GET /api/ready`.
- [ ] Latest additive change needing this treatment: `MediaAsset @@index([status, createdAt])` (both schemas; CREATE INDEX — non-blocking, but use CREATE INDEX CONCURRENTLY on large tables).

## 4. Rollback procedure

- [ ] App: redeploy the previous immutable Vercel deployment (Promotions → Instant rollback). Schema changes are additive, so the previous build keeps working against the new schema.
- [ ] DB: restores come from Step-0 backup only — record the exact restore command and target in the incident doc BEFORE migrating. NEVER attempt to "undo" an additive migration by dropping.
- [ ] Cache/rate-limit backends: flip `CACHE_BACKEND`/`RATE_LIMIT_BACKEND` back to `memory` to degrade safely if the shared store misbehaves (documented failure posture; limits stay enforced per-instance).
- [ ] Workers: `QUEUE_ENABLED=false` stops new work; stuck jobs recover via `recoverStuck()` on next boot (≤5 min stale heartbeat).

## 5. Smoke-test checklist (run against the production URL after every deploy)

- [ ] `GET /` 200; `GET /api/health` + `GET /api/ready` 200.
- [ ] Register a throwaway account → recovery-key dialog → onboarding completes.
- [ ] Log out → log in → log out (cookies cleared; Secure flag visible in production).
- [ ] Studio: create a project, upload one image, publish, view `/u/<username>` in a private window.
- [ ] LAXII V1: one image generation completes (DONE status; provider=managed, model=managed-image-1 in the thread payload).
- [ ] Resume: generate one draft (any format) → export PDF → export DOCX (both download, selectable text).
- [ ] Google sign-in (if configured): authorize → callback lands signed-in; status endpoint reports enabled.
- [ ] Rate limit sanity: 11 rapid logins from one IP → 429 with Retry-After (shared backend).

## 6. Monitoring checklist

- [ ] Platform logs flowing (Vercel Runtime Logs or equivalent); `event: "api.error"` structured lines present with `requestId` (no stack traces in production).
- [ ] `/api/health` polled externally (uptime check) + `/api/ready` after deploys/migrations.
- [ ] Queue dashboard: `GET /api/health` counters (queue depth, oldest-queued age); alert when depth does not return to baseline ≤60 s after load (SLO S7).
- [ ] DB: connection usage vs `connection_limit = floor(max_connections × 0.8 / instance_count)`; pooler in front at >2 instances (docs/ops/RUNBOOK.md §connections).
- [ ] 429 rate by endpoint (abuse signal), 5xx rate (<0.1% sustained target, SLO S5).
- [ ] Daily AI cost-guardrail hits (`INTELLIGENCE_DAILY_COST_LIMIT_USD`) — a spike means metered engines are being hammered.

## Status: BLOCKED (honest)

Deployment readiness today: **READY for staging; BLOCKED for production** until the
environment items above exist. Precisely:

1. Managed PostgreSQL instance + `DATABASE_URL` (not provisionable from this sandbox).
2. S3-compatible object storage credentials (required on stateless hosts).
3. `NEXT_PUBLIC_APP_URL` production domain (owner decision).
4. One reviewed additive migration application (the procedure above; nothing has been applied to any production DB from here).
5. Optional features need their variables or stay honestly disabled: Google OAuth, AI provider swap.

No production deploy, DNS change, or push to main has been performed from this workspace.
