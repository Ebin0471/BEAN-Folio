# Task 4-a — Newsroom/Broadcast + Writing/Publishing template families

## Summary
Authored 16 real, distinct v4 profession-family portfolio templates for BEAN Folio in two new modules, exported as factories (no top-level arrays — `makeSection()` mints fresh section ids at call time and circular-import init order stays clean). Content follows the placeholder-token contract ({name} {tagline} {headline} {bio} {availability}); titles describe slot purpose only — no invented outlets, clients, awards or metrics.

## Files created
| File | Contents |
|---|---|
| `src/lib/site-templates/professions/newsroom.ts` | `newsroomTemplates(): TemplatePreset[]` — 11 templates, category "newsroom-broadcast" |
| `src/lib/site-templates/professions/writing.ts` | `writingTemplates(): TemplatePreset[]` — 5 templates, category "writing-publishing" |

Both modules define a local `tpl()` helper (mirrors the future exported `tplSection` in site-config: spreads `makeSection(type)` + overrides) and a `homePage()` helper. Entries are typed via a local `TemplateDraft = Omit<TemplatePreset,"id"> & { id: string }` and narrowed once with `as TemplatePreset[]` at the factory boundary, because the v4 ids are not yet in the legacy `TEMPLATE_IDS` union (registry change lands separately). **No other files touched** (site-config.ts, tests untouched).

## The 16 templates (ids + one-liners)
Newsroom (`newsroom.ts`):
1. `news-anchor-desk` — charcoal + gold, cover hero, showreel-first (gallery strip → stats → timeline → skills → booking contact), newsreader/16:9.
2. `broadcast-studio` — deep red-brown, split hero, featured segments → about → live-moments strip → rows experience, prata.
3. `field-report-kit` — khaki/sand utilitarian, classic hero, list reporting → assignments timeline → kit skills, barlow/4:3/sharp.
4. `investigative-dossier` — paper/ink editorial, spectral+crimson-pro, investigations editorial → track record → recognition stack, narrow.
5. `press-photographer` — near-black + silver, cover hero, masonry photo stories → featured photo essays, tenor-sans/3:2/wide.
6. `video-journal-cut` — slate + amber, split hero, featured video reports → raw-cuts strip → field production rows, archivo/16:9.
7. `radio-airwave` — cream + burnt orange, centered hero, pill buttons, centered headings, segments list → stats → history, jost/1:1.
8. `podcast-atlas` — espresso + coral, centered hero, featured episodes → series collections → listener notes stack, sora/1:1.
9. `newsroom-desk` — graphite + brass, classic hero, newsroom-roles timeline FIRST → produced programmes editorial → skills, libre-baskerville.
10. `explainer-brief` — paper + forest green, narrow column, explainers editorial → brief about → beats skills, public-sans + source-serif-4 body.
11. `byline-media` — bold poster, anton headings, cover hero, stories grid → field gallery grid → formats services rows, stacked nav.

Writing (`writing.ts`):
12. `author-folio` — library brown + parchment, centered hero, books featured → about → reader & critic notes cards, playfair-display + lora.
13. `poet-pages` — minimal white/ink, cormorant + eb-garamond, intimate scale, collections list → masonry readings gallery → note.
14. `copywriter-desk` — office light + oxblood, split hero, campaign editorial → what-I-write cards → desk stats, dm-serif-display + manrope.
15. `tech-doc-hub` — terminal-adjacent light + green, geist-mono headings, radius none, doc sets list → toolchain → contract rows.
16. `translator-bridge` — slate/sand two-tone, marcellus, services rows (language pairs) FIRST → translations grid → assignments rows.

## Uniqueness (test-enforced structural signature)
Signature = ordered `type:layout:variant` joined `>` + `radius|density|columns|buttonStyle|navLayout|headingAlign|contentWidth|imageRatio|headingFont`. Verified via a scratch checker (`scripts/tmp/check-sigs-t1.ts`, deleted after use): **16 unique signatures**, and none collides with any signature of the existing `templatePresets()` (incl. gazette-noir / folio-review / broadsheet / editorial-press). Heading fonts: all 16 distinct (max-sharing rule satisfied). A scratch bun script also confirmed zod `themeSchema` + `sitePageSchema` parse for all 16.

## Profession slugs — verified verbatim in `src/lib/professions/taxonomy.ts`
news-anchor, news-presenter, television-presenter, broadcast-journalist, reporter, field-reporter, correspondent, investigative-journalist, political-journalist, photojournalist, video-journalist, documentary-journalist, radio-presenter, radio-host, podcast-host, digital-news-creator, news-editor, assignment-editor, news-producer, executive-producer, fact-checker, newsroom-researcher, news-analyst, science-journalist, technology-journalist, freelance-journalist, social-media-journalist, media-commentator, scriptwriter, author, novelist, poet, copywriter, content-writer, ghostwriter, technical-writer (technology family), translator, interpreter, editor, proofreader — **all exist exactly**.

## Verification (real exit codes)
| Check | Result |
|---|---|
| `bunx tsc --noEmit` | exit 0 |
| `bun run lint` | exit 0 |
| Scratch signature checker | 16 unique lines, 0 failures (professions/fonts/motion/hex/section-count/legacy-collision all validated) |
| Zod `themeSchema` + `sitePageSchema` | all 16 parse |

## Notes / handoff
- `tplSection` is still un-exported in site-config.ts; both modules use the agreed local `tpl()` stand-in, so exporting `tplSection` later is a drop-in swap.
- The `as TemplatePreset[]` boundary cast is intentional and documented: remove it once `TemplatePreset["id"]` widens for v4 family ids.
- Motion presets used (all verified against `MOTION_PRESET_IDS`): editorial-stagger, serif-rise, fade-down, ink-reveal, media-zoom-slow, media-mask-down, pop, stagger-scale, headline-mask, word-rise, mask-up, paper-unfold, word-fade, crisp-pop, type-steps, gentle-appear.
- All accents pass the non-bluish rule (b>150 && b>r+40 && b>g+40); all colors 6-digit hex.
