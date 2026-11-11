# BEAN Folio

**Show your work. Find your people.**

BEAN Folio is a professional portfolio & discovery platform for every profession — video editors,
developers, architects, photographers, chefs, and beyond. One universal project model (brief →
process → challenges → outcome) works for any craft: publish work with real process narrative,
get discovered through a recency-and-relevance feed (never follower-count-only), connect through
inquiries and follows, and keep control of your data with export, deletion, and consent-gated AI.

This repository contains the full product as built in a constrained sandbox: a Next.js 16 app
serving a hash-routed SPA plus a complete REST API, Prisma + SQLite, local-disk media, and
server-side AI through a provider-independent gateway. Documentation separates **verified
facts** from **production recommendations** throughout.

---

## The 8 product areas

| # | Area | What it does | Status in this build |
|---|---|---|---|
| 1 | **Discover** | Editorial feed of public work with ranking reasons; recency-decayed engagement + profession match + new-creator boost | Implemented & browser-verified (E2E) |
| 2 | **Explore** | Search across projects and people (text, profession, skill; sort by recent or saves) | Implemented & browser-verified (E2E) |
| 3 | **My Folio** | Your profile, taxonomy (professions/skills), avatar/cover, real stats | Implemented & browser-verified (E2E) |
| 4 | **Create Studio** | Universal project model: draft → publish gate → unpublish; media, skills, tools, contributors | Implemented & browser-verified (E2E, incl. upload + publish) |
| 5 | **BEAN Intelligence** | Consent-gated AI: improve writing, suggest metadata, portfolio chat — own-data-only grounding, 30/day quota | Implemented & browser-verified (real LLM calls, grounded answers) |
| 6 | **Connect** | Inquiries (accept/decline), follows, saves & collections, notifications, blocks & reports | Implemented & browser-verified (E2E: follow, save, inquiry→accept) |
| 7 | **Insights** | Owner-only, honestly-labelled-estimated analytics from real dedup tables (14-day series, top projects) | Implemented & browser-verified (real deduped data) |
| 8 | **Trust & Settings** | Visibility controls, AI consent, data export, account deletion, audit log | Implemented & browser-verified (export job; deletion flow tested pre-integration) |

**Production roadmap** (designed, not built — each doc explains the exact path): Google OAuth via
Supabase (`docs/google-auth.md`), S3 media pipeline with worker/transcoding
(`docs/media-pipeline.md`), PostgreSQL + full-text search (`docs/database.md` §6), NestJS API +
Expo mobile + server-rendered pages (`docs/architecture.md` §5), production deployment
(`docs/deployment.md`).

> **Status note:** all 15 feature views are fully implemented, and the whole product was
> verified end-to-end in a real browser (register → onboarding → create + upload + publish →
> discover → follow → inquiry → AI → insights → export), including server-side authorization
> spot checks (401/403/404 matrix) and a zero-console-error fresh-session check. See
> `worklog.md` (final integration entry) for the verified evidence list.

## Tech stack (as actually used)

| Layer | Technology |
|---|---|
| App | Next.js 16 (App Router, standalone output), React 19 |
| Language | TypeScript 5 (strict) |
| UI | Tailwind CSS 4 + shadcn/ui ("new-york"), dark obsidian + champagne-gold brand, framer-motion |
| Data | Prisma 6 + SQLite (27 models) |
| AI | `z-ai-web-dev-sdk` server-side only, behind `src/lib/ai.ts` gateway |
| Auth | scrypt password hashing, opaque DB-backed sessions in httpOnly cookies |
| Validation | zod v4 at every API boundary |
| Runtime | bun (install, dev, build, scripts) |

## Quick start

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

# Quality gates
bun run lint             # eslint
bunx tsc --noEmit        # type check (recommended before builds)
```

The app is a **hash-routed SPA under `/`** — pages look like `/#/discover`, `/#/u/:username`,
`/#/studio/new`, `/#/p/:id`. Deep links and back/forward work; there is no server-side rendering
for profile/project pages (documented trade-off: `docs/architecture.md` §3).

## Repository structure

```
├── README.md                  ← you are here
├── worklog.md                 ← build log: audit, API contract, per-task entries (source of truth)
├── .env.example               ← DATABASE_URL + commented production placeholders
├── prisma/schema.prisma       ← 27-model domain model (SQLite)
├── db/custom.db               ← SQLite database file
├── scripts/                   ← seed.ts (demo fixtures, isDemo-marked) + gen-seed-images.ts
├── uploads/                   ← local media storage (served via /api/media/:id/raw)
├── src/
│   ├── app/
│   │   ├── page.tsx           ← SPA shell: providers, nav, hash router, gates
│   │   ├── layout.tsx, globals.css
│   │   └── api/**/route.ts    ← ~50 REST route files (docs/api.md)
│   ├── views/*.tsx            ← 15 feature views (stubs at docs time)
│   ├── components/
│   │   ├── bean/*             ← shared atoms: ProjectCard, PersonCard, TagInput, MediaUploadButton…
│   │   └── ui/*               ← shadcn/ui primitives
│   └── lib/                   ← client: client.ts, hash-router.ts, session.tsx, types.ts
│                                 server: auth.ts, api-helpers.ts, serialize.ts, media.ts, ai.ts, db.ts
└── docs/                      ← the documentation suite (below)
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | As-built system shape, layering diagram, sandbox constraints, production extraction map |
| [docs/product-spec.md](docs/product-spec.md) | The 8 areas, universal project model, visibility rules, feed ranking, personas |
| [docs/api.md](docs/api.md) | REST reference for every endpoint: auth, bodies, responses, errors, rate limits, deviations |
| [docs/database.md](docs/database.md) | All 27 models, constraints/indexes, JSON fields, view dedup, PostgreSQL path |
| [docs/security.md](docs/security.md) | Passwords/sessions, authorization, visibility, validation, media safety, gaps + recommendations |
| [docs/google-auth.md](docs/google-auth.md) | Google OAuth + Supabase production setup (documented boundary — not implemented) |
| [docs/media-pipeline.md](docs/media-pipeline.md) | Upload flow as built + S3/worker production design |
| [docs/ai-integration.md](docs/ai-integration.md) | BEAN Intelligence gateway, consent, quotas, safeguards, provider swap |
| [docs/deployment.md](docs/deployment.md) | What runs today (dev-grade), production runbook, pre-launch checklist |
| [docs/testing.md](docs/testing.md) | What was verified (static + live API), recommended test setup, critical cases |
| [docs/known-limitations.md](docs/known-limitations.md) | The honest limitations list with fix paths |

## What's verified vs not

**Verified in this sandbox:** `bun run lint` clean; `bunx tsc --noEmit` clean for all backend
product files; and live API smoke tests of the real flows — auth lifecycle, onboarding, profile
updates, follow/unfollow, project CRUD with publish gates and the full visibility ladder, view
dedup (checked through insights), discover ranking with observed reasons, search filters, saves
and collections, inquiries with accept/decline notifications, blocks, reports, privacy, export,
deletion with session revocation, and **real LLM calls** for AI chat/improve/suggest through the
configured provider. **Not done:** no production deployment, no automated test suite (the
sandbox forbade adding test runners), no browser-level E2E of finished UI views (they were
stubs during verification), no external integrations (Google/S3/Supabase are documented designs,
never faked). The complete list lives in [docs/known-limitations.md](docs/known-limitations.md);
the verification details are in [docs/testing.md](docs/testing.md).
