# Task 5 — Profession-Aware CODE GIFTZ Generation (work record)

## What was built
Profession playbook layer grounding the Code Giftz planner in the user's declared professions.

- **`src/lib/professions/playbooks.ts` (NEW)** — `ProfessionPlaybook` interface; internal seed table with hand-authored playbooks for ALL 13 taxonomy families (exact slugs verified from taxonomy.ts: creative-arts, technology, journalism-media, writing-publishing, film-audio-entertainment, business-practice, architecture-engineering, education-research, health-wellness, science-environment-agriculture, public-service-community, skilled-trades-services, career-development). Exports:
  - `playbookForFamily(familySlug)` → playbook | null
  - `playbooksForProfessions(slugs)` → dedupe by family, preserve user order, cap 3, skip unknown slugs
  - `mergedPlaybookGuidance(slugs)` → labeled 6-line grounding block | null
  - `templateIds` computed at CALL TIME from `templatePresets()` ∩ family professions (memoized ids; never hardcoded).
  - Anti-fabrication stored as concrete `fabricationProhibitions: string[]` per family; `antiFabrication` derived ("Never invent A, B or C."), so merges union into ONE statement.
- **`src/lib/ai-design/context.ts` (minimal diff)** — after the `- Professions:` line, `fetchPortfolioBlock` appends `mergedPlaybookGuidance(professionSlugs)` when non-null (spread into the existing array; null → unchanged behavior). Flows to plan route, audit route, execute stepContext, Website Studio turn.
- **`src/lib/ai-design/prompts.ts` (minimal diff)** — ONE paragraph added in `planSystemPrompt` between `schemaDoc()` and "Planning rules:" ("Profession grounding: …"). TARGET RULE and all existing constraints untouched.
- **`tests/profession-playbooks.test.ts` (NEW)** — 17 tests: journalism anchor (hero-first, gallery/projects second, antiFabrication mentions publications/bylines), dedupe/cap/order, merge properties (union content types, unique section names, exactly one "Never fabricate"), 13-family completeness + schema-valid section types, template-id existence in templatePresets().
- **`docs/PROFESSION_AWARE_GENERATION.md` (NEW)** — how it works, merging rules, enforced-vs-guidance table, anti-fabrication posture, import-graph note.

## Import-graph safety (verified by grep)
site-config.ts imports only zod, site-motion, site-fonts, site-templates/professions/* — none import ai-design/* or professions/*. So `ai-design/context → professions/playbooks → site-config` is acyclic. (site-config ↔ site-templates/professions is the pre-existing cycle, resolved via factory functions.)

## Verification
- `bunx tsc --noEmit` → clean (exit 0)
- `bun run lint` → 0 errors (1 pre-existing warning in scripts/loadtest/k6/browse.js, untouched)
- `bun test tests/profession-playbooks.test.ts` → 17 pass / 0 fail (332 expect calls)
- Regression: plan-schema-resilience + phase5-integration + profession-taxonomy + design-agent + giftz-engine + giftz-plan-consistency + giftz-target-resolution + style-templates → **166 pass / 0 fail**

## Untouched (per ownership)
site-config.ts, plan.ts, execute.ts, tools.ts, turn.ts, routes, templates, taxonomy.ts.
