# BEAN Folio

**Show your work. Find your people.**

BEAN Folio is a professional portfolio & discovery platform for every profession — video editors,
developers, architects, photographers, chefs, and beyond. One universal project model (brief →
process → challenges → outcome) works for any craft: publish work with real process narrative, get
discovered through a recency-and-relevance feed, connect through inquiries, messaging and
opportunities, and keep control of your data with export, deletion, and consent-gated AI.

The repository contains the full product: a Next.js 16 application (hash-routed SPA with
route-form public pages), a complete REST API, an isolated-QA-verified automated test suite,
Docker production packaging (SQLite development / PostgreSQL production), and server-side AI
through a provider-independent gateway. Documentation separates **verified facts** from
**production recommendations** throughout.

> **Repository visibility:** this repository is **PUBLIC** on GitHub. That is precisely why
> publishing runs through a verified source-only workflow: databases, media, backups, env files
> and credentials never enter Git (see [`DEVELOPMENT_SAFETY.md`](./DEVELOPMENT_SAFETY.md) and
> [`docs/ops/MILESTONE_EXECUTION_PROTOCOL.md`](./docs/ops/MILESTONE_EXECUTION_PROTOCOL.md)).

---

## Product areas (as shipped)

| Area | What it does |
|---|---|
| **Discover** | Editorial feed of public work with ranking reasons (recency-decayed engagement + profession match + new-creator boost) |
| **Explore** | Search across projects and people — text, profession, skill; sort by recent or saves |
| **My Folio & Create Studio** | Universal project model: draft → publish gate → unpublish; media, skills, tools, contributors; portfolio profile with taxonomy |
| **Portfolio Websites** | Creator-owned personal websites: builder, published sites served at `/site/<username>` with server-side SEO metadata, case studies |
| **GIFTZ** | Engineering workspace: repository explorer, task composer with **plan-approval gate**, live execution timeline, per-file diffs, terminal output, test results, completion report — generates and builds real websites in sandboxed Git workspaces |
| **RIISHE** | Personal intelligence: portfolio improvement, resume drafting, activity summaries — grounded in the user's own data only, draft-first outputs |
| **LAXII** | Creative intelligence: conversational image studio — reference-guided creation, multi-reference editing, the 2048×687 banner studio and resume documents |
| **Connect & Messaging** | Inquiries (accept/decline), follows, saves & collections, notifications, blocks & reports, one-to-one direct messages with message requests |
| **Opportunity Exchange** | Employer identity verification, opportunities, matching, invitations, shortlists and hiring rooms (governed by the O0–O7 milestone reports) |
| **Insights** | Owner-only analytics from real deduplicated view tables — honestly labeled estimates, 14-day series, top projects |
| **Trust & Settings** | Visibility controls, AI consent, data export, account deletion, audit log |
| **Moderation** | Admin review queues, including the Opportunity Exchange employer-verification and opportunity review pilots |

## Tech stack (as actually used)

| Layer | Technology |
|---|---|
| App | Next.js 16 (App Router, standalone output), React 19 |
| Language | TypeScript 5 (strict) |
| UI | Tailwind CSS 4 + shadcn/ui ("new-york"), dark obsidian + champagne-gold brand, framer-motion |
| Data | Prisma 6 — **SQLite in development (`prisma/schema.prisma`), PostgreSQL mirror in production (`prisma/schema.postgres.prisma`)**; 101 models in both, kept identical by `scripts/check-schema-parity.ts` |
| AI | Server-side BEAN Intelligence gateway (`src/lib/intelligence/**`) over `z-ai-web-dev-sdk` (sandbox managed provider); provider-registry + circuit-breaker, never client-side |
| Auth | scrypt password hashing, opaque DB-backed sessions in httpOnly cookies; Google OAuth prepared (`docs/google-auth.md`) |
| Validation | zod v4 at every API boundary |
| Scale readiness | Shared rate-limit/cache backends (`RATE_LIMIT_BACKEND`/`CACHE_BACKEND=postgres`), durable job store, cross-instance cancellation, multi-instance Compose overlay |
| Runtime | bun (install, dev, build, scripts); Node 22 in production containers |

## Quick start (development — SQLite)

```bash
# 1. Install dependencies
bun install

# 2. Environment — the app reads exactly one variable (SQLite file URL)
cp .env.example .env     # DATABASE_URL="file:./db/custom.db" is the active default

# 3. Create the database schema
bun run db:push

# 4. (Optional) seed clearly-marked demo fixtures (8 creators, 13 projects, 1 draft,
#    follows/saves/views so every area has honest sample data)
#    Demo sign-in afterwards: demo@beanfolio.app / demo1234
bun run scripts/seed.ts            # add --clear to remove all isDemo fixture data

# 5. Run
bun run dev              # http://localhost:3000
```

Public pages are also served in **route form** (`/u/<username>`, `/p/<id>`, `/post/<id>`,
`/site/<username>`) through `src/proxy.ts` with real server-rendered SEO metadata; the app
itself is a hash-routed SPA (`/#/discover`, `/#/studio/new`, …).

### Quality gates

```bash
bunx tsc --noEmit                        # type check (full repository, incl. tests)
bun run lint                             # eslint

# Full test suite (106 suites) — ALWAYS against an isolated throwaway database:
mkdir -p /tmp/ci-db
DATABASE_URL="file:/tmp/ci-db/custom.db" bunx prisma db push --skip-generate
DATABASE_URL="file:/tmp/ci-db/custom.db" bun run scripts/seed-professions.ts
DATABASE_URL="file:/tmp/ci-db/custom.db" bun run scripts/seed.ts
DATABASE_URL="file:/tmp/ci-db/custom.db" bun run scripts/restore-qa-fixtures.ts
DATABASE_URL="file:/tmp/ci-db/custom.db" bash scripts/ci/run-tests.sh

# Schema parity (SQLite ↔ PostgreSQL models must be identical)
bun scripts/check-schema-parity.ts

# Runtime-data guard (no databases/media/secret-bearing paths tracked)
bash scripts/ci/guard-runtime-data.sh
```

`scripts/ci/run-tests.sh` runs each suite in its own process against the isolated database —
a single-process `bun test` run is known to fail cross-file interference checks (documented in
`docs/ops/CI.md`). Never point the suite at a live database.

## Docker

```bash
# Production topology (app + PostgreSQL + Caddy TLS proxy) — needs .env.compose
cp .env.compose.example .env.compose   # fill DATABASE_URL, NEXT_PUBLIC_APP_URL, S3_*
docker compose up -d --build           # app on :80/:443 via Caddy, health-checked

# Development topology
docker compose -f docker-compose.dev.yml up

# Multi-instance readiness overlay (2 app replicas behind Caddy; worker topology)
# Pre-conditions and honest limits are documented in the file header and
# docs/ops/DEPLOYMENT_TIERS.md — do not enable multi-instance editing traffic
# until the GIFTZ workspace driver question is settled (see docker-compose.multi.yml).
docker compose -f docker-compose.yml -f docker-compose.multi.yml up
```

The image is a multi-stage build (builder → node:22-slim runner, non-root, health-checked,
SIGTERM-drained). `.dockerignore` guarantees a source-only build context — no databases,
media, secrets, docs, tests or scratch artifacts enter an image layer.

## Storage & media

- **Development:** local disk (`uploads/`, served via `/api/media/:id/raw`).
- **Production:** S3-compatible object storage — `S3_ENDPOINT`/`S3_REGION`/`S3_BUCKET`/
  `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (all-or-nothing; verified end-to-end against
  local S3-compatible servers). Required on stateless hosts (Vercel/filesystem-ephemeral).
- Multipart uploads up to ~4.5 MB through the API route; presigned direct upload is the
  documented upgrade for large media (`docs/media-pipeline.md`).

## AI configuration

AI runs **server-side only** through the BEAN Intelligence gateway. In the sandbox it uses the
managed provider (`z-ai-web-dev-sdk`) with no keys. External providers are configured via
`AI_PROVIDER_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` (`docs/ai-integration.md` §9) —
unconfigured features degrade honestly (never fake results). Per-user consent + quotas
(30/day/user) and an optional `INTELLIGENCE_DAILY_COST_LIMIT_USD` guardrail apply.

## Repository structure

```
├── src/
│   ├── app/page.tsx           ← SPA document (+ proxy.ts route-form public pages)
│   ├── app/api/**/route.ts    ← 266 REST route files (docs/api.md)
│   ├── views/*.tsx            ← 28 feature views
│   ├── components/bean/**     ← product components (incl. giftz/laxii/riishe workspaces)
│   └── lib/**                 ← auth, ai gateway, giftz, laxii, riishe, ox, queue, cache,
│                                 rate-limit-backend, storage, monitoring, security…
├── prisma/schema.prisma       ← SQLite data model (101 models, development)
├── prisma/schema.postgres.prisma ← PostgreSQL mirror (same 101 models, production)
├── tests/                     ← 106 automated suites (isolated-QA-DB runner)
├── scripts/                   ← ops, ci, loadtest, diagnostics, seeds (see scripts/*/README.md)
├── docker-compose*.yml        ← production / development / multi-instance topologies
├── docs/                      ← documentation suite (below) + ops runbooks
└── worklog.md                 ← historical engineering build log (evidence, kept out of Docker)
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | As-built system shape, layering, production extraction map |
| [docs/api.md](docs/api.md) | REST reference: auth, bodies, responses, errors, rate limits |
| [docs/database.md](docs/database.md) | Data model, constraints/indexes, PostgreSQL path |
| [docs/security.md](docs/security.md) | Passwords/sessions, authorization, validation, media safety, gaps |
| [docs/deployment.md](docs/deployment.md) | Verified deployment status, production runbook, env vars |
| [docs/media-pipeline.md](docs/media-pipeline.md) | Upload flow + S3/worker production design |
| [docs/ai-integration.md](docs/ai-integration.md) | BEAN Intelligence gateway, consent, quotas, provider swap |
| [docs/testing.md](docs/testing.md) | Verification history + how to run the automated suites |
| [docs/known-limitations.md](docs/known-limitations.md) | The honest limitations list with fix paths |
| [docs/ops/](docs/ops/) | Runbooks: CI, go-live checklist, migrations, queue, backups, load testing |
| [docs/ops/MILESTONE_EXECUTION_PROTOCOL.md](docs/ops/MILESTONE_EXECUTION_PROTOCOL.md) | Binding engineering workflow & publishing policy |

## Verified vs not (honest status)

**Verified in-repo:** typecheck + lint clean on the published baseline; 106 automated suites
green against the isolated QA database (per-file runner); SQLite↔PostgreSQL schema parity gate;
production Docker image defined (multi-stage, non-root, health-checked); S3 media driver
verified end-to-end; multi-instance state fixes (durable job store, cross-instance cancellation)
covered by dedicated regression suites (`tests/design-jobs-durable.test.ts`,
`tests/giftz-cross-instance.test.ts`, `tests/laxii-job-state.test.ts`).

**Measured capacity:** single-instance sandbox (2 vCPU / 3.9 GiB) sustains the declared
service objectives up to ~25–50 concurrent virtual users in the recorded load-test evidence
(`scripts/loadtest/results/`). **There is NO measured 100K-concurrent-user capacity** — the
scale program (PostgreSQL backends, multi-instance topology, distributed load generation) is
defined in the milestone reports but not yet executed at that scale.

**Not done:** no production deployment or domain; Privacy Policy / Terms of Service are
**beta drafts with placeholder contact addresses** (`src/views/StaticView.tsx`); CI workflow is
a reviewed template (`docs/templates/github-workflow-ci.yml`) pending activation in
`.github/workflows/`; no external integrations (Google OAuth / S3 are documented designs,
never faked). The complete list lives in [`docs/known-limitations.md`](docs/known-limitations.md).
