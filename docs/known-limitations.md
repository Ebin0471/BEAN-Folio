# BEAN Folio — Known Limitations

**Summary:** The honest list of what this build does not do. Each item states the limitation,
why it exists (sandbox constraint or scope decision), and where the fix is designed. Nothing
here is hidden behavior — it is all also cross-referenced from the relevant docs.

**Status:** As built in this repository — verified observations, not speculation.

---

## 1. Platform & data

| # | Limitation | Why | Where the fix is designed |
|---|---|---|---|
| 1.1 | **SQLite single-writer** — one write at a time; write-heavy concurrency will serialize. The PostgreSQL migration kit is prepared and rehearsed (`prisma/schema.postgres.prisma`, `scripts/migrate-to-postgres.ts` export verified, `scripts/verify-postgres-migration.ts`, `pg-migration/rollback.md`) but not executed — no PostgreSQL server exists in the sandbox and the live database was deliberately not switched | Sandbox has no PostgreSQL | `docs/database.md` §6.1 |
| 1.2 | **Single visible page route (SPA under `/` with hash routing)** — no SSR, so profile/project pages have no server-rendered HTML: SEO and social previews are effectively absent | Sandbox constraint: only `/` may be a user-visible PAGE route | `docs/architecture.md` §3 (trade-off) + §5 (production route structure) |
| 1.3 | **No production deployment** — everything here runs dev-grade (`bun run dev`) on port 3000 | No host/domain/TLS/secrets available in the sandbox | `docs/deployment.md` (runbook + checklist) |
| 1.4 | **`prisma db push` instead of migrations** — fine for prototyping, no migration history | Sandbox workflow | `docs/deployment.md` §3.3 (`migrate deploy` in production) |
| 1.5 | **`next.config.ts` sets `ignoreBuildErrors: true`** — a scaffold default; `next build` will not fail on TS errors | Scaffold default left in place (not product code, not ours to own) | `docs/deployment.md` §1 / `docs/testing.md` §2 (CI `tsc` gate) |

## 2. Media

| # | Limitation | Why | Fix designed in |
|---|---|---|---|
| 2.1 | **Local-disk media (`uploads/`)** — no S3, no CDN; media is instance-bound and lost if the disk is reset | No external credentials in sandbox | `docs/media-pipeline.md` §4 (S3 + signed uploads) |
| 2.2 | **No processing pipeline** — no thumbnails/transcoding/EXIF stripping; originals are served as-is; video posters don't exist | Requires FFmpeg worker + durable jobs, out of sandbox scope | `docs/media-pipeline.md` §4 |
| 2.3 | **No abandoned-upload cleanup** — deleting an account cascades media *rows*, and file deletion happens via owner DELETE; blobs are otherwise never GC'd in bulk | Cleanup cron out of scope | `docs/media-pipeline.md` §4 (cleanup policy) |

## 3. Security & abuse controls

| # | Limitation | Why | Fix designed in |
|---|---|---|---|
| 3.1 | **In-memory rate limiter** — per-instance, resets on restart, `x-forwarded-for`-derived keys | Single process, no Redis in sandbox | `docs/security.md` §8.1 |
| 3.2 | **No CSRF tokens** — relies on SameSite=Lax + JSON-only mutation endpoints | Deliberate, documented trade-off | `docs/security.md` §8.2 (double-submit recommendation) |
| 3.3 | **No 2FA** | No email/SMS infra in sandbox | `docs/security.md` §8.3 |
| 3.4 | **No email verification and no password reset** — a user who loses the password cannot recover the account | No outbound email available; documented as a next step, not skipped silently | `docs/security.md` §8.3; Supabase/Resend path in `docs/google-auth.md` §10 |
| 3.5 | ~~Moderation tooling minimal~~ **RESOLVED**: admin-only moderation review queue now exists — `GET/PATCH /api/admin/reports[/:id]` (server-enforced ADMIN role, 403 for anonymous and non-admin alike), `#/moderation` review UI (hidden from non-admins), outcome recording (REVIEWED/RESOLVED, resolved reports locked) with audit events `moderation.report.*`. Admin promotion: `bun scripts/set-admin.ts <email>` (audited as `admin.role.change`) | Was out of scope for the first build | `docs/security.md` §8.5 |

## 4. Auth & identity

| # | Limitation | Why | Fix designed in |
|---|---|---|---|
| 4.1 | **Google OAuth documented but not live** — the build ships email+password only; no Google/Supabase credentials exist, so nothing was faked | No external credentials in sandbox | `docs/google-auth.md` (full setup + identity mapping) |
| 4.2 | **Session `secure` flag derived from `NODE_ENV`** rather than an explicit setting | Sufficient for this environment | `docs/security.md` §8.4 |

## 5. AI

| # | Limitation | Why | Fix designed in |
|---|---|---|---|
| 5.1 | **AI daily quota counts per-instance DB but minute-bucket is per-process** — minute limits reset on restart and don't aggregate across replicas | In-memory rate limiter (same root cause as 3.1) | `docs/ai-integration.md` §4, `docs/security.md` §8.1 |
| 5.2 | **Provider locked to the sandbox's z-ai SDK** | The only configured provider here; the gateway exists precisely so this is a one-file swap | `docs/ai-integration.md` §9 |

## 6. Insights & data honesty

| # | Limitation | Why | Notes |
|---|---|---|---|
| 6.1 | **Insights are estimates** — one view per viewerKey per UTC day; the same human on two devices/cleared cookies counts twice; bots are not filtered | Dedup design is cookie/uid based | Surfaced in-product as "estimated"; mechanism in `docs/database.md` §4 |
| 6.2 | **No follower-count ranking / no fabricated stats anywhere** — this is a constraint we imposed on ourselves; discover uses recency-decayed engagement + profession match + new-creator boost | Product principle | `docs/product-spec.md` §5 |

## 7. Content & fixtures

| # | Limitation | Why | Notes |
|---|---|---|---|
| 7.1 | ~~Demo fixture loader not present~~ **RESOLVED**: `scripts/seed.ts` now exists and creates 8 clearly-marked `isDemo` fixture accounts with 13 published projects + 1 draft, follows/saves/deduped views (generated cover/avatar assets in `scripts/seed-assets/`). Demo sign-in: demo@beanfolio.app / demo1234. `--clear` removes all fixture data; real accounts are never touched | Resolved in final integration pass | README quick start documents it |
| 7.2 | **Placeholder contact addresses in legal pages** — the privacy/terms static views need real contact emails before launch | No real organizational identity in the sandbox | `docs/deployment.md` §4 checklist |

## 8. Testing

| # | Limitation | Why | Fix designed in |
|---|---|---|---|
| 8.1 | **No automated test suite was executed** — the sandbox forbade adding test frameworks; verification was lint + tsc + live curl smoke tests by build agents | Sandbox constraint | `docs/testing.md` (recommended Vitest/Playwright setup + critical cases) |
| 8.2 | **UI not E2E-verified** — the 15 feature views were still stubs during the API verification window; the SPA shell/routing/components are implemented | Frontend tasks (4-a/4-b/4-c) had not appended to `worklog.md` at documentation time | Re-verify after frontend tasks land (`docs/testing.md` §1.3) |

## 9. Mobile

| # | Limitation | Why | Fix designed in |
|---|---|---|---|
| 9.1 | **Mobile app not built** — this environment ships responsive web only | Expo/native builds were out of sandbox scope | The REST API is the contract; Expo plan + deep-link notes in `docs/google-auth.md` §9 and `docs/architecture.md` §5 |

## 10. Related docs

`README.md` ("What's verified vs not") · `docs/testing.md` · `docs/security.md` §8 ·
`docs/deployment.md` §4 · `docs/media-pipeline.md` §4 · `docs/google-auth.md`
