# Task A-4-templates — Style-Template Library (12 entries)

## Summary
Added a 12-entry style-template library to the BEAN Folio website builder. Each entry is a visual genre (not profession-bound: `professions: []`) with a REAL theme preset that passes `normalizeConfig()` and renders for real through the existing renderer.

## Files created / modified
| File | Change |
|---|---|
| `src/lib/site-config.ts` (modified) | Appended 12 ids to `TEMPLATE_IDS` (after `polymath-index`, new `// v2 style templates` comment block); added `STYLE_TEMPLATE_IDS` const export + `StyleTemplateId` type; added 12 new entries to `templatePresets()` using the existing `tplSection(...)` helper pattern. |
| `src/components/bean/site/studio/TemplateGallery.tsx` (created) | `"use client"` component. Responsive grid (1/2/3 cols) of 12 dark cards (bg `#141519`, champagne `#e8bc51` accent, rounded-lg, `hover:-translate-y-0.5`). Each card: pure-CSS swatch preview built from the template's own theme tokens (background/gradient, masthead dashes reflecting `navLayout`, headline bars reflecting `headingAlign`, card blocks reflecting `columns`/`imageRatio`/`radius`/`surfaceOpacity` and full glass treatment when `theme.glass.enabled`), label + description, motion-preset badge, "Applied" state ring/badge/button for the active template, shadcn `Button` Apply (calls `onApply(id)`) and optional ghost "Live preview" (calls `onPreview(id)`). Props: `{ currentTemplateId?, onApply, onPreview?, disabled? }`. |
| `tests/style-templates.test.ts` (created) | 10 bun tests: exact id list/order/uniqueness, ids registered in `TEMPLATE_IDS`, presets present with 4–7 sections, every preset passes `normalizeConfig`, all font ids (`font/headingFont/bodyFont/accentFont/codeFont`) exist in `SITE_FONTS`, all motion preset/easing/microInteractions/background ids exist in `MOTION_PRESET_IDS`/`MOTION_EASING_IDS`, glassmorphism glass fields valid + `surfaceOpacity < 100`, no bluish accent (brand rule), TemplateGallery module importable/exports component. |

No other files touched (no WebsiteBuilderView, no API routes, no deployment).

## The 12 style templates (ids, in gallery order)
1. `minimal-index` — near-white `#fbfbfa`, ink mono-accent, geist-sans, radius none, `fade-up-soft` @ intensity 30
2. `modern-loft` — graphite `#17181b` + copper `#d98e4a`, inter, radius md, `zoom`
3. `editorial-press` — paper `#faf7f1`, press-red `#a03123`, fraunces + newsreader + inter accents, grand typeScale, wide tracking, stacked masthead, `maskReveal`
4. `creative-playbook` — warm paper `#fbf2e6`, coral `#e0603c` + green `#3f8f5f`, bricolage-grotesque/outfit, pill buttons, `stagger` @ 80ms + `hover-tilt`
5. `developer-term` — phosphor green `#4ecf6e` on green-tinted dark `#0a0f0a`, jetbrains-mono headings + vt323 accent font, sharp corners, `type-steps` (typewriter), stats + projects grid
6. `designer-desk` — bone `#f4f1ea`, burnt sienna `#a4552e` + sage `#566246`, fraunces/geist-sans pairing, featured case studies, `maskReveal` (drift)
7. `photography-frame` — dark neutral `#121315`, warm grey accent, tenor-sans + ibm-plex-mono, wide masonry gallery, outline buttons, centered headings, `media-zoom-slow`
8. `agency-roster` — light `#f7f6f3`, bold berry `#b0325f`, space-grotesk/inter, 7-section agency order (hero→services→skills→projects→stats→testimonials→contact), `stagger-scale`
9. `corporate-ledger` — structured light `#f8f8f7`, charcoal ink, serious green `#2f5d50`, public-sans, ruled dividers, minimal motion (`fade-only`, `once: true`)
10. `dark-luxury` — obsidian `#090a0c` + champagne gold `#e8bc51` (BEAN brand), fraunces light, italiana accent font, grand scale, relaxed density, centered nav/headings, gold dividers, `maskReveal` (gentle)
11. `glassmorphism` — warm dusk gradient (`#1c1a19→#4a3b2c` @165°), glass system ENABLED (`enabled: true`, preset `dark`, blur 22, opacity 38, tint `#26221f`, targets nav+cards+buttons), `surfaceOpacity: 55`, full radius, pill buttons, `blur-up`
12. `experimental-lab` — bone/coral duotone (`#f2ede3`/`#ff5c38`/ink), syne + space-grotesk + space-mono, `headingAlign: center`, `navLayout: stacked`, columns 3, accent dividers, `rotate-in` @ intensity 80 + `hover-magnet` + `bg-glow-pulse` background

All motion/easing ids verified against `src/lib/site-motion.ts`; all font ids verified against the 129-family `SITE_FONTS` library; all section types exist in `siteSectionSchema` (11 types — note: no `education`/`achievements` section types exist, so none used).

## Verification (REAL exit codes)
| Command | Result |
|---|---|
| `bun -e "…normalizeConfig check for all 28 templatePresets…"` | `checked 28`, zero FAIL lines |
| `bunx tsc --noEmit` | exit **0** |
| `bun test tests/style-templates.test.ts` | exit **0** — 10 pass, 0 fail (267 expect calls) |
| `bun test` (full suite) | exit **0** — **357 pass, 0 fail** across 23 files (baseline 347 + 10 new) |
| `bun run lint` | exit **0** |

## Notes / handoff
- Templates with `professions: []` flow through the existing template schema unchanged; any consumer that filters by profession chips will simply see them under "all".
- `TemplateGallery` is not yet wired into `WebsiteBuilderView` (out of scope for this task). Parent integration contract: render `<TemplateGallery currentTemplateId={config.template} onApply={(id) => …} onPreview={(id) => …}? disabled={saving} />`; `onPreview` is optional and should open the real iframe preview dialog.
- dev.log shows only pre-existing, unrelated warnings (`src/instrumentation.ts` edge-runtime notice, a persist-compaction notice); nothing referencing site-config/TemplateGallery/style-templates.
