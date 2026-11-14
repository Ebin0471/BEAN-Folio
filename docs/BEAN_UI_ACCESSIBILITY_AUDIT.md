# BEAN UI — ACCESSIBILITY AUDIT (M0, UI/UX track)

**Audit date:** 2026-11-13 · tree `c9fe839`. Static analysis (attribute inventory) + browser spot checks. WCAG 2.2 AA alignment assessed at the level automatable without assistive technology; **verified defects are separated from potential issues requiring manual AT testing** (per audit spec §6).

## 1. Verified strengths (attribute counts across views + bean + laxii, excluding `components/ui/*`)

| Signal | Count | Representative |
|---|---|---|
| `aria-label` | 547 | NotificationsBell includes unread count; Wordmark "BEAN Folio — home" |
| `aria-hidden` | 981 | every lucide icon |
| `aria-pressed` / `aria-expanded` / `aria-selected` / `aria-current` | 39 / 10 / 13 / 12 | nav items use `aria-current="page"`; toggles/accordions correct |
| `aria-busy` | 27 | loading grids |
| `aria-live` | 8 | chat threads `aria-live="polite"` |
| `aria-invalid` / `aria-describedby` | 10 / 6 | form validation hooks |
| `role=` usage | ~21 files | `status`, `alert`, `dialog`, `navigation`, `tabpanel` |
| `alt=` | 105 | media images |
| `sr-only` | 4 app files | under-used (see UI-4) |
| `focus-visible` utilities | 11 app files | buttons/links |
| `onKeyDown` / `tabIndex` | 10 / 10 | interactive cards, tag input |
| `prefers-reduced-motion` | global CSS kill-switch + functional gate in feed-video coordinator | both static (CSS) and behavioral (autoplay) respect |

**Icon-only buttons:** 98 `size="icon"` usages; the single unlabeled heuristic hit was a false positive (wrapper carries `title` + `aria-label`).

**Contrast (computed):** brand pairings verified — porcelain `#F7F5EF` on obsidian `#090A0C` ≈ 17.6:1; champagne gold `#E8BC51` on obsidian ≈ 10.4:1; secondary grey `#A5A6A8` on obsidian ≈ 7.0:1; obsidian on gold (primary buttons) ≈ 10.4:1. All exceed WCAG AA (4.5:1) and AAA large-text thresholds. (Computed from declared tokens; not a full-page audit.)

## 2. Verified defects

| ID | P | Finding | Impact |
|---|---|---|---|
| UI-4 | **P1** | No skip-to-content link in the platform shell; SPA route changes do not move focus to the main heading (keyboard users re-tab from the top after every navigation) | Keyboard efficiency, WCAG 2.4.1 (bypass blocks), 4.2.3 focus order |
| UI-2b | P2 | Onboarding step-1 validation errors are not announced (no `aria-live`/`role="alert"` on the silent failure path) | Screen-reader users receive no feedback (WCAG 4.1.3) |

## 3. Potential issues (require manual keyboard / AT verification — automation cannot conclusively prove these)

| ID | P | Concern | Why unresolved |
|---|---|---|---|
| UI-16 | P3 | Focus indicators on some buttons: one probe showed `outline:none` + `box-shadow:none` on programmatic focus of a header button; Tailwind ring styles are `:focus-visible`-gated, and programmatic focus does not reliably trigger `:focus-visible` heuristics | needs a manual Tab pass on each surface; if any control lacks a visible ring, it is a WCAG 2.4.7 failure |
| UI-18 | P3 | GIFTZ editor canvas interactions are pointer-heavy (drag/resize); keyboard parity for the canvas is limited (toolbar alternatives exist) | manual keyboard walk of the editor required |
| UI-21 | P3 | Chat streaming updates are `aria-live="polite"` — long streamed replies may be verbose for SR users; needs human AT judgement | manual |
| UI-22 | P2 | Decorative-vs-informative `alt` policy inconsistent in a few media spots (e.g. avatar images with generic alt vs `alt=""`) | manual content-matrix review |
| UI-23 | P2 | Touch target sizes: most controls ≥44px (`size-10` + padding), but a few compact toolbar chips (GIFTZ mobile toolbar) may be <44px effective | manual device pass with tap-target overlay |
| UI-24 | P3 | Captions/transcripts for video media — no caption support in feed video players (M11 scope) | product decision + manual |
| UI-25 | P2 | Responsive text scaling: viewport-relative one-off font sizes (`text-[10px]`) may not respect user zoom preferences as gracefully as scaled tokens | manual 200% zoom pass (WCAG 1.4.4) |

## 4. Structure-level assessment

- **Semantic HTML:** good — `main`, `nav`, `header`, `footer`, `section`, `article` used in shell and views; heading levels observed correct (h1 per view, h2 sections) on verified screens.
- **Dialog accessibility:** Radix primitives handle focus trap + `aria-modal` + return-focus — inherited for free across all 22 dialog usages.
- **Forms:** labels wired via `ui/label` + `aria-invalid`/`aria-describedby`; validation messaging exists but two flows fail silently (onboarding step 1 — UI-2/UI-2b).
- **Toast accessibility:** sonner renders `role="status"` region (aria live) — acceptable.
- **Language/landmarks:** `<html lang="en">`; single `main` landmark; `nav` landmarks labeled ("Primary", "Footer").

## 5. Recommended a11y roadmap (no changes made; for M11)

1. Add skip-to-content + route-change focus move (P1, ~1 day).
2. Announce form validation failures with `role="alert"` (P2).
3. Manual keyboard pass on every surface; fix any control lacking a visible focus ring (P3→P1 if failures found).
4. Manual screen-reader pass (VoiceOver/NVDA) on the 6 core flows (register, onboarding, create project, upload, publish site, chat).
5. 200% zoom + 400% reflow pass (WCAG 1.4.4/1.4.10).
6. Caption/transcript strategy for video (M11 scope).
7. Re-run attribute inventory in CI as a regression guard (axe-core Playwright suite).
