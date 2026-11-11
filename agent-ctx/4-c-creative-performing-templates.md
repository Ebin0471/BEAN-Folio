# Task 4-c — Profession Template Families T3: Creative Arts + Performing Arts (17 entries)

## Summary
Authored 17 REAL, mutually-unique complete-website templates as two new factory modules under `src/lib/site-templates/professions/` (folder created by this task — it did not exist). Each entry is a full design (palette, typography, motion, page structure) built from the shared `makeSection` factory; all 17 verified render-ready through `normalizeConfig()`.

**No other files touched** — `site-config.ts`, tests, and views untouched.

## Files created / deleted
| File | Status |
|---|---|
| `src/lib/site-templates/professions/creative-arts.ts` | created — exports `creativeArtsTemplates(): TemplatePreset[]` (9 entries) |
| `src/lib/site-templates/professions/performing-arts.ts` | created — exports `performingArtsTemplates(): TemplatePreset[]` (8 entries) |
| `scripts/tmp/check-sigs-t3.ts` | scratch self-check (signature uniqueness, hex/accent/font/motion/taxonomy/limits/tokens) — ran clean, **deleted** |

## The 17 templates (ids + one-liners)
**creative-arts.ts**
1. `fine-artist-canvas` — gallery-white + charcoal + vermilion; fraunces; cover hero; masonry "Selected works" → statement → Series collections.
2. `sculptor-atelier` — stone grey + moss; cinzel; split hero; 1/1 grid, commissions list, exhibitions rows.
3. `digital-artist-lab` — violet-brown (red-high, not bluish) + neon peach; syne; cover hero; featured frames → process grid → toolkit.
4. `fashion-lookbook` — ivory + black + gold; bodoni-moda/jost; cover hero; strip lookbook → Seasons → editorial features; radius none.
5. `interior-designer-muse` — warm neutrals + walnut; marcellus; split hero; featured rooms → detail masonry → scope-of-work rows.
6. `industrial-design-lab` — lab light + graphite + orange; space-grotesk; classic hero; product grid → capabilities → timeline.
7. `stylist-editorial` — blush + espresso; josefin-sans; centered hero; masonry editorial work → service cards → shot lists; pill/full.
8. `beauty-bar` — warm rose + deep plum-brown; playfair-display; split hero; services cards → work grid → testimonials.
9. `pattern-maker-textile` — indigo-dyed navy + terracotta; caveat/kalam; classic hero; pieces grid → maker's note → collections.

**performing-arts.ts**
10. `musician-stage` — stage-black + brass; bebas-neue; cover hero; live-&-studio strip → releases list → stats.
11. `actor-callboard` — deep maroon + cream; playfair-display; centered hero; featured roles → theatre & screen timeline → stills strip.
12. `voice-booth` — booth dark + electric lime; archivo-black; split hero; voice-work grid → service rows → studio kit; sharp/none.
13. `dancer-stage` — motion-white + crimson; italiana; cover hero; performance masonry → featured performances → stage history rows.
14. `filmmaker-cut` — cinema dark + warm amber; tenor-sans; cover hero; films featured → frames strip → festivals timeline.
15. `video-editor-suite` — edit-bay charcoal + signal green; geist-mono; split hero; edits & grades grid → suite skills → service rows; 16/9, none.
16. `sound-booth` — foam dark + warm orange; space-grotesk; classic hero; sessions list → signal chain → bodies of work.
17. `casting-desk` — agency light + cognac; libre-baskerville; classic hero; casting services cards → casting grid → credits rows.

## Uniqueness verification (test-grade, scripted then deleted)
Structural signature = ordered `type:layout:variant` join `>` + `radius|density|columns|buttonStyle|navLayout|headingAlign|contentWidth|imageRatio|headingFont`:
- **17/17 mutually unique**, and **0 collisions against all 70 existing `templatePresets()` entries** (classic v1 + v2 professions + v3 style/gallery templates).
- Heading-font sharing within the set: max 2 (`space-grotesk`: industrial-design-lab + sound-booth; `playfair-display`: beauty-bar + actor-callboard; every other font 1×).

## Slug verification (verbatim against `src/lib/professions/taxonomy.ts`, 221 slugs)
- creative-arts family: `painter` `sculptor` `digital-artist` `vfx-artist` `3d-artist` `fashion-designer` `interior-designer` `industrial-designer` `stylist` `makeup-artist` `hair-artist` `craftsperson`
- film-audio-entertainment: `musician` `singer` `composer` `actor` `theatre-performer` `voice-artist` `dj` `dancer` `choreographer` `film-director` `cinematographer` `videographer` `video-editor` `colorist` `animator` `sound-designer` `audio-engineer` `music-producer` `casting-professional`
- skilled-trades-services: `tailor` (line 585) `barber` (590) `beautician` (591) `artisan` (594) — all confirmed present; every `professions:` array in the 17 presets uses only verified slugs.

## Other validation
- All colors 6-digit hex; every accent passes the not-bluish rule (scripted `b>150 && b>r+40 && b>g+40` check, incl. violet-brown `#2a2026` bg and navy `#202b3d` bg — accent is terracotta).
- All font ids resolve in the 129-family `SITE_FONTS`; all 17 motion presets ∈ `MOTION_PRESET_IDS` (note: `media-ken-burns`, not `ken-burns` — task list corrected during authoring; durations 450–750 all within 150–1200).
- Structure: 4–5 sections per single-page site; gallery limits 8–12 (6–12 rule), projects limits 4–8 (3–12 rule), collections limit 3; placeholder tokens restricted to `{name} {tagline} {headline} {bio} {availability} {location}`; no invented clients/venues/awards/prices anywhere (services/experience/testimonials use empty `items`/`entries` arrays filled by the studio ContentEditor).
- `bun -e` normalizeConfig sweep: **17/17 pass** (each preset parsed into a v2 config unchanged).

## Verification (REAL exit codes)
| Command | Result |
|---|---|
| `bun scripts/tmp/check-sigs-t3.ts` | PASS — 0 failures (17/17 sigs unique, 0 vs 70 existing) |
| `bunx tsc --noEmit` | exit **0** |
| `bun run lint` | exit **0** |
| `dev.log` | only pre-existing background-job noise; nothing referencing the new modules |

## Notes / handoff
- **Typing**: `TemplatePreset.id` is the closed `TemplateId` union in site-config.ts. Since this task may not touch that file, both modules cast through a local `PresetAuthor = Omit<TemplatePreset, "id"> & { id: string }` → `preset()` helper. When a parent task registers the 17 ids into `TEMPLATE_IDS` (or widens the union), the cast stays valid and no changes are needed in these files.
- The "category" labels in the brief (`creative-arts-professions`, `performing-arts`) are documented in the module headers; `TemplatePreset` has no category field, so nothing extra was added to entries.
- Suggested registry wiring (parent task): concatenate `creativeArtsTemplates()` + `performingArtsTemplates()` into the studio template source, registering the ids in `TEMPLATE_IDS`.
