# BEAN Folio — Prioritized Implementation Plan

Constraints honored throughout: **no UI redesign** (Phase 11), additive-only migrations, no feature/data deletion, `main` never pushed, tests never disabled to force green, no mocked AI.

## Workstream A — Production correctness (P0, do first)

| ID | Task | Files |
|---|---|---|
| A1 | Restore `POST /api/media/upload` (auth → 30/h → saveUpload → UploadError 400); re-enable its test | `src/app/api/media/upload/route.ts` (from deploy), `tests/media-upload-route.test.ts` |
| A2 | Re-sync PG mirror (add `AgentArtifact`, `SiteStudioSession`, `SiteStudioMessage` + all new additive models as they land); add parity check script | `prisma/schema.postgres.prisma`, `scripts/check-schema-parity.ts` |
| A3 | Kind-aware stale sweep for `SITE_STUDIO_TURN` (and reuse for queue claims) | `src/lib/site-studio/turn.ts`, queue module |
| A4 | Backup tooling: `scripts/backup-db.ts` + scheduled run hook + restore runbook | `scripts/`, `docs/ops/` |

## Workstream B — Scale foundations (P1)

| ID | Task | Files |
|---|---|---|
| B1 | Request IDs + structured logging + body-size cap in the `handler()` choke point; `x-request-id` response header | `src/lib/api-helpers.ts` |
| B2 | Rate-limiter backend interface: memory (default) + shared DB-backed bucket store (opt-in `RATE_LIMIT_BACKEND=db`), keyed hash-safe | `src/lib/api-helpers.ts`, new `src/lib/rate-limit-backend.ts`, optional 1 model |
| B3 | App-level TTL cache with event invalidation (`publish`, `unpublish`, `site.save`, `profile.update`); applied to `/api/professions`, `/api/profiles/[username]` public payload, `/api/discover` | new `src/lib/cache.ts` + 4 route touchpoints |
| B4 | Durable `BackgroundJob` queue: claim/heartbeat/retry/backoff/DLQ/per-user + global concurrency, worker loop started from `instrumentation.ts`, graceful SIGTERM drain, maintenance job (session/reset-token/export retention sweeps) | `prisma/schema.prisma`, new `src/lib/queue/*` |
| B5 | Additive index migration (12 missing indexes incl. `Block.blockedId`, `AuditEvent(actorUserId,createdAt)`, `Notification[userId,readAt]`, `Session.expiresAt`) | `prisma/schema.prisma` + PG mirror |
| B6 | Health enrichment: queue depth/oldest-job age in `/api/health` (value-free internals policy kept) | `src/app/api/health/route.ts` |

## Workstream C — Universal profession taxonomy (Phase 3)

| ID | Task | Files |
|---|---|---|
| C1 | Additive models: `ProfessionFamily`, extend `Profession` (`familySlug`, `level`, `aliases`), `Specialism` (profession-scoped), keep `ProfileProfession` join (multi-profession per user already supported) | `prisma/schema.prisma` + mirror |
| C2 | Seed full hierarchical taxonomy — 13 families (Creative, Technology, Journalism/Media, Writing, Film/Audio, Business, Architecture/Engineering, Education, Health, Science/Environment, Public Service, Trades, Career Development) with ~120 professions + specialisms incl. the mandated news/media set (anchor, correspondent, photojournalist, fact-checker, …). No fabrication of user data — taxonomy only | `scripts/seed-professions.ts`, `src/lib/professions/taxonomy.ts` (single source module) |
| C3 | API: `GET /api/professions` stays backward-compatible (flat `{slug,label,group}`); add `?tree=1` hierarchical shape; `GET /api/professions/[slug]` detail (specialisms, evidence conventions) | `src/app/api/professions/*` |
| C4 | Validation: onboarding/profile PATCH accept any seeded slug (DB-checked, up to 5), legacy 18 slugs preserved 1:1 | `me/onboarding`, `me/profile`, `src/lib/categories.ts` re-export shim |

## Workstream D — 60+ distinct profession templates (Phase 4)

| ID | Task | Files |
|---|---|---|
| D1 | Refactor `templatePresets()` into per-collection modules (`src/lib/site-templates/*`) re-exported from `site-config.ts` — zero behavior change, all 4 registries derived from one source; existing 70 templates byte-preserved | `site-config.ts`, new modules |
| D2 | Author ≥60 NEW genuinely distinct templates covering the mandated archetype list (editorial, news anchor, broadcast journalist, reporter, investigative, photojournalist, video journalist, radio presenter, podcast host, writer, author, copywriter, photographer, filmmaker, video editor, motion, animator, 3D, graphic/brand/UI/UX/product designer, illustrator, fine artist, fashion, interior, architect, civil/mech/electronics engineer, software/full-stack/mobile/game dev, AI/ML, data scientist/analyst, cybersecurity, DevOps, PM, UX researcher, technical writer, academic, teacher, scholar, doctor, nurse, physiotherapist, dietitian, consultant, entrepreneur, marketing, strategist, finance, events, chef, fitness, musician, actor, voice artist, dancer, craftsperson, real estate, legal, student) — distinct structural signatures, distinct themes, no blue/indigo, sample content marked as sample | `src/lib/site-templates/professions/*` |
| D3 | New template categories (newsroom, broadcast, engineering, health, business, trades…) registered in category registry with ≥2 members each (test rule) | template registry |
| D4 | Template test floor raised (count, uniqueness, schema validity, font resolution, profession-slug integrity — every `professions[]` slug must exist in taxonomy) | `tests/style-templates.test.ts` |

## Workstream E — Profession-aware generation (Phase 5)

| ID | Task | Files |
|---|---|---|
| E1 | Profession playbooks module: per-family section ordering, project/evidence types (article+byline, showreel, case study, recital…), media guidance, anti-fabrication rules — consumed by planner grounding | new `src/lib/professions/playbooks.ts` |
| E2 | Grounding integration: `fetchPortfolioBlock` + plan prompt include profession playbook guidance; template recommendations filtered by user professions via existing `TemplatePreset.professions` | `src/lib/ai-design/context.ts`, `prompts.ts` |
| E3 | Multi-profession support: playbooks merge (dedupe sections) when a profile has 2+ professions | playbooks module |

## Workstream F — Security & reliability (Phase 6)

| ID | Task | Files |
|---|---|---|
| F1 | `POST /api/me/deletion`: require password re-auth + rate limit + audit event; minimal password field in Settings dialog | `me/deletion/route.ts`, `SettingsView.tsx` (minimal) |
| F2 | Recovery limiter poisoning fix: per-email bucket keyed on SHA-256(email) + exempt-first-success policy | `auth/recover/request/route.ts` |
| F3 | Stop forwarding raw `Error.message` at 3 sites; typed error mapping | materials, brief, studio messages routes |
| F4 | JSON body cap via zod field bounds for `currentConfig` (`z.unknown()` → bounded string) | studio messages, design plan/execute |
| F5 | Headers: `Permissions-Policy`, HSTS-ready hook (Caddy), CSP report-only first (no breakage) | `next.config.ts` |
| F6 | Follow/unfollow rate limit; wrap `/api` root in `handler()` | `profiles/[username]/follow`, `api/route.ts` |

## Workstream G — Load testing (Phase 7)

| ID | Task | Files |
|---|---|---|
| G1 | Declared workload definitions + k6 suites (browse mix, login, edit, upload, generation, publish, search) with ramp stages 100→100k VU | `scripts/loadtest/*` |
| G2 | Local measured run (sandbox-bounded VUs) with p50/p95/p99 + RPS + error rate; honest report of highest sustained load + bottleneck | `docs/ops/LOAD_TESTING.md` |

## Workstream H — Ops & cost (Phases 8–9)

| ID | Task | Files |
|---|---|---|
| H1 | Tier A/B/C deployment configs with explicit assumptions + cost estimates; provider-independent | `docs/ops/DEPLOYMENT_TIERS.md` |
| H2 | Runbooks: deploy, migrate (additive + rollback), backup/restore drill, scaling, incident recovery, monitoring/alert list | `docs/ops/RUNBOOK.md` |

## Execution order (respecting file-ownership to avoid collisions)

1. **A2+B5+C1+B4-schema** → single additive `schema.prisma` edit + mirror sync + `db:push` (one owner).
2. Parallel wave 1: A1 (upload) · B1+B2 (api-helpers) · B3 (cache) · B4-code (queue) · C2+C3 (taxonomy) — disjoint files.
3. D1 (template registry refactor) → then parallel template authoring by family → D3/D4 integration.
4. E1/E2 after C and D land.
5. F hardening wave.
6. G/H.
7. Full verification: `bunx tsc --noEmit`, `bun run lint`, `bun test`, `db:push` idempotent, browser E2E, careful production build (memory-isolated).

## Explicitly out of scope this cycle (documented, not silently skipped)

- Presigned direct-to-S3 uploads (design exists; needs real bucket + approval) — documented in media runbook.
- Redis deployment (adapter boundary provided; needs infrastructure approval).
- Full SSR for `/u/<slug>` (SPA redesign — violates no-UI-redesign; Tier C path documented).
- k6 execution at true 100k VU scale (impossible in sandbox — scripts + Tier C plan delivered; local measured results reported honestly).
