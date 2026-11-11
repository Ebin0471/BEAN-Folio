# Task A-3/A-4-frontend — Chat-driven Visual Website Coding Studio (three-zone workspace)

Agent: A-3/A-4-frontend (Z.ai Code). Prior-agent notes consumed: `A-4-templates.md` (TemplateGallery contract), `6-c-dead-code-cleanup.md` (namespace-split curl caveat), `3-c-backend-api.md`.

## What was built

`src/views/WebsiteBuilderView.tsx` was rewritten from 3,993 lines (Design/Content/AI tabs) into a **three-zone workspace** (now 1,818 lines):

- **Header**: `CODE GIFTZ` wordmark + "Website Studio" chip · site-name input (config.name → site.json identity) · **SaveControls** cluster · device switcher (Desktop 1280 / Tablet 768 / Mobile 390, real iframed viewports) · undo/redo (Ctrl/Cmd+Z/Y kept) · export-ZIP · share menu (Copy link / Share / Open live, canonical-URL honesty kept) · live-address chip (xl, published only).
- **LEFT — `studio/ChatPanel.tsx`** (new): conversational website coding wired to the NEW backend (`/api/me/site/studio/sessions*`, `/api/me/site/studio/turns/[taskId]`). Sessions dropdown (load/switch/new/rename-inline-PATCH/two-step delete), USER right bubbles (champagne `gold-soft`), ASSISTANT left glass bubbles, `meta.stage` progress line ("Queued… / Planning changes… / Applying changes…"), spinner while RUNNING, FAILED → destructive card with the user-safe `error` + "try again" hint (no fake success), DONE proposals → **ProposalCard** with changed-file mini tree (`path` + added/modified/removed badge + summary), summary text, honest verification counts (pass/warn/failed parsed defensively from `unknown`), and **"Preview changes"** → hands the proposal config to the parent for isolated center rendering; card flips to "Previewing — not saved" while active. Composer: Enter sends / Shift+Enter newline, 4000-char counter, disabled while the session's turn is PENDING/RUNNING, 1.5 s task polling (auto-resumes if a session with a running turn is reopened), Edit-site / From-profile mode toggle, note "changes preview in isolation until you save". Sends `currentConfig` + `context {device, pageName, sectionType?, sectionTitle?}` (truncated to the API's max lengths) with relative fetch paths only.
- **CENTER — live preview**: existing PreviewFrame + DeviceStage kept untouched (real SiteRenderer, cloned stylesheets, font-var mirroring, visual-only scaling). When a proposal is previewed: amber banner "Previewing changes — not saved yet" with **Save/Discard**; Save PUTs the proposal through the SAME `/api/me/site` (server-side "Before save" revision snapshot happens), applies it to the draft only after the PUT is confirmed (a failed save can never leave proposal content on canvas after a later Discard), then clears the preview; Discard reverts to the draft without touching anything. Advisory staleness line (client-side FNV-1a twin of the server's `configFingerprint`, warn-only, never a gate). Interactive click-to-select disabled while previewing a proposal; selecting a section on mobile jumps to the Studio zone.
- **RIGHT — `studio/StudioRail.tsx`** (new): scrollable panel (`overflow-y-auto`, thin scrollbars) of collapsible PanelGroups holding every REAL control from the old Design/Content tabs, same mutations:
  1. **Templates** — sibling-built `<TemplateGallery>` (`onApply`→applyTemplate semantics preserved; `onPreview`→ NEW live-preview dialog that renders the candidate config through the real PreviewFrame/SiteRenderer — not a screenshot; wrapped in `[&>ul]:grid-cols-1` so its wide-container grid fits the 340px rail; component file untouched).
  2. **Colors** — PaletteLibrary (moved) + 8 custom token editors + gradient (from/to/angle, background-pick-into-gradient quirk preserved) + surfaceOpacity slider + WCAG ContrastRow with one-click Fix.
  3. **Typography** — 4 FontSelects + typeScale/headingWeight/lineHeight/letterSpacing/headingAlign.
  4. **Layout & sections** — contentWidth/columns/density/radius/imageRatio/navLayout/pageTransition/divider + page manager (add/duplicate/rename/move/hide/delete) + section manager (add/duplicate/move/hide/delete) + the old ContentTab's full per-section editor (moved to `studio/SectionEditor.tsx`: hero variant/subtitle/CTA, about/contact body, projects layout/category/limit, collections limit, gallery source/layout/limit, services/experience/testimonials item CRUD, per-section motion + style overrides).
  5. **Motion** — MotionPicker + duration/stagger/intensity sliders + easing + hover/microInteractions/background/scrollReveal/once + reduced-motion note.
  6. **Presentation** — tagline, design presets (applyDesignPreset) + reset-to-template-defaults, logo upload/BEAN-mark/remove (8 MB image checks kept), buttonStyle/linkStyle, full glass system (presets/targets/blur/tint/border/highlight/shadow/gradient), performance mode, watermark PATCH ("Made with BEAN Folio · Code Giftz").
- **Mobile**: bottom segmented control Chat/Preview/Studio (`role=tablist`, min-h-11 targets); zones stay MOUNTED and toggle via `hidden`/`flex` so the iframe and an in-flight chat poll survive switching; preview full-bleed.

`SaveControls.tsx` (new): one honest badge — "Previewing — not saved" (amber) / "Unsaved changes" (amber dot, click → popover listing the summarized diff via moved `summarizeConfigDiff`) / "Published" (green; "· draft ahead of live" amber variant) / "Saved" (green). Buttons: Save (disabled when clean), Discard (AlertDialog confirm, only when proposal/dirty), Restore (revisions dialog), Publish/Republish (opens NEW explicit review dialog — never one-click silent), Unpublish (AlertDialog confirm).

## Files
| File | Change |
|---|---|
| `src/views/WebsiteBuilderView.tsx` | rewritten (3,993 → 1,818 lines) |
| `src/components/bean/site/studio/controls.tsx` | created — PanelGroup, FavStar, RowButton, LibraryFilter, FontSelect, MotionPicker, ContrastRow, PaletteLibrary, useLibraryPrefs, SECTION_TYPE_LABELS/HINTS, SectionSummary, summarizeConfigDiff |
| `src/components/bean/site/studio/SectionEditor.tsx` | created — old ContentTab editor, condensed |
| `src/components/bean/site/studio/ChatPanel.tsx` | created (723 lines) |
| `src/components/bean/site/studio/SaveControls.tsx` | created |
| `src/components/bean/site/studio/StudioRail.tsx` | created (998 lines) |
| `src/components/bean/site/CodeGiftzPanel.tsx` | **deleted via `git rm`**; `rg CodeGiftzPanel src/ tests/` → 0 matches |

Not touched (per constraints): `src/lib/site-studio/*`, `src/app/api/**`, `src/lib/ai-design/*`, `SiteRenderer.tsx`, `TemplateGallery.tsx`, tests, `GiftzHandoffPanel.tsx`.

## Kept vs removed
Kept: data load + silent server seed, dirty/liveMatchesDraft/draftAheadOfLive, history/undo/redo + shortcuts, Escape deselect, localStorage draft recovery (`bean:ws-draft:<uid>`), beforeunload guard, PreviewFrame/DeviceStage/device switching, revisions dialog + restore, publish/unpublish + link dialog + canonical-URL honesty, export ZIP (flushes draft first), watermark PATCH, logo upload, library favs/recents, template apply semantics (pristine full-adopt vs content-preserving).
Removed: 3-tab panelTab system, CodeGiftzPanel (plan-review card / PREVIEW ONLY / audit button / materials upload UI), old proposal banner + accept/stale-guard flow (replaced by proposal-from-chat-message with warn-only staleness note), left structure panel (merged into the rail).
**Dropped by design choice (spec-permitted, noting):** `runPreviewChecks` + browser-checks imports (audit button is gone; nothing consumes them), **Compare with live / stranger's view** (side-by-side panes fight the three-zone layout; publish + "Open live website" cover the need) — `/api/profiles/<username>` compare fetch removed with it.

## Verification (REAL exit codes)
| Check | Result |
|---|---|
| `bunx tsc --noEmit` | **exit 0** |
| `bun run lint` | **exit 0** |
| `bun test` (full) | **exit 0 — 357 pass / 0 fail**, 2,397 expect calls, 23 files (baseline preserved) |
| `dev.log` (last 40 lines) | **No errors from my files** (0 log references to any of them). BUT: the dev server's Turbopack persistent cache is corrupted since **01:58** — `.next` was truncated to 92 KB while `next-server` (started 01:32) was running, so it loops on `Failed to restore task data … Unable to open static sorted file 00000413/414.sst` + `Persisting failed`. My first edit was **02:07** (controls.tsx), i.e. the corruption predates all my changes and references only Turbopack internals. Consequence: the running server cannot compile or hot-reload anything (a `touch` + 25 s watch produced no new compile lines) until it is restarted. I did NOT restart it (system-owned). **Action needed: restart `bun run dev` (fresh `.next`) so the preview serves the new studio.** tsc+lint+tests all compile/typecheck the new code successfully. |

## Deviations / notes
1. **Staleness guard**: replaced by an ADVISORY amber note (client-side FNV-1a matching the server's `configFingerprint`), not a hard block — the user always sees exactly what would be saved on the canvas before saving.
2. **Materials upload UI** (CodeGiftzPanel's create-workflow file attach) is not re-implemented in ChatPanel; the API's `materialIds` field is simply omitted (schema default `[]`). The "From profile" mode toggle covers create-mode grounding via the portfolio block.
3. Section click in the preview opens the editor inside the (possibly collapsed) "Layout & sections" group — one extra click vs the old auto-tab-switch; acceptable for the reorganization.
4. TemplateGallery is pinned to 1 column inside the rail via a parent wrapper class (component unmodified) — its `sm:grid-cols-2 xl:grid-cols-3` breakpoints are viewport-based and would squeeze 3 cards into 340px at xl.
5. Publish dialog is NEW (spec: explicit approval); the post-publish "Your website is live" dialog is the existing one.
