# BEAN UI — IMPROVEMENT ROADMAP (M0, UI/UX track)

**Audit date:** 2026-11-13 · tree `c9fe839`. Prioritized findings with screen, evidence, impact, recommended improvement, and complexity. **This document recommends; it does not change anything.** Every finding from the complete audit is consolidated here with a suggested execution order aligned to the M1–M14 roadmap (`docs/BEAN_FOLIO_ROADMAP.md`).

## Priority definitions

- **P0 Critical** — broken layouts/usability/accessibility barriers; content inaccessible.
- **P1 High** — navigation inconsistency, major responsiveness/usability/visual-hierarchy problems.
- **P2 Medium** — inconsistent components, typography/spacing, information hierarchy.
- **P3 Polish** — minor refinement, motion, micro-interactions.

## Findings register

| ID | P | Screen / Component | Problem | Evidence | Impact | Recommendation | Complexity |
|---|---|---|---|---|---|---|---|
| UI-0 | **P0** | All media-upload flows | Upload route deleted at HEAD; client fallback targets a 404/405 path; uploads fail end-to-end on local-disk deployments | SYSTEM_AUDIT §1.1; 6 failing pinned tests; `ensure-dev.sh` sentinel FATAL | Core creator journey broken | Restore the route verbatim (G1 in roadmap) or remove the fallback + delete pin tests; add CI sentinel | S (restore) |
| UI-1 | P1 | Route resolution (`proxy.ts` + hash router) | Direct path visits to non-rewrite routes (`/explore`, `/auth`, …) show the unstyled default Next 404 instead of the branded in-app NotFound | browser-verified | Confusing first contact; looks broken to crawlers | Extend `proxy.ts` rewrite rules (or a catch-all `not-found.tsx` with brand styling + boot-route) | S |
| UI-2 | P1 | OnboardingView step 1 | Invalid/empty display name fails silently — no inline error, no toast | E2E executed during audit | Users blocked with zero feedback; a11y 4.1.3 | Surface `fieldErrors` like AuthView; add `role="alert"` | S |
| UI-3 | P1 | MediaUploadButton / ProjectEditor | Upload buttons enabled regardless of backend capability; failures only surface as toasts after the fact | code + browser | Wasted user effort; feels broken | Capability probe (`/api/health` or presign preflight) → disable + explain when storage is unconfigured | M |
| UI-4 | P1 | SiteShell | No skip-to-content link; no route-change focus management (SPA focus stays on body) | code inspection | WCAG 2.4.1/2.4.3; keyboard efficiency | Add skip link; focus `main`/h1 on route change | S |
| UI-5 | P1 | Design system (globals.css / tailwind.config.ts) | Dead `.light` token block + vestigial HSL-mapped `tailwind.config.ts` never loaded by Tailwind 4 — two misleading token sources | DESIGN_SYSTEM_AUDIT §6 | Maintainer hazard; future theme bugs | Delete config; delete or formally decide the light theme | S |
| UI-11 | P2 | Bundle scope | 4 orphaned views (4,788 LOC) + 23 unused ui primitives + 6 orphaned bean components | COMPONENT_AUDIT §2 | Maintenance drag, bundle bloat, confusion | Execute the dead-code cleanup (roadmap G5) | M |
| UI-6 | P2 | DiscoverView hero | "BEAN Intelligence × BEAN Folio" copy orphan-wraps at 1440px | screenshot `desktop-1440-discover.png` | Polish/perceived quality | Apply `.text-balance` / adjust copy container | S |
| UI-9 | P2 | GIFTZ mobile toolbar | 2-row toolbar, high control density at 390px | screenshot `mobile-390-giftz.png` | Touch precision, clutter | Collapse secondary controls (history/export/undo) into the existing overflow menu on mobile | M |
| UI-12 | P2 | LaxiiStudio (1,982 LOC) | Monolith component; 3 studios in one file | code | Maintenance risk | Split per panel + shared composer | M |
| UI-13 | P2 | Media rendering | Only one `next/image` usage; most media raw `<img>` | code | LCP/bytes on media-heavy pages | Route known-dimension images through `MediaThumb`/`next/image`; keep raw for unknown dims | M |
| UI-14 | P2 | Typography | `text-[2.75rem]`, `text-[10px]` bypass the scale | code | Inconsistent hierarchy | Normalize into tokens/whitelist | S |
| UI-22 | P2 | Media alt policy | Decorative vs informative alt inconsistent in spots | code sample | SR noise | Content-matrix pass + convention doc | S |
| UI-23 | P2 | GIFTZ mobile toolbar chips | Some compact chips likely <44px effective touch targets | code + screenshot | Touch usability (WCAG 2.5.8) | Bump hit areas via padding | S |
| UI-25 | P2 | Type scaling | Viewport one-offs may degrade under 200% zoom | inferred (WCAG 1.4.4) | Accessibility | Verify in zoom pass; normalize | S |
| UI-2b | P2 | OnboardingView | Validation errors not announced (`role="alert"` missing) | code | SR feedback (4.1.3) | Add live-region announcements | S |
| UI-7 | P3 | DiscoverView guest composer | Redundant sign-in prompt vs hero CTA | screenshot | Minor redundancy | Conditionally hide when hero CTA visible | S |
| UI-10 | P3 | IntelligenceView zero state | Only canned prompts as guidance | code | First-run clarity | Add one-line capability explainer | S |
| UI-15 | P3 | Icons/labels | sr-only under-used (4 files) | code | SR context | Expand where icon-only patterns grow | S |
| UI-16 | P3 | Focus indicators | Some buttons may lack visible `:focus-visible` ring | probe inconclusive | WCAG 2.4.7 risk | Manual keyboard pass; enforce ring on interactive primitives | S |
| UI-17 | P3 | Mobile bottom bar | 7 items → tiny labels at 390px | screenshot | Readability | Icons-first labels at ≤sm (or 5 items + more-sheet) | M |
| UI-18 | P3 | GIFTZ canvas | Limited keyboard parity for canvas interactions | code | a11y of editor | Keyboard nudges/shortcuts (M11 scope) | M |
| UI-19 | P3 | Dev overlay | Next dev-tools badge overlaps Discover nav item (dev-only) | screenshot | None in production | No action (documented) | — |
| UI-20 | P3 | Hero copy on mobile | Same orphan-wrap as UI-6 at small widths | screenshot | Polish | Same fix | S |
| UI-24 | P3 | Feed video | No captions/transcript support | code | a11y (M11 scope) | Caption pipeline decision at M11 | L |

## Recommended execution order

**Immediate (with gate tasks, pre-M1):** UI-0 → UI-2/UI-2b → UI-1 → UI-4 → UI-5 (all S-size; they remove every user-facing brokenness found).

**With M1 (identity work):** UI-3, UI-14, UI-22, UI-25, UI-16 (keyboard pass), prune unused primitives (part of UI-11).

**With M2 (studio):** UI-9, UI-17, UI-18, UI-12 (LaxiiStudio split), UI-13 (image unification), remainder of UI-11 (orphan views).

**Continuous/polish:** UI-6/UI-20, UI-7, UI-10, UI-15, UI-19 (no action), UI-24 (deferred to M11 caption pipeline).

## Counts (final)

**P0 ×1 · P1 ×5 · P2 ×10 · P3 ×9** (includes reclassifications: UI-8 voided; UI-2b/UI-19–UI-25 added during component/a11y passes). Total distinct findings: **25** — of which 15 are small (S), 7 medium (M), 2 large (L), 1 no-action.

## Final report summary (per audit spec §12)

- **Screens inspected:** 28 views + statics/dialogs (code) · **15 routes live** · **114 components**.
- **Desktop (1440×900):** 16 routes verified — visually cohesive, zero errors; findings UI-6, UI-1.
- **Mobile (390×844):** 5 routes verified — no horizontal overflow anywhere; dedicated mobile UX in GIFTZ confirmed; findings UI-9, UI-17.
- **Accessibility:** 2 verified defects (UI-4, UI-2b); 7 potential issues requiring manual AT passes.
- **Issue counts:** P0 1 · P1 5 · P2 10 · P3 9.
- **Screenshots:** 20 committed under `docs/audit-screenshots/`.
- **Inaccessible this pass:** ModerationView (admin fixture), editor sub-dialogs with media (needs seed), LAXII generation (needs provider) — documented, not assumed.
- **Design-system inconsistencies:** dead light theme; dead tailwind config; two scrollbar idioms; arbitrary type sizes; three loading mechanisms.
- **Competitive findings:** BEAN's evidence-first identity is a genuine differentiator vs Behance/Dribbble/Contra/Fueler; GIFTZ studio polish is Framer/Webflow-class (verified).
- **Suggested implementation order:** see above — S-sized fixes first (all before M1), M-sized bundled into M1/M2, L-sized deferred to M11.
