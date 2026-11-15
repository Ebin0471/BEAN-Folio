# BEAN UI — COMPLETE AUDIT (M0, UI/UX track)

**Audit date:** 2026-11-13 · tree `c9fe839` · **STRICT AUDIT-ONLY** — zero application changes made.
**Methods:** full source inspection of `src/app`, `src/views` (28 files, 20,802 LOC), `src/components/**` (48 shadcn + 52 BEAN + 14 LAXII), `globals.css` tokens, `tailwind.config.ts`, `proxy.ts`; **live browser verification** (Chrome automation) of 15 routes with 20 screenshots in `docs/audit-screenshots/`; full register→recovery-key→onboarding E2E executed; zero page errors observed across all visited views.

## 1. Totals

| Metric | Value |
|---|---|
| Screens inspected (code) | 28 views + 4 static/dialog surfaces + 2 error/empty patterns |
| Routes inspected (live browser) | 15 (11 desktop 1440×900 · 5 mobile 390×844 · 1 tablet 768×1024) |
| Components inspected | 114 (48 ui + 52 bean + 14 laxii) |
| Screenshots captured | 20 |
| Console/page errors observed | **0** across all visited views |
| P0 issues | **1** |
| P1 issues | **5** |
| P2 issues | **9** |
| P3 issues | **6** |
| Inaccessible screens | 3 authenticated surfaces not independently browser-verified this pass (see §6) |

## 2. Overall design verdict

BEAN Folio's UI is **cohesive, brand-consistent, and honestly engineered**. The obsidian/champagne-gold system is applied consistently (exact tokens verified in code AND visually in 20 screenshots). Empty states are crafted (icon + title + guidance, never lorem), loading uses skeletons/spinners with `aria-busy`, destructive actions are AlertDialog-gated, and toasts (sonner) provide action feedback. The registered claim of "no fabricated UI content" held up under direct search and browser inspection.

The dominant weaknesses are **structural**: 4,788 lines of orphaned legacy views, an unreachable light-theme token block, a vestigial `tailwind.config.ts`, missing SPA-level a11y affordances (skip link, route-change focus), and a handful of cross-view interaction inconsistencies (§4).

## 3. Per-screen findings (verified surfaces)

### Discover (`/`, `desktop-1440-discover.png`, `mobile-390-discover.png`)
- ✅ Hero, create-post gate, suggested profiles, trending hashtags, reels, creator feed tabs all render with real endpoints and honest empty states.
- **UI-6 (P2)** hero copy line-break: "powered by BEAN Intelligence × BEAN Folio" wraps so "× BEAN Folio" orphan-starts a line at 1440px (screenshot evidence; `text-balance` utility exists but is not applied here).
- **UI-7 (P3)** "Create a post" panel shows sign-in prompt to guests while the section header is present — mild redundancy with the hero CTA.

### Explore (`/explore`, `desktop-1440-explore.png`)
- ✅ Filter + sort + debounced search render; empty state correct.
- **UI-1 (P1)** direct path `/explore` (without hash) lands on the **default unstyled Next.js 404** — the proxy rewrites only `/u|/p|/site|/post`; every other app route is hash-only. Branded NotFound exists in-app but is unreachable for direct path visits. Same for `/auth`, `/folio`, `/studio` etc.

### Auth (`/auth`, `desktop-1440-auth.png`)
- ✅ Sign in / Create account tabs, password visibility toggle, forgot-password flow, demo-account helper button, **Google OAuth button honestly disabled** when unconfigured (verified).
- **UI-8 (P3)** "Join BEAN Folio" header button overlaps… (verified minor: header CTA and user-menu swap correctly when authenticated; no overlap found — reclassified, no issue).

### Recovery-key ceremony (`desktop-1440-recovery-key.png`)
- ✅ Show-once key + mandatory acknowledgment checkbox + disabled Continue — excellent security UX.

### Onboarding (`desktop-1440-onboarding.png`)
- ✅ 2-step flow works E2E (identity → professions/skills/bio/location). Username slugify validated inline.
- **UI-2 (P1)** clicking "Continue" on step 1 with an empty Display name **fails silently** (no inline error, no toast) — during audit E2E the field was empty after autofill-skew and the button did nothing until Enter was pressed. Validation exists but its failure is invisible at this step.

### My Folio (`/folio`, `desktop-1440-folio.png`)
- ✅ Editor + AI bio improve + professions/skills selection.

### Studio (`/studio`, `/studio/new`) & ProjectEditor
- ✅ Tabs, templates, media upload UI, AI improve/suggest wiring.
- **UI-3 (P1, backend-dependent)** uploads route deleted at HEAD (SYSTEM_AUDIT defect 1) — upload buttons will fail on local-disk deployments; the UI shows honest errors, but the flow is broken end-to-end today.

### GIFTZ studio (`/giftz`, `desktop-1440-giftz.png`, `mobile-390-giftz.png`)
- ✅ Three-panel desktop editor (content/preview/templates) with device stage, undo/redo, publish; dedicated mobile zones (Content/Preview/Studio) + panel drawers; "Compiling…" status chip; template gallery (54 templates).
- **UI-9 (P2)** mobile toolbar wraps to two rows and the row order (Save → Publish → devices → history → export → more) is dense at 390px; functional but crowded (screenshot).

### Intelligence (`/intelligence`)
- ✅ Conversations sidebar, optimistic send, failure banners with typed retry hints, automation + delegation cards.
- **UI-10 (P3)** canned suggested prompts are the only zero-state guidance; a first-run explainer would help.

### LAXII (`/laxii`)
- ✅ 3-in-1 studio (banner/avatar/resume) fully wired; 1,982-line main component — maintainability concern (P2 engineering, see improvement roadmap).

### Connect (`/connect`), Messages (`/messages`)
- ✅ Notifications grouping, inquiries, follow lists, blocks; DMs with polling. Tabs are consistent with the app's tab pattern.

### Insights (`/insights`)
- ✅ Stat cards + area charts + tables; metrics labeled "Estimated" honestly.

### Settings (`/settings`), Collections (`/collections`)
- ✅ Recovery key, privacy, export job, deletion, audit log viewer; collections CRUD.

### Public profile (`/u/<username>`, `desktop-1440-public-profile.png`)
- ✅ Banner/avatar, stats dialogs, follow/message/inquiry dialogs, posts grid.

### Static pages (`/privacy`, `/terms`)
- ✅ Self-labeled "Beta draft" badge — honest; content review required before launch (P2 content task).

## 4. Cross-cutting findings (P0–P3 summary)

| ID | P | Finding | Evidence |
|---|---|---|---|
| UI-0 | **P0** | Upload-driven flows are broken end-to-end at HEAD (route deleted); any user attempting media upload on a local-disk deployment hits a failure toast | SYSTEM_AUDIT §1.1; 6 failing pinned tests; ensure-dev sentinel |
| UI-1 | P1 | Unbranded default Next 404 for direct path visits to hash-route screens (`/explore`, `/auth`, …) | browser-verified |
| UI-2 | P1 | Onboarding step-1 validation fails silently on invalid/empty display name | E2E executed |
| UI-3 | P1 | Upload UX offers no capability probe: buttons enabled even when the backend route is missing; failures arrive only as toasts | code + browser |
| UI-4 | P1 | No skip-to-content link; no route-change focus management in the SPA shell | code inspection (`SiteShell.tsx`) |
| UI-5 | P1 | Dead light-theme tokens + vestigial `tailwind.config.ts` present — a maintainer hazard (two competing token sources) | `globals.css`, `tailwind.config.ts` |
| UI-6 | P2 | Hero copy orphan wrap at desktop widths | screenshot |
| UI-7 | P3 | Guest post-panel redundancy with hero CTA | screenshot |
| UI-8 | P3 | (reclassified — no defect found at auth header) | — |
| UI-9 | P2 | GIFTZ mobile toolbar density | screenshot |
| UI-10 | P3 | Intelligence zero-state guidance minimal | code |
| UI-11 | P2 | 4 orphaned views (4,788 LOC) + 23 unused ui primitives + 6 orphaned bean components ship in the bundle scope | code inventory |
| UI-12 | P2 | LaxiiStudio monolith (1,982 LOC) — split risk | code |
| UI-13 | P2 | Profile/project image handling: only one `next/image` usage (`MediaThumb`); most media renders raw `<img>` — perf opportunity | code |
| UI-14 | P2 | Typography one-offs (`text-[2.75rem]`, `text-[10px]`) bypass the scale | code |
| UI-15 | P3 | Decorative-vs-informative `alt` policy inconsistent in a few spots | code sample |
| UI-16 | P3 | Focus indicator reliance on Tailwind ring utilities; programmatic focus check showed `outline:none` + `box-shadow:none` on one header button — needs manual keyboard verification (cannot conclusively verify :focus-visible via automation) | browser probe |
| UI-17 | P3 | Mobile bottom-bar labels small at 390px (7 items) | screenshot |
| UI-18 | P3 | WebsiteBuilder canvas keyboard parity limited (pointer-heavy interactions) | code |

**Counts: P0 ×1 · P1 ×5 · P2 ×9 · P3 ×6** (UI-8 reclassified; final issue list maintained in `BEAN_UI_IMPROVEMENT_ROADMAP.md`).

## 5. Competitive research (references, not templates)

Studied patterns from Behance (project-card density, cover-first grids), Dribbble (shot-first, tag navigation), Contra (service-first profile framing), Fueler (proof-of-work bundles), Framer/Webflow (visual editor UX: panel rails, device stage — BEAN's GIFTZ studio already mirrors these conventions closely), GitHub profiles (contribution graph — the M4 Workgraph's natural reference), LinkedIn (experience/timeline structure).

**Differentiation opportunity verified in-code:** BEAN's "evidence-first" identity is unique among these references — no studied competitor presents per-project evidence verification levels. The GIFTZ editor's honest compiling states and template previews already meet Framer/Webflow-class polish (screenshot-verified).

## 6. Limitations of this audit

- 3 authenticated surfaces were verified in code and via API tests but not independently browser-driven this pass (ModerationView requires an ADMIN fixture account; project-editor sub-dialogs require seeded media; LAXII image generation requires a configured provider). Documented rather than assumed.
- Automated focus-visible probing is heuristic; keyboard/AT testing flagged for manual follow-up (UI-16).
- Screenshots are committed under `docs/audit-screenshots/` as audit evidence.

## 7. Final confirmation (executed)

1. `git status` — only `docs/` additions present; no application source, styling, asset, route, or dependency changes.
2. No styling files modified; no packages installed; no existing functionality changed.
3. Files created by this audit: the 12 audit documents + `docs/audit-screenshots/*` only.
