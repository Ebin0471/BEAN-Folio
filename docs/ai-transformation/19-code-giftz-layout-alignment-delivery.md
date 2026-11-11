# Delivery 19 — CODE GIFTZ Workspace Alignment & UX Fix

**Status:** implemented and verified in this session. **Not deployed.**
**Task:** focused layout/usability correction of the CODE GIFTZ editor
workspace (`#/giftz`) — the chat was too narrow, the preview too dominant,
there was no resizable divider, and the composer/header had proportion and
wrap defects. The task explicitly forbids redesigning BEAN Folio, changing
the generation engine, the publishing behavior, or removing functionality.

---

## 1. Root causes found (audit before code)

1. **Fixed-width chat sidebar** — `WebsiteBuilderView.tsx` rendered the chat
   aside at hardcoded `lg:w-[360px] xl:w-[400px] 2xl:w-[440px]` with the
   preview on `flex-1`. At 1440 that is 400px chat (28%) vs 1040px preview
   (72%) — the exact inverse of the requested 36–42% / 58–64% split.
2. **No resizable boundary** — the only boundary control was
   `PanelCollapseRail`, a 20px collapse toggle. No drag resize existed.
3. **Composer too cramped** — the prompt textarea had `min-h-16` (64px); the
   helper line had no truncation so it wrapped/overlapped at narrow widths.
4. **Header overflow wrap** — at 1440 the top toolbar's last control
   ("More …") wrapped to a lonely second row; at 1366/1280 the wrap was
   unbalanced (dead spacer space row-1 while tools wrapped).
5. **What was NOT broken (kept as-is):** the chat panel's flex contract
   (header shrink-0 / thread `flex-1 overflow-y-auto` / composer shrink-0),
   the changed-files `max-h-44` internal scroll, the preview iframe internal
   scroll, and the DeviceStage visual scaling (real iframe viewport never
   changes; published site renders at full browser width — re-verified).

## 2. Files changed (4 + 1 test file)

| File | Change |
|---|---|
| `src/components/bean/site/studio/prefs.ts` | Added `chatWidthPct` to `GiftzPrefs` (default `40`, hard clamp 32–55 on read), exported `DEFAULT_CHAT_WIDTH_PCT / CHAT_WIDTH_PCT_MIN / CHAT_WIDTH_PCT_MAX`. |
| `src/views/WebsiteBuilderView.tsx` | New `ChatResizeDivider` (drag + keyboard + collapse + dblclick-reset); workspace row measured via `ResizeObserver`; chat width driven by CSS var `--giftz-chat-w` (= effective %); px floors chat ≥ 380px, preview ≥ 500px (+22px divider reservation); prefs refactored to pure-updater + ref-mirror persistence (storage writes moved OUT of state updaters); header compaction (gap, label breakpoints). |
| `src/components/bean/site/studio/ChatPanel.tsx` | Composer `min-h-20` + `leading-relaxed` (field-sizing growth + `max-h-40` internal scrollbar preserved); helper text truncated with tooltip; session header `flex-nowrap overflow-hidden`; proposal-card action row `flex-wrap` with `shrink-0` buttons; char counter `shrink-0 tabular-nums`. |
| `src/components/bean/site/studio/SaveControls.tsx` | Discard/Restore labels `xl:inline → 2xl:inline` (header fit). |
| `tests/studio-prefs.test.ts` | Fixed 9 pre-existing union-type errors via a `readGiftz()` narrowing helper; ADDED `chatWidthPct` coverage: default band 36–42, round-trip, clamp below/above, garbage/NaN → default. Verification strengthened, nothing removed. |

## 3. Exact layout & scrolling corrections

- **Three-region workspace:** chat = `${pct}%` of the measured workspace row
  (default 40% → 576px at 1440), divider 22px, preview flex-1. Bounds:
  percent clamped to [32, 55] AND px-floored per region, so preview always
  keeps ≥ 500px and chat ≥ 380px at any desktop width.
- **Resizable divider (`ChatResizeDivider`):** 22px column containing a full
  drag surface + the existing collapse chevron (same aria labels as the old
  rail, so collapse functionality is preserved, not removed).
  - Pointer-capture based drag (events retarget to the strip even over the
    preview iframe); window-level move/up/cancel/lostpointercapture
    listeners; **idempotent end-drag commit** so a lost pointerup can never
    strand an unsaved draft width.
  - The % is measured against the WORKSPACE ROW (via `workspaceRef`) —
    measuring the moving divider itself would feed the cursor back into its
    own position (found and fixed during browser testing).
  - Keyboard: `role="separator"` + `aria-valuenow/min/max`, ←/→ ±1%
    (Shift ±5%), Home/End to bounds; double-click resets to 40%.
  - Drag shows a fullscreen cursor overlay; `touch-none` on the strip.
- **Persistence:** drag updates a draft state (no 60fps storage writes);
  drag-end / keyboard steps commit to the giftz prefs key
  (`bean:ws-prefs:giftz.chatWidthPct`), surviving reloads — beyond the
  required "persist during the editing session".
- **Scrolling map (audited, unchanged where already correct):** page = no
  scroll (`h-[calc(100dvh-4rem)] overflow-hidden`); chat thread = only
  scroll region of the panel; changed files = internal `max-h-44` scroll;
  prompt textarea = internal scroll beyond `max-h-40` (scrollbar preserved);
  preview = iframe-internal vertical scroll; no horizontal scroll at any
  tested desktop size.
- **Header:** gap tightened to `sm:gap-1.5`; device labels and live-address
  chip now appear at `2xl`; the hidden spacer only exists at `2xl+`; Result:
  ONE row at 1440/1366 in the heaviest state (proposal-active + Discard +
  Unpublish), a balanced clean two-row cluster at 1024–1280.

## 4. Browser verification (agent-browser, real flows)

Viewport matrix (measured widths from the live DOM):

| Viewport | Chat | Preview | Notes |
|---|---|---|---|
| 1440×900 | 576px (40%) | 842px | single-row header; Send visible; no h-scroll |
| 1366×768 | 546px (40%) | 798px | single-row header after chip fix |
| 1280×720 | 512px (40%) | 746px | clean 2-row toolbar; no clipping |
| 1024×768 | 410px (40%) | 592px | drag floors verified: chat pinned at 380px, preview pinned at 500px exactly |
| 390×844 | full-width chat zone | full-width preview zone | switchable zones, composer + Send visible, no squeeze |

Interactive checks (all passed):
- Divider drag right/left at 1440: 55% → 40% → 55%, localStorage
  `chatWidthPct` updated each time (40 / 55 / 34.8 / 48.6 observed); reload
  restores the persisted width.
- Divider keyboard: focus + ArrowRight committed 55 to storage.
- Double-click reset → 40. Collapse chevron → chat 0px; expand → back.
- px floors at 1024: left drag pins chat at exactly 380px; right drag pins
  preview at exactly 500px (after the 22px divider reservation fix).
- Composer: 307-char prompt grows 80→132px; 2419-char prompt caps at 160px
  with internal scrollbar; counter 2419/4000; Send visible and inside the
  panel; helper line truncated, never overlapping.
- Real generation round-trip: "Change the tagline to Design with heart." →
  plan → execute → proposal card (CHANGED FILES · site.json · MODIFIED ·
  "6 passed · engine verification") → auto-preview rendered the generated
  site in the isolated canvas → header "Save Draft" → confirm dialog →
  "Saved 10:08 AM", banner cleared. (One earlier turn failed mid-pipeline
  with the honest per-step error — engine-internal LLM-output flakiness,
  pre-existing, engine untouched; the UI surfaced it honestly.)
- Publish → public site opened at `#/u/qalayout`: renders at the FULL
  1440px viewport width (`widestSection: 1440`, no horizontal scroll) — the
  editor preview width does NOT restrict the published site.
- Customization mode regression check: content editor (400px) / canvas /
  studio (400px) + both `PanelCollapseRail`s intact; collapse expands the
  canvas 600→1000px and restores; canvas iframe scrolls internally.
- Screenshots: `agent-ctx/shots/giftz-{1440-chat,1440-proposal,1366,1280,
  1024,390-chat,390-preview,1440-final}.png`.

## 5. Static checks & tests

- `tsc --noEmit`: clean (also fixed 9 pre-existing type errors in the prefs
  test file while strengthening it).
- `eslint .`: clean.
- `bun test` (batched to fit sandbox memory): 372 pass / 2 fail — the 2 are
  `tests/auth.test.ts` "QA/E2E fixture accounts" checks failing on
  **baseline too** (verified via `git stash`: the sandbox DB lost the QA
  seed accounts; unrelated to this task, not weakened or skipped).
- Production build: `next build` in the isolated `/tmp/bean-build` copy —
  succeeded (only the pre-existing benign `instrumentation.ts` edge-runtime
  warning); standalone server booted on PORT=3100: `/ → 200`,
  `/api/ready → {"ok":true}`.

## 6. Remaining issues

1. The 2 pre-existing auth fixture-account test failures (DB drift in the
   sandbox, present before this change).
2. Occasional multi-step generation failures inside the AI engine (honest
   per-step error shown; documented in delivery 17 as Fix 1 territory —
   engine deliberately untouched in this layout task).
3. Device labels are icon-only below 1536px (2xl) — tooltips and
   `aria-label`s retained; a deliberate trade to keep the toolbar on one
   row at common desktop widths.

## 7. Scope discipline

BEAN Folio branding, obsidian/champagne theme, typography, Customization and
CODE GIFTZ tabs, device previews, Edit-site/From-profile modes, Save
Draft/Publish/undo/redo/download, generation engine, APIs, data and
publishing behavior — untouched. No new UI library, no fake functionality,
no backend changes, nothing deployed.
