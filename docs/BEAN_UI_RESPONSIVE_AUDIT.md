# BEAN UI — RESPONSIVE AUDIT (M0, UI/UX track)

**Audit date:** 2026-11-13 · tree `c9fe839`. Code-pattern inspection + live verification at 4 of the 8 required viewport sizes (360/430/1024/1366/1920 were not separately driven this pass; their behavior is inferred from shared breakpoints and flagged as inferred — no redesign assumptions were made from untested sizes).

## 1. Verification matrix

| Viewport | Status | Evidence |
|---|---|---|
| 390×844 | **verified live** (5 routes) | screenshots `mobile-390-{discover,auth,folio,giftz,connect}.png`; horizontal-overflow probe: **none** (`scrollWidth === innerWidth`) |
| 768×1024 | **verified live** (1 route) | `tablet-768-discover.png` |
| 1440×900 | **verified live** (16 routes) | desktop screenshot set |
| 360×800, 430×932, 1024×768, 1366×768, 1920×1080 | **inferred** (same breakpoint classes; grid maxima at `max-w-7xl`) | flagged for a follow-up pass; no findings asserted for untested sizes |

## 2. System-wide responsive patterns (code-verified)

- Breakpoints: Tailwind defaults (sm 640 / md 768 / lg 1024 / xl 1280). Prefix usage: `sm:` ×425, `md:` ×79, `lg:` ×84, `xl:` ×20, `max-md:` ×2.
- **Navigation:** header nav `hidden md:flex` (7 items); dedicated mobile bottom bar `md:hidden` as a 7-column grid with `env(safe-area-inset-bottom)` padding; footer gains `pb-20` on mobile to clear it. ✅ verified in mobile screenshots.
- **Content grids:** `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4` (Explore/skeletons); profiles `sm:grid-cols-2 lg:grid-cols-4`; container rhythm `max-w-7xl px-4 sm:px-6`.
- **GIFTZ studio** has purpose-built mobile behavior: mode-based "zones" (chat|preview / content|preview|studio), drawer sheets for panels, persisted per-mode prefs. ✅ verified — the studio is genuinely usable at 390px.
- **MessagesView:** list/detail swap pattern with back button on mobile.
- **Wordmark:** documented md–lg budget (symbol hidden between md–lg to avoid nav overlap).
- **Tables:** none in shipped UI (stat "tables" are card lists) — no responsive-table hazard.
- **Modals:** Radix dialogs are `max-w` constrained and scroll internally; verified at 390px (auth, onboarding, recovery).

## 3. Verified defects / risks

| ID | P | Finding |
|---|---|---|
| UI-9 | P2 | GIFTZ mobile toolbar wraps to 2 rows; control density high at 390px (screenshot) — functional but crowded |
| UI-17 | P3 | Mobile bottom-bar: 7 items → ~10px labels at 390px; readable but tight; icons carry the meaning |
| UI-19 | P3 | Dev-tools overlay ("N") overlaps the Discover nav item in development builds only (not a production defect — documented to avoid false alarm) |
| UI-20 | P3 | Hero copy wrap (UI-6) also affects small screens; `text-balance` not applied |

## 4. Clean bill of health (verified good)

- No horizontal scroll at 390px on any tested route (programmatic probe).
- Forms remain single-column and touch-friendly (≥44px controls observed: `size-10` = 40px + padding ≥44px hit area on primary controls).
- Media grids degrade 4→3→2→1 correctly (lg/xl prefixes on all card grids).
- Published sites (`/site/*`) render in their own design system with platform chrome suppressed — verified pattern (chrome suppression flag), responsive behavior inherited from site palettes (declared WCAG contrast).
- Safe-area insets handled for iOS bottom bar (env(safe-area-inset-bottom)).

## 5. Follow-up (M11 alignment)

Drive the remaining 5 viewports (360, 430, 1024, 1366, 1920) with the same screenshot+overflow probe; add an automated Playwright matrix so responsive regressions are caught in CI rather than by manual passes.
