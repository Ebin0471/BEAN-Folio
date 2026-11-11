# BEAN Folio — Architecture Audit (Phase 1)

Date: 2026 audit cycle · Scope: full repository · Method: 5 parallel deep-dive audits (DB, API, frontend, CODE GIFTZ/templates, infra/security/tests) + verification against live code. Every claim carries a file:line reference where applicable.

---

## 1. Verified architecture map

### 1.1 Runtime topology (as found)

```
Browser (single-document hash-routed SPA)
  │
  Caddy (:81)  ── X-Forwarded-* sanitization, XTransformPort escape hatch
  │
  Next.js 16.1 standalone (bun, port 3000, output:"standalone", force-dynamic everywhere)
  │
  ├── src/proxy.ts            rewrite-only /u/<slug>, /p/<id> → /  (boot-route header; excludes /api)
  ├── src/app/page.tsx        the ONLY page; renders <SiteShell> (hash router, 19 client views)
  └── src/app/api/**          ~64 route files / ~85 operations (all dynamic, no caching layer)
        │
        ├── src/lib/db.ts             PrismaClient singleton (hot-reload guard; zero pool tuning)
        ├── src/lib/api-helpers.ts    handler() wrapper · ok()/err() · zod parseBody · in-memory rate limiter
        ├── src/lib/auth.ts           custom cookie sessions (scrypt, SHA-256 tokens) — NOT NextAuth
        ├── src/lib/storage.ts        media driver: local disk OR S3-compatible (@aws-sdk/client-s3)
        ├── src/lib/ai.ts + intelligence/gateway.ts   provider-independent AI gateway (z-ai-web-dev-sdk)
        └── background "jobs"         in-process fire-and-forget async promises (NO queue, NO worker)
              │
              └── Prisma datasource
                    ├── SQLite  (prisma/schema.prisma, 41 models, db/custom.db, sandbox)
                    └── PostgreSQL mirror (prisma/schema.postgres.prisma, 38 models — DRIFTED)
```

### 1.2 Layer-by-layer findings

| Layer | State | Key facts |
|---|---|---|
| Frontend | Hash-routed SPA, one document | 19 views statically imported into `SiteShell.tsx:48-65`; no code splitting (`next/dynamic` = 0 hits); TanStack Query/Zustand installed but unused (0 imports); SEO applied client-side (`src/lib/seo.ts`) |
| Public portfolio `/u/<slug>` | CSR-only | proxy rewrite → skeleton shell → client fetch of `/api/profiles/[username]` (6+ Prisma queries, full User row incl. `passwordHash` over-fetched, `profiles/[username]/route.ts:18-25`); no ISR, no CDN headers; per-visit `profileView.upsert` write |
| API | Well-disciplined, single-instance assumptions | `handler()` choke point; zod at 56 call sites; zero client-trusted identity; **no IDOR found** (double ownership checks, server-side media ladder); missing: request IDs, body-size caps, shared rate limiting, envelope docs |
| Auth | Custom, solid primitives | 32-byte tokens stored hashed; scrypt+timing-safe compare; httpOnly cookies (SameSite=Lax; `SameSite=None;Partitioned` via client-controlled `X-Bean-Embed` header — low risk); no NextAuth (dep unused) |
| Database | 41-model SQLite schema; PG mirror drifted | 34 `@@index`; 12 missing FK-side/query indexes; offset pagination only (bounded pools); site publish = atomic single-row snapshot copy (`me/site/publish/route.ts:51-65`); no migrations folder (`db push` + hand-applied PG DDL) |
| Media | Server-proxied upload; 5-branch authz ladder | magic-byte sniffing, per-kind caps (IMG 8 MB / VID 64 MB / AUD 20 MB / DOC 10 MB), path-traversal guard; **`POST /api/media/upload` route MISSING on main** (client calls it → every upload 405s); whole-object buffering on raw serving; presigned uploads designed (`docs/media-pipeline.md §4`) not implemented |
| CODE GIFTZ (site studio) | plan → validate → execute → isolated proposal | durable `AgentTask` + 202/poll; plan validator with target canonicalization + repair; proposals isolated in `SiteStudioMessage.proposalJson` (never touches draft/published); **crash-stranded turns never swept** (sweep covers only `ENGINEERING_TASK`, `giftz/jobs.ts:643-644`); design-job store process-local (`ai-design/jobs.ts:48-49`) |
| Templates | 70 code-data templates | `TemplatePreset {id,label,description,professions,theme,motion,pages}` (`site-config.ts:925-934`); all inline in ONE 2,023-line file; 4 registries must move in lockstep; content-safe apply (theme/motion only; structural pages adopted only on pristine site) |
| Professions | Minimal taxonomy end-to-end | `Profession{slug,label,group,order}` + `ProfileProfession` join; **18 slugs** seeded in `api/professions/route.ts:5-24`; static fallback `CATEGORY_LABELS` (`categories.ts:7-26`); onboarding 1-5 slugs; templates reference slugs via `professions: string[]` |
| Caching | None at app level | `unstable_cache`/`revalidate*` = 0 hits; only `private` browser caching on media bytes; public JSON recomputed per request |
| Background work | In-process promises only | LAXII gen (stale-sweep ✓), design jobs (in-memory, TTL 30 min, durability shadow ✓), giftz tasks (durable rows ✓, fire-and-forget), studio turns (durable rows, **no sweep**), export (sync in-request) |
| Observability | Minimal | `console.error("[api]", e)` choke point; structured JSON logs for AI gateway only; `/api/health` + `/api/ready` (2s DB probe) exist; no request IDs, no metrics, no Sentry/OTel |
| Tests | 27 files / ~447 tests (bun test) | 25 active + 2 disabled (media-upload-route, design-jobs-durable); no E2E framework; no k6 |
| Deployment | Dual-schema dual-target | `db:push` SQLite sandbox; `vercel-build` generates client from **drifted** PG mirror; standalone runbook `bun .next/standalone/server.js`; `maxDuration` no-op outside Vercel; no Dockerfile/compose |

### 1.3 Dependency map (runtime-critical)

```
SiteShell ──→ 19 views ──→ api() ──→ /api/* ──→ handler() ──→ db (Prisma singleton)
WebsiteBuilderView ──→ ChatPanel ──→ studio sessions/messages (202) ──→ turns/[taskId] poll
                                   └─→ SiteRenderer (iframe sandbox preview)
studio turn ──→ plan-core (LLM, 120s) ──→ plan.ts validate ──→ execute.ts (tools; deterministic + scoped LLM)
            ──→ proposalJson (isolated) ──→ user Accept ──→ PUT /api/me/site ──→ SiteRevision snapshot
publish ──→ siteDesign.upsert(draft→published) ──→ /u/<slug> serves publishedConfig
media upload (client) ──→ POST /api/media/upload  ✗ MISSING ──→ saveUpload (lib, unused by routes)
media serve ──→ /api/media/[id]/raw ──→ authz ladder (owner→avatar→cover→project→published-site)
```

---

## 2. Data-integrity & persistence state

- **Live DB**: `db/custom.db` — 41 tables, 149 rows, 630 KB. Gitignored. **No backup exists.**
- **The 808-row backup is unrecoverable** (was `pg-migration/{data.json,inserts.sql,counts.json}`; directory absent, gitignored, never committed).
- **PG mirror drift (P0)**: `schema.postgres.prisma` (38 models) is missing `AgentArtifact`, `SiteStudioSession`, `SiteStudioMessage`, which production code actively uses → Vercel build type-check fails or runtime 500s.
- **Schema-count drift across four sources of truth**: schema.prisma=41, PG mirror=38, `check-postgres-schema-readiness.ts` expects 36, `docs/database.md` says 27.
- **No `prisma/migrations/`** — SQLite via `db push`; PG DDL applied ad-hoc (`pg-migration/01_schema.sql`, `docs/deployment/*.sql`).

## 3. Security posture summary

Strengths: server-side identity everywhere, ownership re-verified per route, no IDOR found, magic-byte upload sniffing, storage-path traversal guard, hashed session tokens, structured visibility ladder, append-only `AuditEvent`.

Gaps (prioritized in BOTTLENECK_REPORT.md §4): upload route missing (P0), in-memory rate limiter (single-instance), no CSP/HSTS, deletion without password re-auth, recovery-email limiter poisoning, raw `Error.message` forwarded at 3 sites, unbounded JSON bodies (`currentConfig: z.unknown()`).

## 4. What already works well (preserve)

1. `handler()` + zod + typed-error discipline; honest 202+poll for AI work.
2. Isolated CODE GIFTZ proposal workflow (draft/publish separation is atomic and validated).
3. Content-safe template application; deterministic AI tools with constraint enforcement + byte-identical restore.
4. Deduped view ledgers; bounded candidate pools; cascade deletes.
5. Seed/fixture/PG-verification tooling; 447-test regression suite.
