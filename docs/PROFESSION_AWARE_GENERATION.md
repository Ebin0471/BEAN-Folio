# Profession-Aware CODE GIFTZ Generation

How BEAN Folio grounds the Code Giftz website-engineering agent in the user's
declared professions — and the anti-fabrication posture that comes with it.

**Status:** shipped · **Owner:** AI design pipeline (Code Giftz)
**Related:** `docs/PROFESSION_TAXONOMY.md` (13 families / 221 professions),
Code Giftz pipeline docs (plan → validate → execute → isolated proposal).

---

## 1. What it is

Code Giftz (the Website Studio agent) plans and executes website changes via
the pipeline: `planDesignChange` (LLM plan, grounded) → `validatePlan` →
`runDesignJob` (deterministic tools) → isolated proposal. Profession-aware
generation adds a **playbook layer** to the grounding half of that pipeline:

- `src/lib/professions/playbooks.ts` — per-family design guidance
  (`ProfessionPlaybook`) for all 13 taxonomy families, plus the merge logic.
- `src/lib/ai-design/context.ts` — `fetchPortfolioBlock()` appends the merged
  guidance block right after the `- Professions:` line, so every grounding
  consumer (plan route, audit route, execute step context, Website Studio
  turn) sees it.
- `src/lib/ai-design/prompts.ts` — `planSystemPrompt()` carries one short
  "Profession grounding" paragraph telling the planner how to treat the block.

A playbook answers three questions about a family:

| Field | Meaning |
| --- | --- |
| `sectionOrderPreference` | Ordered section types that usually serve the craft (hero-first everywhere; media families put a gallery/reel early; service families put services + contact early). A subset of the 11 valid `SiteSectionType`s, enforced by the type system. |
| `projectTypes` | The content types this family actually portfolios ("News report", "Case study", "Public education content"…). |
| `mediaGuidance` / `evidenceGuidance` | Layout emphasis and what counts as legitimate evidence. |
| `antiFabrication` | One derived sentence: "Never invent A, B or C." built from concrete per-family prohibitions. |
| `templateIds` | Recommended curated templates — **computed at call time** from `templatePresets()` by intersecting each preset's `professions` with the family's professions. Never hardcoded, so ids cannot drift from site-config. |

## 2. The grounding block

`mergedPlaybookGuidance(professionSlugs)` renders the block that lands in the
portfolio context. Example for a user whose only declared profession is
`reporter`:

```
- Profession guidance (from their declared professions — suggestions, not requirements; the user's real data and materials are always authoritative):
  - Likely content types: News report, Field assignment, Investigation, Showreel segment, Podcast episode, Photo story
  - Suggested section order: hero, gallery, projects, experience, skills, contact
  - Media emphasis: Video, photo and audio clips emphasized — reporting reels, clip galleries and bylined stories above decorative design.
  - Evidence conventions: Project descriptions may carry byline/publication/date/source-link conventions for published work — only where the user's own materials record them.
  - Never fabricate: publications, bylines, broadcast appearances, audience metrics, interviews or sources.
```

Properties:

- **Labeled and bounded** — always exactly 6 lines (≤ the ~60-line budget);
  the header states "suggestions, not requirements".
- **Honest** — "Suggested", "Likely"; nothing is phrased as a mandate.
- **Null-safe** — no resolvable professions → `mergedPlaybookGuidance`
  returns `null` and **nothing** is appended (byte-identical to the previous
  grounding behavior).

## 3. Multi-profession merging

`playbooksForProfessions(slugs)` maps each declared profession to its family
via `flattenTaxonomy()`, then:

1. **Dedupes by family** — five journalism slugs still produce ONE
   journalism-media playbook; first occurrence wins.
2. **Preserves user order** — families appear in the order the user listed
   their professions.
3. **Caps at 3** — grounding stays bounded for hybrid profiles.
4. **Skips unknown slugs** — never throws.

`mergedPlaybookGuidance` then unions across the ≤ 3 playbooks:

- **Content types** — deduped union in playbook order (capped at 12).
- **Section order** — first-occurrence-wins across families, so a
  journalist+developer mix reads `hero, gallery, projects, experience, skills,
  stats, contact` with no duplicated section names.
- **Media emphasis / evidence conventions** — per-family sentences combined.
- **Anti-fabrication** — ONE line; the union of the families' concrete
  prohibition categories (capped at 12), e.g. journalism's `publications,
  bylines, broadcast appearances, audience metrics` plus technology's
  `employment history, performance metrics, …` in a single statement.

## 4. Anti-fabrication posture (mission rules)

The playbooks **operationalize** the honesty rules that already exist in the
Code Giftz persona (`HONESTY_BLOCK` in prompts.ts) and the compose-step rules:

- A journalist must **not** get a software-developer portfolio; a newsreader
  must **not** get a photographer's gallery as the main feature — the
  section-order and content-type suggestions keep structure aligned with the
  declared craft.
- **Never fabricate**: employment history, qualifications, clients, awards,
  publications, certifications, skills, metrics, testimonials or projects.
  Each family lists the categories that matter most to it (journalism:
  publications/bylines/broadcast appearances/audience metrics; health: patient
  data or identifiable clinical cases, with an explicit confidentiality rule in
  the evidence guidance; technology: metrics/employers/clients).
- Generation runs on the user's **real profile data + uploaded materials +
  instructions only**; where data is missing, empty containers and
  placeholders beat invented content.
- **User approval before save/publish remains enforced** by the isolated
  proposal workflow — playbooks do not touch it.

## 5. What is — and is not — enforced

| Mechanism | Type |
| --- | --- |
| Playbook section types ⊆ 11 valid `SiteSectionType`s | Compile-time (`SiteSectionType[]`) + test-enforced |
| Every family slug has a playbook; template ids exist in `templatePresets()` | Test-enforced (`tests/profession-playbooks.test.ts`) |
| Anti-fabrication items merge into one statement, exactly once | Test-enforced |
| Playbook guidance reaching the planner | Prompt-level **guidance** — the planner may deviate when the user's request points elsewhere |
| Never fabricating facts | Prompt-level rules (persona + honesty block + compose rules) — LLM-honesty, not schema-hard |
| No fabricated facts entering rendered content | Existing deterministic pipeline: plan validation, site-schema validation, isolated proposal, manual user approval before publish |

Deliberately NOT enforced (and why): the section-order preference is advice,
not a validator rule — real users override conventions, and the plan schema
already rejects invalid structure mechanically. Fabrication prevention stays a
prompt + review concern because content correctness is judgment, not schema.

## 6. Import-graph safety

`playbooks.ts` imports `templatePresets` from `@/lib/site-config` and is
imported by `ai-design/context.ts`. Verified with grep: `site-config.ts` and
its dependencies (`site-motion`, `site-fonts`, `site-templates/professions/*`)
never import `ai-design/*` or `professions/*`, so the graph
`ai-design/context → professions/playbooks → site-config` is acyclic. (The
`site-config ↔ site-templates/professions` pair is the one pre-existing cycle,
resolved via their factory functions.)

## 7. API surface

```ts
export interface ProfessionPlaybook {
  familySlug: string;
  sectionOrderPreference: SiteSectionType[];
  projectTypes: string[];
  mediaGuidance: string;
  evidenceGuidance: string;
  antiFabrication: string;   // "Never invent A, B or C."
  templateIds: string[];     // computed from templatePresets() at call time
}
export function playbookForFamily(familySlug: string): ProfessionPlaybook | null;
export function playbooksForProfessions(slugs: string[]): ProfessionPlaybook[]; // dedupe, max 3, user order
export function mergedPlaybookGuidance(slugs: string[]): string | null;         // the grounding block
```

## 8. Tests

`bun test tests/profession-playbooks.test.ts` — journalism-media anchor,
dedupe/cap/order, merge properties, 13-family completeness, schema-valid
section types, and template-id existence. No DB required.
