# Task 2-c — Universal Profession Taxonomy (Phase 3, Global Scale)

**Agent:** profession-taxonomy (2-c)
**Status:** COMPLETE (one pre-existing, unrelated test failure documented in §8 — belongs to the giftz/site-studio agent)

## 1. Files delivered + seeded counts

| File | State |
|------|-------|
| `src/lib/professions/taxonomy.ts` | NEW — pure-data tree: 13 `ProfessionFamilySeed` → 221 `ProfessionSeed` → 39 `SpecialismSeed`; exports `PROFESSION_FAMILIES`, `LEGACY_PROFESSIONS` (frozen 18), `flattenTaxonomy()` |
| `src/lib/professions/service.ts` | NEW — `syncTaxonomyToDb()`, `listFlat()`, `listTree()`, `getProfession()`, `resolveActiveSlugs()` (canonical; `resolveSlugs` kept as alias), `normalizeProfessionSlug(s)()`, `invalidateProfessionsCache()`; all reads cached |
| `scripts/seed-professions.ts` | NEW — idempotent seed; prints counts |
| `src/app/api/professions/route.ts` | REWRITTEN — legacy flat shape via `listFlat()`, `?tree=1` via `listTree()`; `force-dynamic` kept |
| `src/app/api/professions/[slug]/route.ts` | NEW — detail or typed 404 (`ERR.notFound()`) |
| `src/lib/categories.ts` | EXTENDED — legacy 18 first (byte-identical labels), then full taxonomy by family; `categoryLabel()` unchanged |
| `src/lib/use-professions.ts` | EXTENDED (comment/doc) — client hook falls back to the full taxonomy map |
| `src/app/api/me/onboarding/route.ts` | VALIDATION UPDATE ONLY — `requireProfessionIds` now resolves any active DB slug via service |
| `src/app/api/me/profile/route.ts` | VALIDATION UPDATE ONLY — same resolution + `cacheInvalidateEvent("profile.update")` wired for professions changes |
| `tests/profession-taxonomy.test.ts` | NEW — 14 data-level tests |
| `docs/PROFESSION_TAXONOMY.md` | NEW — structure, expansion procedure, backward-compat contract, multi-profession + patient-confidentiality notes |
| `src/lib/cache.ts` | Materialized by this task earlier in the phase (see its header NOTE): agreed surface `cacheKey`, `profilePublicCacheKey`, `cacheGet`, `cacheSet`, `cacheDelete`, `cacheInvalidateEvent` — reconciled with the other agent's call sites |

**Seed run (`bun scripts/seed-professions.ts`):**
```
taxonomy source : 13 families / 221 professions / 39 specialisms
database        : 13 families / 221 professions (221 active) / 39 specialisms
legacy coverage : 18/18 legacy slugs present
```
Rerun-verified idempotent (counts stable; legacy rows keep ids, order 1..18, groups).

**Specialisms coverage (2–6 each, mandated 10 + more):** news-anchor 3, reporter 3,
photojournalist 3, fullstack-dev 3, photographer 4, doctor 4, chef 4,
legal-professional 4, teacher 4, architect 4 (39 specialisms total across key crafts).

## 2. Legacy mapping (frozen — identical slug/label/group, order 1..18)

| Legacy slug | Label | Group | Family |
|---|---|---|---|
| film-video | Film & Video | Film & Motion | film-audio-entertainment |
| motion-design | Motion Design | Film & Motion | creative-arts |
| photography | Photography | Visual Arts | creative-arts |
| graphic-design | Graphic Design | Design | creative-arts |
| ui-ux | UI/UX Design | Design | **technology** |
| product-design | Product Design | Design | creative-arts |
| illustration | Illustration | Visual Arts | creative-arts |
| art | Fine Art | Visual Arts | creative-arts |
| software-dev | Software Development | Technology | technology |
| architecture | Architecture | Built Environment | architecture-engineering |
| civil-engineering | Civil Engineering | Built Environment | architecture-engineering |
| writing | Writing & Journalism | Media | writing-publishing |
| education | Education & Research | Media | education-research |
| culinary | Culinary & Hospitality | Hospitality | skilled-trades-services |
| marketing | Marketing & Business | Business | business-practice |
| music | Music & Audio | Film & Motion | film-audio-entertainment |
| fashion | Fashion | Design | creative-arts |
| other | Other | Multi-discipline | career-development |

Family sizes: creative-arts 30, technology 25, journalism-media 35 (mandated
richest — all 35 exact slugs verified), writing-publishing 14,
film-audio-entertainment 19, business-practice 19, architecture-engineering 16,
education-research 11, health-wellness 11 (family description carries the
patient-confidentiality duty), science-environment-agriculture 11,
public-service-community 8, skilled-trades-services 16, career-development 7.
`student` exists exactly once (education-research).

## 3. API contract — old vs new

| Endpoint | Before | After |
|---|---|---|
| `GET /api/professions` | `{ professions: [{slug,label,group}] }`, `orderBy: order asc` (18 rows), seed-on-read | SAME shape + SAME first 18 entries in historical order; then new professions by family order → row order. Empty-table bootstrap now seeds the full taxonomy. `force-dynamic` kept |
| `GET /api/professions?tree=1` | — | NEW `{ families: [{ slug, label, description, order, professions: [{ slug, label, description, aliases, order, specialisms: [{slug,label}] }] }] }` |
| `GET /api/professions/:slug` | — | NEW `{ profession: { slug, label, group, description, aliases, order, active, family:{slug,label}\|null, specialisms:[{slug,label,order}] } }`; typed 404 `{error:"Not found"}` for unknown/inactive |
| `POST /api/me/onboarding` | 18 slugs only; `400 "One or more professions are not recognized"`; 1–5 | ANY active DB slug (normalized trim/lowercase/spaces→hyphens); same 400 shape + same zod 1–5 limit. Smoke-tested: `"  Photojournalist ",FACT-CHECKER,film-video` → onboarded with 3 professions |
| `PATCH /api/me/profile` | 18 slugs only; ≤5 | ANY active DB slug, ≤5; fires `cacheInvalidateEvent("profile.update")` when professions change; unknown slug keeps legacy 400; >5 keeps zod 400 |

`listFlat()` intentionally keeps the legacy projection `{slug,label,group}`
(the old route stripped `id`/`order`; docs note this). DB rows carry
`familySlug`/`description`/`aliases` for the new endpoints only.

## 4. tsc + test results

- `bunx tsc --noEmit` → **0 errors** (exit 0)
- `bun test tests/profession-taxonomy.test.ts` → **14 pass / 0 fail** (1395 expect calls)
- `bun run lint` → **clean**
- **Full `bun test`: 453 pass / 1 fail** across 30 files (5287 expects).
  The single failure is **pre-existing and unrelated** — see §8.

## 5. Cache import surface used

`import { cacheGet, cacheSet, cacheDelete, cacheInvalidateEvent, cacheKey } from "@/lib/cache"`
— exact agreed surface. Keys: `professions:flat`, `professions:tree`,
`professions:detail:<slug>`, `professions:slugmap`; TTL 5 min; every entry
tagged `professions.changed`; `syncTaxonomyToDb()` fires
`cacheInvalidateEvent("professions.changed")`. `cacheGet`'s `_cachedAt` object
stamp is stripped from the one cached object shape (ProfessionDetail);
arrays (flat/tree) are never stamped. Profile route fires
`cacheInvalidateEvent("profile.update")` after profession changes.

## 6. Fixes made on top of the earlier phase draft

1. **`ui-ux` family corrected** — was placed in `creative-arts`; the spec
   mandates `ui-ux → technology`. Moved; re-seeded; DB `familySlug` now
   `technology` (verified via table dump).
2. **`listFlat()` ordering hardened** — mid-phase draft sorted by family order
   first, which would have put `motion-design` at index 0 and reordered every
   existing UI dropdown. Now: legacy block first (historical 1..18,
   `film-video` at index 0 — byte-compatible with the pre-expansion route),
   then new professions by family order → row order → slug. Verified live
   (index 0..17 = exact legacy sequence; ui-ux at index 4; new families follow
   in order Creative Arts → Technology → Journalism → …).

## 7. Verification performed (live dev server, port 3000)

- Flat: 221 rows; indexes 0–17 = frozen legacy order; groups of new rows change family-by-family.
- Tree: 13 families in order; journalism-media richest (35); `news-anchor` returns aliases `["Newsreader","Broadcast News Anchor"]` + 3 specialisms.
- Detail: `ui-ux` → family `technology`; `"News Anchor"` (spaced/case) normalizes → `news-anchor`; unknown slug → HTTP 404 typed error.
- Onboarding: registered fresh user, onboarded with mixed-case/padded new slugs → 200, professions persisted.
- Profile PATCH: new slug accepted; unknown slug → legacy 400 message; 6 professions → zod 400.
- Cache: repeated requests served consistently; ordering fix visible after module reload (TTL 5 min).

## 8. ⚠️ Pre-existing failure outside my ownership (for reconciliation)

`tests/giftz-engine.test.ts` → "J. failed-task recovery (restart sweep) >
stale ACTIVE tasks are honestly failed by the sweep and become retryable"
**fails on the current working tree (28/29 in that file) but passes on HEAD.**

Root cause is NOT the taxonomy work: another agent's uncommitted change to
`src/lib/giftz/jobs.ts` raised the engineering-task staleness threshold from
**10 min** (`STALE_MS`, HEAD) to **60 min** (`SWEEP_STALE_MS.ENGINEERING_TASK`),
while the test simulates a **15-minute** stale EXECUTING task → sweep returns 0.

Proof of independence: (a) the giftz engine imports none of my modules
(grep: no `@/lib/cache`, `categories`, `professions` anywhere in the giftz
import chain); (b) stashing ONLY my four modified files
(`categories.ts`, `use-professions.ts`, `onboarding/route.ts`, `profile/route.ts`)
still yields the identical 28 pass / 1 fail.

Per file-ownership rules I did not touch `src/lib/giftz/jobs.ts`. Reconciler
options: restore the 10-min engineering threshold (keep 30-min studio turns),
or update the test's staleness simulation to > 60 min. Everything else in the
suite is green.

## 9. Notes for downstream agents

- Consume `@/lib/professions/service` (never hand-query `profession` for
  pickers/validation): `listFlat()` (cached), `listTree()`, `getProfession()`,
  `resolveActiveSlugs()`; normalize free text with
  `normalizeProfessionSlugs()` first.
- `resolveSlugs` remains exported as a deprecated alias — migrate call sites
  to `resolveActiveSlugs` when convenient (both `/api/me` routes already use it).
- Seed after any taxonomy edit: `bun scripts/seed-professions.ts`.
- After editing `taxonomy.ts`, run `bun test tests/profession-taxonomy.test.ts`
  (pins legacy immutability, ≥130 professions, 13 families, slug/label
  uniqueness, specialism integrity, journalism core).
