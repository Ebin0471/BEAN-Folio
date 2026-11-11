# BEAN Folio — Universal Profession Taxonomy

Phase 3 of the Global Scale upgrade. Expands the original 18 curated
professions into a 13-family taxonomy of **221 professions** (with specialisms
for key crafts), while keeping the platform byte-compatible for every existing
consumer.

- **Single source of truth (data):** `src/lib/professions/taxonomy.ts`
  (pure data — no imports, safe for client bundles and server code).
- **Single source of truth (DB sync + queries):** `src/lib/professions/service.ts`
- **Seed command:** `bun scripts/seed-professions.ts` (idempotent; safe to rerun)
- **Contract tests:** `tests/profession-taxonomy.test.ts` (data-level, no DB needed)

---

## 1. Structure

```
ProfessionFamily (13)
└── Profession (221, all active)
    └── Specialism (39 — narrow skills within key professions)
```

| # | Family slug | Label | Professions |
|---|-------------|-------|-------------|
| 1 | `creative-arts` | Creative Arts & Design | 30 |
| 2 | `technology` | Technology & Software | 25 |
| 3 | `journalism-media` | Journalism & Media | 35 *(mandated richest)* |
| 4 | `writing-publishing` | Writing & Publishing | 14 |
| 5 | `film-audio-entertainment` | Film, Audio & Entertainment | 19 |
| 6 | `business-practice` | Business & Professional Practice | 19 |
| 7 | `architecture-engineering` | Architecture & Engineering | 16 |
| 8 | `education-research` | Education & Research | 11 |
| 9 | `health-wellness` | Health & Wellness | 11 |
| 10 | `science-environment-agriculture` | Science, Environment & Agriculture | 11 |
| 11 | `public-service-community` | Public Service & Community | 8 |
| 12 | `skilled-trades-services` | Skilled Trades & Services | 16 |
| 13 | `career-development` | Career Development | 7 |

Each seed entry (`ProfessionFamilySeed`) carries `slug`, `label`,
`description`, `order` and `professions[]`; each profession carries `slug`,
`label`, `description`, optional `aliases[]` (search/matching only — never
rendered as the canonical label) and optional `specialisms[]` (2–6 for key
professions such as news-anchor, reporter, photojournalist, fullstack-dev,
photographer, doctor, chef, legal-professional, teacher, architect).

`flattenTaxonomy()` in `taxonomy.ts` projects the tree to a flat list with the
legacy `group` label and legacy `order` applied (see §3).

---

## 2. Legacy mapping (18 slugs → families)

The 18 original slugs keep **identical slug, label and flat `group`** values.
They live inside their host family (legacy rows first), and keep historical
`order` 1..18 — new professions start at order 20.

| Legacy slug | Label (frozen) | Flat group (frozen) | Family |
|-------------|----------------|---------------------|--------|
| `film-video` | Film & Video | Film & Motion | film-audio-entertainment |
| `motion-design` | Motion Design | Film & Motion | creative-arts |
| `photography` | Photography | Visual Arts | creative-arts |
| `graphic-design` | Graphic Design | Design | creative-arts |
| `ui-ux` | UI/UX Design | Design | technology |
| `product-design` | Product Design | Design | creative-arts |
| `illustration` | Illustration | Visual Arts | creative-arts |
| `art` | Fine Art | Visual Arts | creative-arts |
| `software-dev` | Software Development | Technology | technology |
| `architecture` | Architecture | Built Environment | architecture-engineering |
| `civil-engineering` | Civil Engineering | Built Environment | architecture-engineering |
| `writing` | Writing & Journalism | Media | writing-publishing |
| `education` | Education & Research | Media | education-research |
| `culinary` | Culinary & Hospitality | Hospitality | skilled-trades-services |
| `marketing` | Marketing & Business | Business | business-practice |
| `music` | Music & Audio | Film & Motion | film-audio-entertainment |
| `fashion` | Fashion | Design | creative-arts |
| `other` | Other | Multi-discipline | career-development |

Dedupe note: `student` exists **once** (education-research); no slug appears in
two families. `LEGACY_PROFESSIONS` in `taxonomy.ts` is the frozen identity
table; tests pin every row byte-for-byte against the pre-expansion seed.

---

## 3. Backward-compatibility contract

1. **Flat API shape unchanged.** `GET /api/professions` still returns
   `{ professions: [{ slug, label, group }] }` — exactly three fields per row,
   active rows only. (DB rows carry `id`/`order`, but the legacy projection
   keeps them out of this payload, as before.)
2. **Flat ordering unchanged.** The response starts with the 18 legacy rows in
   their historical order 1..18 (`film-video` first, `other` last) — the exact
   sequence the pre-expansion route returned via `orderBy: { order: "asc" }`.
   New professions follow, grouped by family order then row order.
3. **Legacy rows are immutable.** Slugs, labels and groups are never renamed or
   regrouped. `syncTaxonomyToDb()` never deletes rows — even if a slug were
   removed from the seed file, the DB row (and any `ProfileProfession` join
   referencing it) survives; retired rows are deactivated, never deleted.
4. **Existing `group` semantics.** Legacy rows keep their historical flat group
   ("Film & Motion", "Visual Arts", …); new professions use their family label
   as the flat group, so old group values only ever gain siblings, never lose.
5. **Onboarding/profile validation errors unchanged.** Unknown profession slugs
   still yield `400 { "error": "One or more professions are not recognized" }`;
   the 1–5 professions-per-user limit is enforced with the same zod message.

### API surface

| Endpoint | Shape | Notes |
|----------|-------|-------|
| `GET /api/professions` | `{ professions: [{ slug, label, group }] }` | unchanged legacy shape + ordering; `force-dynamic` |
| `GET /api/professions?tree=1` | `{ families: [{ slug, label, description, order, professions: [{ slug, label, description, aliases, order, specialisms: [{ slug, label }] }] }] }` | new, additive |
| `GET /api/professions/:slug` | `{ profession: { slug, label, group, description, aliases, order, active, family: { slug, label } \| null, specialisms: [{ slug, label, order }] } }` | new; typed 404 `{ "error": "Not found" }` for unknown/inactive slugs |
| `POST /api/me/onboarding` | unchanged; `professions` now accepts **any active DB slug** (1–5, normalized: trim → lowercase → spaces to hyphens) | legacy error shapes kept |
| `PATCH /api/me/profile` | unchanged; `professions` now accepts **any active DB slug** (≤5); fires `cacheInvalidateEvent("profile.update")` when professions change | legacy error shapes kept |

---

## 4. Multi-profession profiles

A user may attach **up to 5 professions** (validated by zod `min(1).max(5)` on
onboarding, `max(5)` on profile PATCH). Joins live in `ProfileProfession`
(`userId` + `professionId`); the service resolves user-supplied slugs → active
`Profession.id`s via `resolveActiveSlugs()` (case/whitespace-normalized, exact
slug match, duplicates dropped). Slugs are stored nowhere on the profile —
taxonomy changes automatically re-label every profile through the join.

---

## 5. Health & Wellness — patient confidentiality

The `health-wellness` family description explicitly notes that health work is
**bound by patient-confidentiality duties** (HIPAA-style professional ethics).
Portfolio content for doctors, nurses, psychologists, counselors and related
professions must never expose patient data; any future feature that surfaces
user work (site exporter, AI planner, search) must treat health-family
profiles with that duty in mind. The constraint lives in the family
description in `taxonomy.ts` so it travels with every consumer that renders
family context.

---

## 6. Expansion procedure (adding professions later)

1. **Edit `src/lib/professions/taxonomy.ts`** — add professions to a family
   (append new entries after the legacy block of that family; never touch
   `LEGACY_PROFESSIONS` or legacy rows). Follow the `p(...)` / `s(...)`
   builder style; give every entry a one-line `description`.
2. **Run the contract tests:** `bun test tests/profession-taxonomy.test.ts`
   — they enforce slug format/uniqueness, ≥6 professions per family, unique
   labels per family, specialism references, and legacy immutability.
3. **Seed:** `bun scripts/seed-professions.ts` — idempotent upserts
   (family → profession → specialism by slug). It prints taxonomy vs. DB
   counts and legacy coverage. Never edits/deletes unrelated rows.
4. **Fallbacks stay in sync automatically:** `src/lib/categories.ts` builds
   `CATEGORY_LABELS` from the taxonomy (legacy 18 first, then families), and
   `src/lib/use-professions.ts` mirrors it client-side, so new slugs appear in
   offline fallbacks without extra edits.
5. **Cache:** reads are cached under the `professions:` prefix (TTL 5 min,
   tagged `professions.changed`); `syncTaxonomyToDb()` invalidates the event,
   so a re-seed takes effect immediately on the next request.

### Retiring a profession

Flip the row to `active: false` in the DB (there is intentionally no UI for
this). `listFlat()`/`getProfession()`/`resolveActiveSlugs()` only surface
active rows; historical `ProfileProfession` joins are untouched. Never delete
rows.
