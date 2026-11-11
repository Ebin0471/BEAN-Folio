# Task 4-e — Education/Academia + Science/Environment + Skilled Trades template family (14 entries)

## Summary
Authored 14 REAL, mutually distinct portfolio templates for BEAN Folio across three new modules. Each entry is a complete design: full theme token set (non-bluish 6-digit hex accents), motion preset from the live registry, and a 4–7 section page plan that renders through the standard SiteRenderer. Content uses placeholder tokens only ({name} {tagline} {headline} {bio} {availability}) — no invented institutions, students, clients, jobs, or credentials.

## Files created
| File | Contents |
|---|---|
| `src/lib/site-templates/professions/education.ts` | `educationTemplates()` — 4 templates: teacher-classroom, professor-lecture, scholar-thesis, student-launch |
| `src/lib/site-templates/professions/science.ts` | `scienceTemplates()` — 3 templates: scientist-lab, eco-field, agro-harvest |
| `src/lib/site-templates/professions/trades.ts` | `tradesTemplates()` — 7 templates: chef-table, baker-oven, tailor-atelier, barber-chair, tattoo-ink, florist-bloom, trades-guild |
| `scripts/tmp/check-sigs-t5.ts` | SCRATCH self-check (created, run, **deleted**) — verified ids, structural signatures, slugs, fonts, motion ids, hex/bluish rules, normalizeConfig, section limits |

**Not touched** (per constraints): `site-config.ts`, tests, any other file. Modules follow the exact factory contract: local `tpl()` helper over `makeSection`, entries typed `Omit<TemplatePreset,"id"> & { id: string }`, single documented cast at the factory return.

## The 14 templates
| # | id | One-liner |
|---|---|---|
| 1 | `teacher-classroom` | Chalkboard-green + chalk-cream/cork classroom home (neuton/karla, centered hero) |
| 2 | `professor-lecture` | Oxblood-on-parchment academic site: publications, appointments (libre-baskerville/newsreader, grand scale) |
| 3 | `scholar-thesis` | Quiet paper + ink + burgundy thesis page: preprints, research stats (crimson-pro, intimate, sharp) |
| 4 | `student-launch` | Sunflower-bright starter site: projects, skills (jost, pill buttons, centered) |
| 5 | `scientist-lab` | Lab-white + seafoam field-science site: studies, field gallery, stats (source-serif-4/geist-sans) |
| 6 | `eco-field` | Moss + soil conservation portfolio: featured work, consulting, field seasons (schibsted-grotesk, cover hero, ken-burns) |
| 7 | `agro-harvest` | Wheat + terracotta agronomy journal: seasons/trials, harvest masonry (archivo) |
| 8 | `chef-table` | Charcoal + saffron menu-card: signature dishes, private dining, plating masonry (playfair-display/karla) |
| 9 | `baker-oven` | Flour + cinnamon bakery: bakes grid, orders, regulars' notes (young-serif/nunito-sans, 1/1) |
| 10 | `tailor-atelier` | Navy cloth + brass atelier: garment grid, bespoke services, bench history (cormorant pair, outline buttons) |
| 11 | `barber-chair` | Shop-dark + copper: service cards, cuts grid, client notes (oswald/barlow, sharp, compact) |
| 12 | `tattoo-ink` | Studio-black + blood red: flash masonry, large work (unbounded/space-grotesk, ink-reveal) |
| 13 | `florist-bloom` | Botanical cream + leaf green: arrangements masonry, occasions, collections (forum/mulish) |
| 14 | `trades-guild` | Workwear navy + hi-vis yellow callout board: services, recent jobs, sign-offs (archivo/barlow, sharp, radius none) |

Heading fonts: 13 distinct + `archivo` ×2 (agro-harvest, trades-guild) — max-share rule (≤2) satisfied.

## Slug verification (verbatim against `src/lib/professions/taxonomy.ts`)
All 27 profession references verified to exist exactly as written:
- education-research family: `teacher, tutor, instructional-designer, curriculum-developer, education-consultant, professor, academic, phd-scholar, lab-scientist, student`
- science-environment-agriculture family: `scientist, marine-biologist, geologist, ecologist, field-researcher, environmental-scientist, conservationist, sustainability-consultant, agronomist, agricultural-researcher, farmer`
- skilled-trades-services family: `chef, baker, tailor, barber, beautician, tattoo-artist, florist, gardener, electrician, plumber, mechanic, carpenter`
- Cross-family (verified, intentional): `researcher` (writing-publishing) for scholar-thesis; `fashion-designer` (creative-arts) for tailor-atelier; `fresher`, `intern` (career-development) for student-launch. **No missing slugs — no substitutes needed.**

## Uniqueness (test-enforced rule)
Structural signature = ordered `type:layout:variant` join `>` + `radius|density|columns|buttonStyle|navLayout|headingAlign|contentWidth|imageRatio|headingFont`. Scratch check confirmed: all 14 mutually unique AND unique vs **129 other templates** (70 in `templatePresets()` incl. classroom-folio/byline-journal + 59 from sibling family modules created by parallel tasks). No id collisions either. All 14 section sequences also differ from classroom-folio (`hero:classic>services:cards>experience:rows>skills:>testimonials:cards>contact`) and byline-journal (`hero:classic>projects:list>projects:grid>experience:timeline>about:>contact`).

## Verification (REAL exit codes)
| Check | Result |
|---|---|
| `bun scripts/tmp/check-sigs-t5.ts` (14×129 sigs, slugs, fonts, motion, hex/bluish, limits) | **ALL CHECKS PASSED ✅** |
| `bunx tsc --noEmit` (before and after scratch deletion) | exit **0** |
| `bun run lint` | exit **0** |
| `normalizeConfig` for all 14 (theme/motion/pages under registered placeholder id) | all pass |

## Notes / handoff for aggregator task
- `TemplatePreset.id` is the closed `TemplateId` union in `site-config.ts`. The 14 new ids (`teacher-classroom … trades-guild`) must be appended to `TEMPLATE_IDS` (and the three factories wired into `templatePresets()`) by the aggregator/integration task — that file is out of scope for 4-e. Until registration, `normalizeConfig` rejects these ids **on the template enum alone**; theme/motion/pages validate clean (verified under placeholder id).
- Scratch `scripts/tmp/check-sigs-t5.ts` was deleted after use; `scripts/tmp` removed when empty.
- dev.log showed no new warnings from these modules (pure leaf data modules, no side effects).
