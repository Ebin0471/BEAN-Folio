# Task 4-b — Profession Template Families: Technology Professions + Engineering Disciplines (14 entries)

Agent: 4-b template author (Z.ai Code)

## Files created (ONLY these; site-config.ts / tests / everything else untouched)

| File | Contents |
|---|---|
| `src/lib/site-templates/professions/technology.ts` | `technologyTemplates()` factory — 11 presets (category "technology-professions") |
| `src/lib/site-templates/professions/engineering.ts` | `engineeringTemplates()` factory — 3 presets (category "engineering-disciplines") |
| `scripts/tmp/check-sigs-t2.ts` | scratch signature checker — **created, run (exit 0), then DELETED** as instructed |

Both modules follow the agreed factory contract (no top-level arrays → no circular-import init order issues): they export a single factory, build sections via a local `tpl()` helper over `makeSection()` (fresh unique section ids per instantiation), and type entries as `Omit<TemplatePreset, "id"> & { id: string }` because `TemplatePreset.id` is still the closed `TemplateId` union — the ids become valid the moment the site-config integrator registers them in `TEMPLATE_IDS` and spreads these factories into `templatePresets()`. Everything except `id` is fully type-checked via `PresetDraft`.

## The 14 templates (ids, one-liners)

**technology.ts**
1. `frontend-craft` (frontend-dev) — warm dark `#171310` + peach `#f2a56b`, space-grotesk headings; hero split → featured "Interface work" → skills → timeline → contact.
2. `backend-forge` (backend-dev, software-engineer) — near-black `#0a0c0b` + teal-green `#36c793`, jetbrains-mono headings, radius none, outline buttons; classic hero → grid "Systems & services" → stats → skills → rows → contact.
3. `mobile-launchpad` (mobile-dev) — soft graphite `#1b1e22` + coral `#ef7a5a`, pill buttons, centered hero, 2-col square tiles; grid "App releases" → skills → collections(3).
4. `game-dev-arcade` (game-dev) — pure black `#000000` + red-pink `#ff2f5e` (not blue/purple-dominant), unbounded grand headings, 16/9; cover hero → featured "Games" → gallery grid "In-game captures" → skills.
5. `ai-ml-lab` (ai-engineer, ml-engineer) — deep forest `#0e1a12` + lime `#a8d84a`, sora headings; split hero → editorial "Research & models" → stats → skills → timeline.
6. `data-notebook` (data-scientist) — paper `#f7f5ee` + pine `#2f6e50`, ibm-plex-mono headings, narrow column, stacked nav; list "Analyses & notebooks" → skills → rows.
7. `analyst-report` (data-analyst, data-engineer) — light grey `#f1f2f0` + slate-olive `#6a7452`, manrope; classic hero → featured "Dashboards & reports" → stats → skills.
8. `cyber-shield` (cybersecurity) — black `#070808` + alert red `#e5484d`, geist-mono, radius none, sharp buttons, type-steps motion; rows "Security services" → list "Engagements" → timeline.
9. `devops-pipeline` (devops, sre, cloud-architect, network-engineer) — dark slate `#12171d` + signal orange `#f2803c`, barlow, wide 3-col grid, domino motion; grid "Infrastructure projects" → skills → timeline.
10. `product-roadmap` (product-manager, business-analyst) — bright paper `#fbf8f3` + terracotta `#bd6144`, plus-jakarta-sans, stacked nav + centered headings; featured "Product case studies" → timeline "Product journey" → skills → testimonials cards.
11. `ux-research-lab` (ux-researcher, qa-engineer, automation-tester) — calm ivory `#f6f2e9` + clay `#b06b45`, work-sans, relaxed reading rhythm; split hero → editorial "Research reports" → cards "Research services" → skills.

**engineering.ts**
12. `civil-works` (civil-engineer, structural-engineer, surveyor) — concrete light `#eeeeea` + safety amber `#d68f1f`, archivo grand/wide, sharp, stacked nav; cover hero → featured "Built works" → timeline "Projects delivered" → skills.
13. `mechanical-forge` (mechanical-engineer, biomedical-engineer, chemical-engineer) — steel grey `#22262a` + copper `#c8804a`, hanken-grotesk, 2-col 4/3 drafting grid; split hero → grid "Design projects" → skills → rows.
14. `electronics-bench` (electronics-engineer, electrical-engineer) — dark board `#101512` + solder-green `#43a05e`, space-mono, compact; classic hero → grid "Builds & circuits" → gallery grid "Bench photos" → skills.

## Slug verification (verbatim against src/lib/professions/taxonomy.ts)

All 31 used slugs extracted and matched against `p("…")` entries + `LEGACY_PROFESSIONS`: frontend-dev, backend-dev, software-engineer, mobile-dev, game-dev, ai-engineer, ml-engineer, data-scientist, data-analyst, data-engineer, cybersecurity, devops, sre, cloud-architect, network-engineer, product-manager, business-analyst, ux-researcher, qa-engineer, automation-tester, civil-engineer, structural-engineer, surveyor, mechanical-engineer, biomedical-engineer, chemical-engineer, electronics-engineer, electrical-engineer — all exist. **`automotive` does NOT exist in the taxonomy** (checked: no such slug), so mechanical-forge ships without it per the "check taxonomy" instruction.

## Uniqueness / self-check (checker output, exit 0 before deletion)

Structural signature = ordered `type:layout:variant` join `>` + `radius|density|columns|buttonStyle|navLayout|headingAlign|contentWidth|imageRatio|headingFont` (missing fields default-resolved so legacy presets compare fairly). All 14 signatures printed and asserted: pairwise unique, zero collisions with all ~70 registered `templatePresets()` entries (dev-console's `hero:classic>stats>projects:grid>skills>experience:timeline>contact` avoided — my similar orders differ by stats position, layouts, fields), zero id collisions, and zero collisions with the 9 sibling v4 families (newsroom, writing, creative-arts, performing-arts, education, science, business, health, trades — loaded in the checker). Also validated: every font id in `SITE_FONTS`, every motion preset in `MOTION_PRESET_IDS` (stagger, line-mask, pop, cinematic, stagger-blur, subtle-rise, fade-up-soft, type-steps, domino, gentle-appear, editorial-stagger, steady-fade-up, stagger-scale, cascade), 6-digit hex on all six color tokens, non-bluish accent rule, 4–7 sections/page, projects limit 3–12, gallery limit 6–12, collections limit 3, placeholder whitelist `{name} {tagline} {headline} {bio} {availability}` (no `{location}` used — safest reading of the content rules), heading-font share max 2 (manrope ×2 only), kebab-case ids, no fabricated employers/metrics/awards/clients (slot-purpose titles only; services/experience/testimonials items left as schema defaults `[]`).

## Verification (REAL exit codes)

| Command | Result |
|---|---|
| `bun scripts/tmp/check-sigs-t2.ts` | exit **0** — "ALL CHECKS PASSED (14 templates, 14 unique signatures, no collisions)" |
| `bunx tsc --noEmit` | exit **0** (whole repo, with all sibling template files present) |
| `bun run lint` | exit **0**, zero findings |
| `tail dev.log` | only routine maintenance/studio sweeps + a next.config restart note from a concurrent agent; nothing referencing the new template files |

## Notes / handoff for the integrator

- Register the 14 ids in `TEMPLATE_IDS` (suggest a `// v4 profession templates` block) and spread `...technologyTemplates(), ...engineeringTemplates()` into `templatePresets()`; the `PresetDraft` cast inside my factories becomes a plain return once the ids join the union.
- Suggested categories: the 11 technology presets → "developer-technology"-style grouping; the 3 engineering presets → a built-world/hardware grouping (matching creative-arts/health sibling conventions).
- All content slots are placeholder-only; nothing is fabricated — safe to apply to real accounts as-is.
