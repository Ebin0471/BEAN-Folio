# Phase 6 audit — production readiness & database migration readiness

Audit-first record (no Phase 6 code was changed before this document). Sources
read: `05-laxii-phase3-delivery.md`, `07-code-giftz-phase4-delivery.md`,
`07a-code-giftz-planner-fix-delivery.md`, `08-phase5-integration-delivery.md`
(§ referenced as the Phase 5 delivery), `02-architecture.md`,
`worklog.md` (Tasks 30–36), `prisma/schema.prisma` (SQLite),
`prisma/schema.postgres.prisma`, `docs/deployment/{initial,additive}-schema.sql`,
`scripts/check-postgres-{connection,schema-readiness}.ts`,
`scripts/migrate-to-postgres.ts`, `scripts/verify-postgres-migration.ts`,
`Caddyfile`, `.env.example`, `package.json` + lockfile, and the import graph of
every module named below (verified with exhaustive `rg` importer searches on
this working tree).

---

## 1. Verified baseline (before any Phase 6 change)

| Check | Result |
|---|---|
| `bun test` | 336 pass / 0 fail (21 files, ~2,100 assertions) |
| `tests/phase5-integration.test.ts` | 12 pass / 0 fail |
| `bun run lint` | 0 problems (exit 0) |
| `bunx tsc --noEmit` | exit 2 — **87 errors** (attribution in §2) |
| Schema mirrors | 39 models (SQLite) vs **38 (Postgres) — `AgentArtifact` missing from the Postgres mirror** |
| DB (SQLite dev) | 36 tables exist; **no `Portfolio`/`PortfolioRevision` tables anywhere** |
| Production build | never verified in this sandbox (prior phases documented it as "not runnable") |
| Dependency advisories | 25 (20 moderate / 5 high) against the generated lockfile (§3) |

## 2. TypeScript debt — all 87 errors attributed

Exhaustive importer searches (package-style and relative, `src` + `tests`,
excluding `*.disabled`) place every error in exactly one of six groups:

### A. Stale duplicate module — `src/lib/hash-router.ts` vs `src/lib/hash-router.tsx` (2 errors)

- `src/lib/hash-router.ts` (156 lines) is an OLD copy without
  `BootRouteProvider`/`useBootRoute`; `hash-router.tsx` (240 lines) is the LIVE
  module (exports both). TS resolves the `.ts`; the runtime (bundler) resolves
  the `.tsx` — which is why the app works while tsc fails.
- Errors: `standalone-site.ts` `useBootRoute` (1), `SiteShell.tsx`
  `BootRouteProvider` (1). Runtime implication: none (correct file wins at
  runtime), but the duplicate is a silent-divergence footgun.
- **Fix: delete the stale `hash-router.ts`** (single source of truth).

### B. Dead LAXII "old vocabulary" cluster (28 errors)

Import-graph evidence: `laxii/creative.ts` is imported by nobody;
`engine.ts` only by `creative.ts`; `providers/capabilities.ts` only by
`creative.ts` + `engine.ts`; `pipeline/{compose,validate}.ts` only by
`engine.ts`; `pipeline/{segment,quality}.ts` only by each other and a
**disabled** test. The LIVE generation path is
`api/laxii/generate → laxii/jobs.ts → router.ts → providers/* → image-ops/retry/types`
plus `banner-pipeline.ts` and `laxii/quality.ts` (distinct from
`pipeline/quality.ts`). The dead cluster references type/function names
(`LaxiiRequest`, `ProviderCapabilities`, `ImageProvider`, `SizeRequest`,
`ExportFormat`, `TextToImageRequest`, `ImageToImageRequest`, `ColorGrade`,
`nearestGenerationSize`, `anyStyle`) that were REMOVED from `types.ts`/`styles.ts`
in the Phase 3 refactor. Classification: **obsolete code** (not a compiler or
dependency problem). Runtime implication: none (never imported); risk: silent
divergence and accidental revival.
- Errors: `creative.ts` 2, `engine.ts` 7, `providers/capabilities.ts` 6,
  `pipeline/segment.ts` 4, `pipeline/quality.ts` 2, `pipeline/compose.ts` 2,
  `pipeline/validate.ts` 1.
- **Fix: delete the dead cluster** (`creative.ts`, `engine.ts`,
  `providers/capabilities.ts`, `pipeline/` directory), documented file-by-file.
  Git history preserves everything.

### C. Dead `ai-design/driver.ts` (8 errors)

`driver.ts` drives the PRE-Phase-4 in-memory design-job API
(`claimJob/persistJob/releaseLease/applyFailure/appendEvent` — removed from
`ai-design/jobs.ts` by the Phase 4 durable-job rework; `DesignJob.context`
removed; `fetchPortfolioBlock` gone from `context.ts`). No file imports
`driver.ts` (the LIVE design-agent surface is `jobs/execute/verify/diff/digest/
plan`, exercised by the 40-test `design-agent.test.ts`). Classification:
**obsolete code**. **Fix: delete `driver.ts`.**

### D. Dead "Portfolio" generation — missing Prisma models (16 errors + runtime 500s)

`portfolio-server.ts` and seven HTTP-reachable routes
(`/api/portfolio{,/publish,/unpublish,/import,/export,/revisions…}` and
`/api/site/[slug]`) query `db.portfolio` / `db.portfolioRevision` — **models
that exist in NEITHER schema mirror** (and neither table exists in the dev
DB). Every call would fail at runtime with `PrismaClientValidationError`.
The UI that consumed this API (`PortfolioStudioView` 3,295 lines,
`PortfolioSiteView`, `PortfolioCaseStudyView`, `components/bean/portfolio/*`
incl. the only `react-syntax-highlighter` consumer) is **mounted nowhere** —
`SiteShell` mounts `WebsiteBuilderView` at `#/website`, which uses the LIVE
`SiteDesign`/`SiteRevision` persistence (`/api/me/site*`). Classification:
**obsolete code generation left behind by an abandoned direction**, with
reachable-but-broken routes. Errors: `portfolio-server.ts` 3, portfolio route
files 12, `site/[slug]/route.ts` 1.
- **Fix: remove the dead generation** (routes + views + portfolio components +
  `portfolio-server.ts`; `portfolio-schema.ts`/`portfolio-defaults.ts` are only
  consumed by the same dead cluster and go with it). Adding the missing models
  instead would resurrect an unmounted feature — rejected as a scope violation.

### E. LIVE-code typing defects (8 errors — the only group touching live logic)

1. `conversations.ts` queries `selectedAssetId` on `LaxiiMessage` (3 errors:
   TS2339 select-where ×3). **The Prisma model has no such column** — these
   queries would throw `PrismaClientValidationError` at runtime the first time
   the "jump to previous selected asset" lineage path runs. Genuine latent
   bug. **Fix: derive the parent asset from `LaxiiImageVersion.isSelected`**
   (the actual schema) via the message relation.
2. `conversations.ts` operation tokens `"REMOVE_BG"`/`"OUTPAINT"` vs a union
   spelling `"REMOVE_BACKGROUND"`/"EXPAND" (2 errors) — stale union in a
   local type; align with `LaxiiOperation`/`LaxiiClientOperation` in `types.ts`.
3. `conversations.ts` refs nullability (1 error) — `width/height: number | null`
   vs a stricter local ref type; widen the local type (matches the schema).
4. `service.ts` `JobMessageRow` requires `updatedAt` but 3 call sites select a
   shape without it (3 errors) — add `updatedAt` to the selects (the field
   exists on the model).

### F. Stale/dirty scripts (25 errors)

- `scripts/tmp/*` session debris — 20 errors (top-level `await` in
  non-module files, null-guard nits, a wrong conversion). **Fix: delete the
  debris** (probe/verification one-offs; their evidence lives in the delivery
  docs).
- `scripts/migrate-cover-focal.ts` (5) — written against a `coverPosition`
  field that shipped as `coverPositionY` (+`coverPosY` filter names); the
  migration it encodes demonstrably already happened (the field exists in both
  mirrors). Classification: stale one-shot. **Fix: delete** (git-recoverable).
- `scripts/laxii/reproduce-avatar.ts` (1) — imports a removed type name;
  `scripts/laxii/prefetch-models.ts` (1) — imports `@huggingface/transformers`
  (an optional local-provider dependency that was never installed).
  **Fix: delete both** (dev one-offs tied to the dead cluster / inactive local
  provider).

Total: A 2 + B 28 + C 8 + D 16 + E 8 + F 25 = **87**. After fixes A–F the
target is **0 errors with zero `any`/`@ts-ignore`/config weakening**.

## 3. Dependency audit (lockfile-generated, isolated; no installs yet)

Method: copied `package.json` to an isolated temp dir, generated a lockfile
(`npm install --package-lock-only`), ran `npm audit` (25 findings: 20 moderate,
5 high); usage-checked all 98 direct deps against `src/tests/scripts/configs`.

**Vulnerable chains that matter (runtime attack surface):**

| Chain | Severity | Fix | Risk of fix |
|---|---|---|---|
| `sharp` ≤0.34 (libvips/libheif/librsvg CVEs) — processes USER-UPLOADED images | **5× high** | `sharp@0.35.5` (major) | API stable; verify with media + banner suites and a real PNG/JPEG round-trip |
| `@mdxeditor/editor` → js-yaml DoS | high | **package is UNUSED** → remove | none |
| `react-syntax-highlighter` → refractor → prismjs | high/mod | only consumer is a dead Portfolio component → **removed with cluster D** | none |
| `prisma` → @prisma/config → deepmerge-ts stack exhaustion | high | non-breaking `npm audit fix` (prisma 6.x bump) | verify `db:push`/`generate` + suite |
| eslint → minimatch (moderate) | moderate | fix path is nonsensical (eslint@4) | **accept + document** (dev tooling only) |

**Unused direct dependencies (verified zero references in src/tests/scripts/
configs):** `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`,
`@hookform/resolvers` (react-hook-form itself IS used by `ui/form.tsx`),
`@mdxeditor/editor`, `@reactuses/core`, `@tanstack/react-query`,
`@tanstack/react-table`, `date-fns`, `next-auth`, `next-intl`,
`react-markdown`, `uuid`, `zustand`, plus `react-syntax-highlighter` and its
`@types/*` after D. `prisma` is deliberately KEPT (used by every `db:*`
script). `tailwindcss-animate` is referenced by `tailwind.config.ts` — kept
(Tailwind 4 also imports `tw-animate-css`; re-evaluating that split is out of
scope).

## 4. Database readiness

- **Parity defect (critical for deployment):** `AgentArtifact` (Phase 5) exists
  only in the SQLite mirror. The production build path
  (`vercel-build` → `prisma generate --schema prisma/schema.postgres.prisma`)
  would generate a client WITHOUT `db.agentArtifact` → every Phase 5 handoff/
  artifact call would crash in production. **Fix: add the model to the
  Postgres mirror** (additive, following the mirror's existing style).
- **Portfolio models** exist in neither mirror (§2-D) — after removing the
  dead generation, parity is restored (38 models both sides).
- **Migration artifacts**: `docs/deployment/initial-schema.sql` is explicitly
  marked a HISTORICAL ARTIFACT (31-table era) whose header documents the
  correct regeneration command:
  `bunx prisma migrate diff --from-empty --to-schema-datamodel
  prisma/schema.postgres.prisma --script`. `additive-schema.sql` covers the
  LAXII-era additions only. **Phase 6 regenerates both artifacts** for the
  current 38-model schema (fresh DDL + additive delta from the deployed
  36-table baseline) and updates
  `scripts/check-postgres-schema-readiness.ts` (currently expects 36 tables).
- **Migration history**: Prisma `migrate` is NOT used (no `migrations/`
  directory); the flow is `db push` for dev + reviewed SQL artifacts for
  deployment (`migrate-to-postgres.ts` exists for the initial copy). No
  production migration will be run in this phase.
- **SQLite-specific incompatibilities to check during DDL review**: no native
  enums (all `String` + documented vocabularies — already portable), JSON as
  TEXT columns (portable), `DateTime` mapping (`TIMESTAMP(3)` in Postgres DDL),
  case-insensitive unique on email handled at application layer, no
  `Json`-typed columns to convert.

## 5. Security audit scope (findings in the delivery report)

Areas under review: password hashing (scrypt), session cookies
(`bean_session`, hashed tokens, SameSite/secure posture), the custom (non-
NextAuth) session flow, ownership enforcement + 404-indistinguishability
across all agent routes, giftz workspace confinement + command allowlist +
redaction + kill registry, artifact bytes path (approval-gated),
media upload pipeline (type sniffing, size caps, storage keys), logging/error
disclosure (`dev.log`, run tails), rate limits (in-memory, per-instance),
AI consent gating, private-portfolio context handling, the
(origin-proof)/(standalone) public surfaces. Preliminary observations recorded
during the audit are carried into the severity-ranked findings in the delivery
document — a passing test suite is NOT treated as evidence of security.

## 6. Production build readiness (investigation plan)

Prior phases recorded "build not runnable in sandbox" without root cause.
This phase determines the actual blocker by building an ISOLATED COPY
(separate worktree + copied `node_modules`, throwaway SQLite DB, explicit
`DATABASE_URL`) so the running dev server's `.next` is untouched:
1. does `next build` compile the app (type/typecheck/lint stages)?
2. does any module read env at import time (build-time env requirements)?
3. do any routes attempt DB/FS access during static generation?
4. does the memory/CPU budget of the sandbox allow the full Turbopack build?
Result — honest: either a reproducible procedure with real exit codes, or the
exact failing step and its root cause. No fabricated build claims.

## 7. Regression protection protocol

After EACH fix group (A–F, dependency change, schema change): `bun run lint`,
`bunx tsc --noEmit`, full `bun test` (336+ baseline must hold), plus the
targeted suites for the touched area (`giftz-*`, `phase5-integration`,
`laxii-*`, `design-agent`, `media-upload`, `site-*`). At the end: browser
smoke of the live surfaces (discover, studio, laxii, giftz, website builder)
and a server-restart persistence check.
