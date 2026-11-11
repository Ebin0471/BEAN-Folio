# Task 4-d — Business/Finance + Health/Wellness profession templates

## Deliverables
- `src/lib/site-templates/professions/business.ts` — factory `businessTemplates(): TemplatePreset[]`, 7 templates
- `src/lib/site-templates/professions/health.ts` — factory `healthTemplates(): TemplatePreset[]`, 5 templates
- `scripts/tmp/check-sigs-t4.ts` — scratch self-check (signature/slug/font/motion/accent validation) — **created, run, DELETED** as instructed

## The 12 templates
| id | file | professions (all verified verbatim in taxonomy) | one-liner |
|---|---|---|---|
| consultant-suite | business | consultant, business-strategist, coach | Ivory + bronze advisory suite; services → featured engagements → timeline → references |
| founder-ventures | business | founder, entrepreneur | Bold paper + brick red, centered manifesto, story-first, ventures + milestones |
| finance-ledger | business | financial-professional, accountant | Ledger light + deep green, IBM Plex rows/timeline/list, sharp ruled structure |
| realestate-listing | business | real-estate-professional | Estate cream + forest, cover hero, featured listings, property gallery, 4/3 |
| legal-chambers | business | legal-professional | Parchment + oxblood chambers, Cormorant serif, rows/timeline/docket list, radius none |
| event-atelier | business | event-planner | Celebration ivory + gold-rose, cover → masonry event wall → services → collections |
| marketer-funnel | business | marketer, digital-marketer, sales-professional, recruiter | Daylight + persimmon, split hero, campaigns → highlights → capability rows |
| doctor-clinic | health | doctor, dentist, pharmacist | Clinical white + calm teal (#0f766e, g≥b), practice + consultation areas + credentials; NO testimonials/gallery (privacy), 1/1 |
| nurse-care | health | nurse, occupational-therapist | Soft sage + sand, centered welcome, career rows, support cards; intimate/relaxed |
| physio-motion | health | physiotherapist, fitness-trainer | Energetic light + vivid orange, cover hero, program cards, transformations (sample sections; add client work with consent), skills |
| dietitian-plate | health | dietitian, wellness-practitioner | Fresh linen + olive, split hero, program rows, featured nutrition programs, philosophy |
| therapy-practice | health | counselor, psychologist | Warm light + russet, classic hero, ways of working, "inside the practice" gallery (room/materials only) |

## Deviations from the task brief (reasons)
1. **`founder-story` id was already taken** — `TEMPLATE_IDS` in `src/lib/site-config.ts` (line ~1101) has a v2 template `founder-story` (fraunces/split/timeline). Global id uniqueness is schema-enforced, so mine is **`founder-ventures`** (centered hero, about-first, editorial ventures, stats — a genuinely different structure and look).
2. **No veterinarian slug exists** in `src/lib/professions/taxonomy.ts` (health-wellness family = doctor, nurse, dentist, pharmacist, physiotherapist, occupational-therapist, dietitian, psychologist, counselor, fitness-trainer, wellness-practitioner). Per the brief's fallback, template 12 became **therapy-practice** for `counselor` + `psychologist`; to keep claims clean, nurse-care covers `nurse` + `occupational-therapist` (counselor/psychologist moved out of nurse-care).
3. **"caro/lora"** in the brief for nurse-care: `caro` is not in the font library; used **lora** (valid id) for headings.
4. `TemplatePreset.id` is the closed `TemplateId` union (registration in `TEMPLATE_IDS` is the aggregator's job). Each file builds `Omit<TemplatePreset,"id"> & {id: string}` drafts and narrows once in the exported factory (`drafts as TemplatePreset[]`) — legal downcast, tsc-clean, single documented narrowing point.

## Verification performed
- **Signature self-check** (scratch script replicated `tests/style-templates.test.ts` formula exactly: ordered `type:layout:variant` chain + radius|density|columns|buttonStyle|navLayout|headingAlign|contentWidth|imageRatio|headingFont): all 12 mutually unique AND none collides with any of the ~74 existing presets in `templatePresets()`; none even shares a section chain with an existing template. Heading fonts: 12 distinct ids (no sharing needed).
- **Slug verification**: every professions slug validated programmatically against `flattenTaxonomy()` — all exact.
- **Motion presets**: executive-fade, editorial-stagger, steady-fade-up, gallery-reveal, subtle-rise, stagger, crisp-pop, calm-float, gentle-appear, pop, fade-up-soft, subtle-fade — all in `MOTION_PRESET_IDS`.
- **Fonts**: all ids in `SITE_FONTS`.
- **Accents**: all 6-digit hex, none blue-dominant (b>150 && b>r+40 && b>g+40 fails everywhere); doctor teal keeps green ≥ blue.
- **`bunx tsc --noEmit`** → 0 errors project-wide (checked before deleting scratch; nothing in my files).
- **`bun run lint`** → exit 0.
- Content rules honoured: placeholder tokens only; no invented clients/fees/results/credentials; health family = professional-practice presentation only (no patient data/records imagery slots, no testimonials where privacy demands).
- Did NOT touch site-config.ts, tests, or any other file (other agents' scratch files under scripts/tmp left untouched).

## Note for the aggregator task
Register these 12 ids in `TEMPLATE_IDS` + category metadata (`business-finance-professions` × 7, `health-wellness` × 5) in site-config.ts, then the standard style-templates test extends naturally. Factories to import: `businessTemplates()` / `healthTemplates()` from `src/lib/site-templates/professions/{business,health}.ts`.
