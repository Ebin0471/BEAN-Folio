# Delivery 18 — Workspace Expansion, Separate Settings & 54 Website Templates

**Status:** implemented and verified in this session. **Not deployed.**
**Task:** six corrections to the Website Studio (`#/giftz`) — expand the
cramped workspace, remove duplicate Save controls with two independent save
workflows, two fully independent settings areas, a Templates panel containing
ONLY complete website templates, and a library of at least 50 genuinely
different website templates — verified end-to-end in the browser.

---

## 0. What was audited first

- `src/views/WebsiteBuilderView.tsx` (2,212 lines pre-change) — three-zone
  workspace, header save cluster, proposal banner, template live-preview
  dialog.
- `src/components/bean/site/studio/` — `TemplateGallery` (14 templates,
  one flat grid), `SaveControls` (single shared save cluster), `ChatPanel`
  (one autoPreview setting), `StudioRail` (Templates panel + Typography /
  Colors / Motion / Presentation groups), `prefs.ts` (per-mode device +
  autoPreview only).
- `src/lib/site-config.ts` — `TEMPLATE_IDS` (27), `STYLE_TEMPLATE_IDS` (14),
  `templatePresets()` structure, theme/motion registries.
- Tests: `tests/style-templates.test.ts`, `tests/studio-isolation.test.ts`.

Audit findings that drove the work:

1. **Workspace** — asides fixed at 340 px with no way to reclaim the width;
   the center column nested a `p-2` wrapper plus TWO chrome rows (reload row
   + caption row) below the banner; at 1440 the canvas was 760 px and the
   1280-wide desktop preview scaled to ≈0.55.
2. **Save controls** — ONE shared cluster in the header PLUS a second Save +
   Discard pair inside the proposal banner = two visible Save affordances for
   the same operation, with no per-mode status ("Saved"/"Save failed" did not
   exist; only dirty/saving).
3. **Settings** — CODE GIFTZ had exactly one setting (autoPreview) in a
   popover; Customization had real panels but no collapse state; nothing
   pinned which panel belonged to which mode beyond convention.
4. **Templates** — the gallery was already templates-only (fonts/animations
   live in their own panels — verified in DOM and code), but it held only 14
   templates and its thumbnails were a single abstract composition, so many
   templates looked alike.

---

## 1. EXPAND THE WORKSPACE (priority)

**Files:** `src/views/WebsiteBuilderView.tsx`, `prefs.ts`.

- **Wider panels:** both side asides are now `lg:w-[360px] xl:w-[400px]
  2xl:w-[440px]` (was a flat 340 px). The chat, content editor and design
  studio all gain usable width on large screens.
- **Collapsible panels (the real width win):** a slim 20 px vertical
  `PanelCollapseRail` sits between each panel and the canvas
  (`aria-label="Collapse … — gives the website canvas the full remaining
  width"`). Collapse state is persisted PER MODE in the mode's own prefs
  (`customization.left/rightCollapsed`, `giftz.chatCollapsed`), so each mode
  remembers its own layout. Panels are CSS-hidden (never unmounted), so
  conversation state, in-flight turns and editor state survive collapse.
  **Measured at 1440×900: canvas 600 px → 1000 px (left collapsed) → 1400 px
  (both collapsed).** In CODE GIFTZ the chat rail collapses to a 1420 px
  preview.
- **De-nested center:** the canvas column is now ONE flex column with a
  single compact toolbar row (status caption left + Reload preview right —
  the previous two chrome rows merged), `p-1.5` instead of `p-2`, and the
  `DeviceStage` fills the rest (`minHeight` 440 → 320 as a floor only). No
  nested padded containers remain.
- **Loading skeleton** mirrors the real full-height full-width layout instead
  of a `max-w-7xl` card block.
- **No horizontal scrolling:** verified `scrollWidth ≤ clientWidth` at 1440,
  1280, 1024, 768 and 390; the header stays one 65 px row at every desktop
  width.

## 2. INDEPENDENT SAVE WORKFLOWS (no duplicates)

**Files:** `SaveControls.tsx` (rewritten), `WebsiteBuilderView.tsx`.

- `SaveControls` is now **mode-scoped** (`mode: "customization" | "giftz"`).
  The header renders exactly ONE cluster for the ACTIVE mode:
  - **Customization:** primary **“Save changes”**, Revert (confirm dialog),
    Restore (revisions), Publish/Republish + Unpublish (the separate,
    explicit approval workflow — unchanged).
  - **CODE GIFTZ:** primary **“Save Draft”**, Discard (proposal-aware),
    Restore, Publish/Republish + Unpublish.
- **Per-mode status lifecycle** (`ModeSaveStatus = idle | saving | saved |
  failed` + completion time), tracked independently per mode: saving in
  Customization updates only the Customization chip; saving a draft or a
  generated website in CODE GIFTZ updates only the CODE GIFTZ chip. Chips:
  **“Unsaved changes” → “Saving…” → “Saved HH:MM” → “Save failed — try
  again”** (plus the existing Published / draft-ahead-of-live states).
  Verified live: save → “Saved 07:19 AM”.
- **Duplicate removed:** the proposal banner in the canvas is now STATUS-ONLY
  (“Previewing changes — not saved yet…” + staleness warning) with **zero
  buttons** — Save/Discard live only in the header cluster. Verified in DOM:
  banner contains no buttons, exactly one “Save Draft” button exists.
- **Cross-mode safety:** Customization's Save writes the shared draft WITHOUT
  touching any isolated proposal; CODE GIFTZ's proposal-save keeps the
  staleness warning and (new) an explicit **confirm-before-save** dialog when
  the corresponding CODE GIFTZ setting is on (default on). A failed save
  keeps the dirty state and shows “Save failed” — the badge never claims
  “Saved”.

## 3. TWO INDEPENDENT SETTINGS AREAS

**Files:** `prefs.ts` (extended), `ChatPanel.tsx` (settings UI + wiring),
`StudioRail.tsx` (group labels), `WebsiteBuilderView.tsx` (hydration).

- **Customization settings** (right panel, Customization mode only) —
  Templates (preferences + revert-last-apply) · Color systems · Colors &
  gradients · Typography (129-family library) · Layout & sections · Motion
  (82 presets) · Presentation (identity/logo/buttons/glass/attribution) ·
  per-mode device viewport · per-mode panel collapse. Verified in DOM: all
  groups present and separate from Templates.
- **CODE GIFTZ settings** (gear popover in the chat header, CODE GIFTZ mode
  only) — four labeled sections, every control wired to real behavior:
  - **Chat:** “Enter sends the message” (`enterToSend`) — changes the
    composer keydown handler (off = Enter breaks the line, Ctrl/Cmd+Enter
    sends) and the hint text. Verified live both ways.
  - **Preview:** “Auto-preview generated websites” (`autoPreview`, existing)
    + note that the preview device is remembered per mode.
  - **Validation:** “Show changed-file inventory” (`showFileInventory`) —
    proposal cards render the per-file inventory or an honest one-line count;
    verification results always shown.
  - **Draft & versions:** “Confirm before saving a generated website”
    (`confirmProposalSave`) — drives the Save Draft confirmation dialog.
- **Independence enforced by storage:** `bean:ws-prefs:customization` and
  `bean:ws-prefs:giftz` are separate keys; a toggle in one mode never writes
  the other's state. Verified live in localStorage after toggles, and pinned
  by the new `tests/studio-prefs.test.ts` (8 tests: key separation both
  directions, round-trip, corruption fallbacks, reset-isolation).

## 4. TEMPLATES PANEL — TEMPLATES ONLY

**Files:** `TemplateGallery.tsx`, `StudioRail.tsx`.

- Verified (code + DOM): the Templates panel contains ONLY complete website
  templates. No font presets, animation presets, hover effects, motion
  presets, typography controls or standalone color presets exist inside it —
  those remain in their own Customization sections (Typography, Motion,
  Colors & gradients, Color systems). The panel description states this
  explicitly.
- New: the panel header gains a real **“Revert last apply”** button
  (appears whenever a template apply is undoable) that restores the EXACT
  pre-apply config — design AND section layout — via a snapshot taken in
  `applyTemplate`. This is a true revert for every template (the applied
  card's “Revert” still resets that template's design tokens to its
  defaults; content is kept in both paths).

## 5. THE 54-TEMPLATE LIBRARY (≥ 50 required)

**Files:** `src/lib/site-config.ts` (+40 presets, +collections/meta),
`TemplateGallery.tsx` (collection UI + structural thumbnails).

- `STYLE_TEMPLATE_IDS` grew **14 → 54**; all 54 are complete-website designs
  (structure + section arrangement + color treatment + typography
  configuration + responsive behavior + motion), never single-style presets.
  All originals kept; all ids registered in `TEMPLATE_IDS` so every preset
  round-trips through the zod config schema.
- **15 collections** (`TEMPLATE_CATEGORY_IDS` + `TEMPLATE_CATEGORY_LABELS`),
  each with ≥ 2 and all 54 assigned: Minimal & clean (4) · Modern
  professional (4) · Editorial & magazine (4) · Creative portfolio (5) ·
  Developer & technology (4) · Designer portfolio (3) · Photography (3) ·
  Videography & filmmaking (3) · Agency & studio (3) · Corporate & business
  (3) · Dark luxury (4) · Glassmorphism (3) · Interactive & experimental
  (4) · Architecture & interior (3) · Freelance & personal branding (4).
- **Genuinely different — enforced by test:** no two templates share the
  same structural signature (ordered section `type:layout:variant` chain +
  radius/density/columns/buttonStyle/navLayout/headingAlign/contentWidth/
  imageRatio/heading-font). The gallery groups templates by collection
  (accordion, applied-template's group opens first, applied group marked)
  with a **search box** (name/description/collection — “glass” → 3 matches,
  verified).
- **Structural thumbnails:** every template carries a `swatch` layout hint
  (`TEMPLATE_SWATCH_LAYOUTS`: grid / featured / list / masonry / strip /
  editorial / split / cover / centered / timeline) and the rewritten
  `TemplateSwatch` renders a genuinely different miniature composition per
  layout from the template's own theme tokens (masthead arrangement, hero
  arrangement, block geometry all react to the real theme). Every layout
  value is exercised by at least one template (test-pinned).
- **Every template supports** — name, short description, collection,
  unique structural thumbnail, **Live preview** (real SiteRenderer render in
  the dialog with **Desktop / Tablet / Mobile** tabs — iframe measured at
  scaled-desktop/390 px), **Apply** (content-preserving; glass + surface
  opacity user customizations kept), **Revert** (applied card = reset this
  template's design to defaults; panel header = “Revert last apply” restores
  the exact pre-apply state). Verified in browser: film-cell preview →
  apply → “Applied”+“Revert” → Revert last apply → back to pre-apply state;
  content untouched throughout (profile/projects render identically).
- New templates reuse only font ids from the 129-family library and motion
  preset/easing/background/micro-interaction ids from the live registry —
  all test-validated. No indigo/blue-dominant accents anywhere (brand rule
  test extended to all 54).

## 6. VERIFICATION (real exit codes)

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | **0** |
| `bun run lint` (eslint .) | **0** |
| `bun test` | **406 pass / 0 fail** (3,755 expects, 26 files; baseline was 393/0/25) |
| Isolated production build (`rsync → /tmp/bean-build → bun run build`) | **exit 0** |
| Browser E2E (agent-browser, demo account, real gateway) | see §7 |

New/changed tests (`tests/style-templates.test.ts` rewritten, 15 tests; new
`tests/studio-prefs.test.ts`, 8 tests): ≥ 50 templates; originals kept;
uniqueness; 15 collections ≥ 2 each; schema-valid presets; font/motion id
validation; glass-family validation; no-blue-accent rule; **structural
uniqueness (no duplicate signatures)**; swatch-layout coverage; prefs
independence both directions + corruption fallbacks. The shim in the prefs
test installs/removes `window` per test so nothing leaks into other files in
bun's single-process runner (a module-level shim broke
`standalone-site.test.ts` once — fixed before final run; final suite fully
green). No existing test was weakened or removed.

## 7. Browser E2E (real session, screenshots in /tmp)

- **1440×900 Customization:** two mode tabs; ONE “Save changes” cluster;
  canvas 600 px → 1000/1400 px via collapse rails (no horizontal scroll);
  Templates panel shows 15 collection groups summing to 54 cards
  (4,4,4,5,4,3,3,3,3,3,4,3,4,3,4); search “glass” → glassmorphism,
  frost-panel, prism-glass; film-cell Live preview dialog renders with
  Desktop/Tablet/Mobile tabs (iframe 440 px scaled tablet, 390 px mobile);
  Apply → Revert last apply round-trip; heading-font change (Playfair
  Display) re-renders the canvas h1; reveal-preset change applies; Publish
  opens the explicit review dialog and cancels cleanly; save → “Saved
  07:19 AM”. Screenshots: `/tmp/fix18-custom-collapsed-1440.png`,
  `/tmp/fix18-template-applied-1440.png`,
  `/tmp/fix18-customization-1440-final.png`.
- **1440×900 CODE GIFTZ:** ONE “Save Draft” cluster; gear popover lists
  Chat/Preview/Validation/Draft-&-versions sections with 4 switches;
  toggling “Enter sends” flips the composer hint both ways and persists
  under `bean:ws-prefs:giftz` while `bean:ws-prefs:customization` stays
  untouched; **real AI turn** (“Add a short testimonial quote section…”)
  completed through the real plan→execute pipeline, produced a real
  proposal card, auto-previewed the GENERATED website in the Preview
  workspace with the STATUS-ONLY banner (0 banner buttons, 1 header Save
  Draft); Discard returns to the honest “No website generated yet” empty
  state with zero iframes. Chat collapse → preview 1420 px. Screenshots:
  `/tmp/fix18-giftz-settings.png`, `/tmp/fix18-proposal-preview-1440.png`,
  `/tmp/fix18-giftz-1440-final.png`.
- **1280×720 / 1024×768:** no horizontal scroll; 65 px single-row header;
  giftz canvas 860 px at 1280 (left panel 400 + rail); Send visible.
  Screenshot: `/tmp/fix18-1024-giftz.png`.
- **768×1024:** no horizontal scroll; zone tabs pinned above the (hidden
  ≥768 px) bottom nav. Screenshot: `/tmp/fix18-tablet-768.png`.
- **390×844:** no horizontal scroll; zone tabs Chat/Preview/Studio
  (Customization) and Chat/Preview (CODE GIFTZ); composer bottom 669,
  Send 707/right 378 (75 px wide, fully visible), zone tabs bottom 764,
  bottom nav top 769 — no overlap; Preview zone shows the honest generated-
  only empty state. Screenshots: `/tmp/fix18-mobile-390-chat.png`,
  `/tmp/fix18-mobile-390-preview.png`.
- Console/errors: no page errors beyond the pre-existing benign
  `instrumentation.ts` edge-runtime warning.

## 8. Remaining limitations

- The mobile bottom nav hides the CODE GIFTZ “Preview” zone tab caption
  space exactly as before (pre-existing shell layout, unchanged).
- “Revert last apply” undoes ONE template apply (the most recent); older
  applies remain reachable via the global Undo history and Restore versions.
- Template thumbnails are abstract structural compositions (pure CSS from
  theme tokens), not screenshots — by design (zero asset weight, always in
  sync with the real theme).
- Search matches name/description/collection text only.
- Demo data: one extra real conversation turn (proposal discarded) and a
  draft save of identical content were left in the demo account; published
  site untouched.

**Scope kept:** RIISHE and LAXII untouched; CODE GIFTZ's real coding
workflow, security and approval gates untouched; publish workflow unchanged
and separate; no payment systems; no Ollama; no unrelated pages changed;
**not deployed.**
