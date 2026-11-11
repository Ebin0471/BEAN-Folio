# Delivery 16 — Two-Mode Website Studio: Customization + CODE GIFTZ

**Status:** implemented and verified in this session. **Not deployed.**
**Task:** restructure the Website Studio (`#/giftz`) into exactly two top-level tabs —
**Customization** (free visual customization) and **CODE GIFTZ** (AI coding
workspace) — operating on the same portfolio website, without payment
integrations, without an Engineering tab, and without combining the two
editing experiences.

---

## 1. Two-tab architecture

| Aspect | Implementation |
|---|---|
| Tab bar | Header `role="tablist"` "Website Studio modes" with exactly two tabs: `Customization` and `CODE GIFTZ` (`STUDIO_MODES`, WebsiteBuilderView). Gold-soft active state; the app's established two-tab visual pattern (bordered pill group, champagne-gold active). |
| Modes | `StudioMode = "customization" \| "giftz"`; default `customization`. |
| Customization tab | Live preview (center) + full studio rail (right): Templates, Color systems, Colors & gradients, Typography, Layout & sections, Motion, Presentation. **No chat anywhere in this mode.** Element-click selection is enabled only here. |
| CODE GIFTZ tab | Chat panel (left) + live preview (center). **No preset library, no template gallery, no repository/engineering UI.** |
| State preservation | Both side panels stay **mounted** and are CSS-hidden on switch (`lg:flex/lg:hidden` + mobile zone gating). The draft `config` is owned by the single `WebsiteBuilderView` component, so switching tabs cannot lose unsaved changes; the ChatPanel keeps its session, messages, composer draft and in-flight turn polling across switches. |
| Mobile | Zone tabs adapt per mode: Customization → `Preview | Studio`; CODE GIFTZ → `Chat | Preview`. `switchMode()` lands the zone on a valid tab (`preview`) when crossing modes. |
| Preview sharing | One `DeviceStage`/`PreviewFrame` canvas instance serves both modes — the real `SiteRenderer` re-renders through the existing React root; the iframe is never reloaded for small edits. Proposal isolation banner renders in both modes. |
| Legacy routes | `#/giftz` is the single canonical studio route; `#/giftz/website` and `#/website` remain honest replace-redirects to `#/giftz` (Delivery 44/Task-44 routing unchanged). |

## 2. Customization tab — what ships (existing + new)

Much of §2 was delivered by Delivery 15 (visual studio) and is **verified**, not
re-implemented, here. This task's additions are marked **NEW**.

### 2.1 Template & preset library — 14 style templates

`STYLE_TEMPLATE_IDS` (site-config.ts) now lists **14** gallery genres: Minimal
Index, Modern Loft, Editorial Press, Creative Playbook, Developer Terminal,
Designer Desk, Photography Frame, Agency Roster, Corporate Ledger, Dark
Luxury, Glassmorphism, Experimental Lab, **Portfolio Showcase (NEW)**,
**Interactive (NEW)** (plus 3 classic + 13 profession templates registered for
template semantics — 28 presets total).

- **Portfolio Showcase** — wide 16:9 frames, `media-cinema-open` reveals,
  featured projects + masonry gallery + testimonials; Fraunces/Geist Sans on
  graphite with champagne accent.
- **Interactive** — `stagger-scale` + `hover-tilt` micro-interactions +
  `bg-aurora-soft` animated background, pill buttons, rise page transition,
  centered headings; Bricolage Grotesque/Outfit on obsidian with coral/green.

**Preset sources & licenses.** No third-party template code or assets were
copied. The presets are original BEAN Folio configuration objects (colors,
type pairings, section layouts) authored against BEAN's design system;
quality references were the patterns used by permissively-licensed open
projects (Tailwind CSS typography scales — MIT; shadcn/ui theme token
structure — MIT; Google Fonts families — OFL/Apache). Every font is a real
Google Fonts family; nothing is embedded from a non-redistributable source.

**Per-preset requirements** (TemplateGallery):
- Actual visual preview — `TemplateSwatch` renders the preset's own resolved
  tokens (background/gradient, masthead, nav, headline bars, cards, radius,
  columns, glass).
- Name + description on every card.
- **Desktop and mobile preview (NEW)** — the live-preview dialog now carries
  its own Desktop/Tablet/Mobile toggle; each renders the **real SiteRenderer**
  with the user's content at the real device width (`templatePreviewDevice`,
  independent of the header device switcher).
- Apply — `applyTemplate` (pristine first-run adopts full layout; otherwise
  swaps theme+motion and **always keeps pages/sections/content**).
- Live preview action — real render dialog (above).
- **Revert (NEW)** — applied card gains a `Revert` action =
  `resetToTemplateDefaults` scoped to that template (theme+motion back to the
  template's defaults; glass/surfaceOpacity and all content preserved).

### 2.2 Typography

Verified existing: 129 real families in 11 categories (Editorial serif,
Modern sans, Geometric sans, Grotesk, Display, Monospace, Elegant luxury,
Minimal, Creative & experimental, Script, Multilingual); 3 bundled via
next/font, 126 loaded on-demand per-family from Google Fonts (idempotent
injection into the rendering document incl. the preview iframe); type scale
(3-step responsive ladder), heading weight, line height, letter spacing,
heading alignment.

**NEW — navigation and button font roles.** `navFont` / `buttonFont` joined
`headingFont/bodyFont/accentFont/codeFont` as fully independent theme roles:
schema + `deriveTheme` resolution (absent ⇒ body font, so nothing changes for
existing sites), `themeFontStacks.nav/.button`, renderer consumption
(masthead nav links + every `.bs-btn` via `buttonStyle`), real font loading
in `useSiteFonts`, and two new `FontSelect`s in the rail's Typography group
("Navigation font", "Button font").

### 2.3 Colors and themes

Verified existing: 8 color inputs (background/cards/text/secondary
text/accent/accent2/borders/focus ring), background gradient (toggle +
from/to/angle), card surface opacity, 38 pro palettes in 7 categories
(one-shot token overlay — colors only), live WCAG contrast rows with
one-click Fix. Custom color selection via native pickers throughout.

### 2.4 Layout and sections

Verified existing: density, content width, grid columns, corner radius,
image ratio, nav layout, page transition, dividers (site-wide); pages CRUD;
section ordering (move up/down), visibility, add/duplicate/remove; per-type
layout variants (projects grid/featured/list/editorial, services cards/rows,
gallery masonry/grid/strip, experience timeline/rows, testimonials cards/stack).

**NEW — per-section style band.** `section.style` gained `background`
(`none | surface | wash | <hex>` — full-bleed band that escapes the content
column while the content keeps its position), `width` (narrow/regular/wide),
`spacing` (compact/regular/relaxed) and `headingAlign` (left/center) — all
scoped strictly to the selected section via the renderer's `SectionBand`
wrapper (absent overrides render a passthrough with zero layout change).
Exposed in the SectionEditor ("Style for this section" grid). Section
backgrounds therefore exist per-section, satisfying the §2.6 isolation
example directly.

### 2.5 Animations

Verified existing: 107 reveal/hover/background motion presets in 8 categories
(fade/slide/scale families, scroll reveals via IntersectionObserver, staggered
cards/grids, text reveal incl. word/char split, image reveal incl. clip masks,
ken-burns and parallax, 14 nav/button hover micro-interactions, 12 animated
backgrounds, page transitions via `theme.pageTransition`); per-animation
duration (150–1200ms), stagger (0–240ms), intensity (0–100%), easing
(5 curves); per-section motion overrides (preset/duration/intensity/stagger/
disable with "Inherit site motion"); play-once vs replay; hover master
switch; **full `prefers-reduced-motion` support** (CSS kill-switch, JS
guards, failsafe visibility).

**NEW — Delay control (verification pass).** `motion.delay` (0–600ms, default
0) joined the schema, `normalizeMotion`, the renderer (`--bs-delay` on every
`Reveal` container) and the rail's Motion group (Slider). It sits ON TOP of
stagger (`transition-delay: calc(var(--bs-delay,0ms) + var(--bs-i,0) *
var(--bs-stag,60ms))`) — never instead of it — and survives per-section
motion overrides (`sectionMotion` spreads site-wide motion). Out-of-range
values are rejected by the schema (fail-closed, same as duration/stagger).
Trigger = the existing Scroll-reveals switch + Play-once toggle; direction =
the directional preset families; both already had controls.

### 2.6 Control isolation

Architecture unchanged (scoped design tokens + section-level overrides +
component-level config with predictable precedence) and now regression-covered
for the new controls (see §7). The renderer's `SectionBand` and the font-role
split are per-target by construction; the AI pipeline's constraint system and
protected-region repair are untouched.

## 3. CODE GIFTZ tab — chat and coding workflow

The real site-studio pipeline is reused unchanged (no second chat
implementation, no mocks):

1. `POST /api/me/site/studio/sessions/[id]/messages` → durable `AgentTask`
   (`SITE_STUDIO_TURN`, agent `CODE_GIFTZ`) → plan via the BEAN Intelligence
   gateway (`ai-design/plan-core`) → execute (`runDesignJob`) → isolated
   working-copy proposal + changed-file inventory. Honest FAILED on every
   failure path.
2. Turn progress polls `GET /api/me/site/studio/turns/[taskId]` (1.5s).
   **Streaming is not supported by this pipeline** — progress is shown as
   staged status labels (Queued → planning → executing → verifying), which is
   the honest equivalent; no fake streaming was added.
3. Proposal card: changed files (path + action + summary), change summary,
   verification counts (passed/warned/failed · engine verification),
   **Preview changes**, and **Request changes (NEW)** — prefills and focuses
   the composer with a revision request grounded in that proposal's summary
   (revision = follow-up turn, the pipeline's real revision mechanism).
4. **Session continuity (NEW):** the panel reopens the most recent conversation
   once the session list arrives (run-once guard), so history continues across
   reloads and tab switches; a still-running turn resumes polling.
5. The gateway is the existing configured BEAN Intelligence gateway. No
   Ollama, no duplicate gateway, no new paid APIs.

Verified live this session (demo account): "Add a testimonials section with
the title 'What collaborators say' right after the projects section" →
reply + `pages/home.json` MODIFIED ("Home: 6 sections (was 5)") + 6 engine
verifications passed → isolated preview showed the new section between
"Index" and "About" → Request changes prefilled the composer → Discard
restored the draft exactly.

## 4. Actual preview implementation

Unchanged real-render architecture (no screenshots, no demo data):
`PreviewFrame` clones the app stylesheets into a same-origin iframe and mounts
the real `SiteRenderer` through a React root; `DeviceStage` scales visually
while keeping the true device viewport; desktop/tablet/mobile switcher in the
header (canvas) and now also inside the template preview dialog. Proposals
render as an isolated working copy; the canvas caption states honestly what is
being previewed (isolated proposal / unsaved draft / saved draft).

**NEW — Refresh, loading and error states (verification pass, §3.3).**
- **Reload preview** button above the canvas remounts the preview iframe
  (`refreshKey`) so fonts, animations and the whole render pipeline re-run
  from scratch.
- **Loading state** — a spinner overlay covers the canvas until the iframe's
  `onLoad` fires (also visible during manual reloads).
- **Error state** — a `PreviewErrorBoundary` inside the iframe's React root
  catches renderer failures: the canvas shows an honest "Preview hit a
  rendering error" panel (data-safe, retry = Reload preview), the caption
  repeats it, and the boundary self-resets when the config changes again.

## 5. Save / publish architecture

Unchanged and re-verified: `SaveControls` (Save / Discard / Restore / Publish
/ Unpublish) drive both modes from the shared draft; Save routes through
`PUT /api/me/site` so the server snapshots "Before save" revisions; Discard
(confirm dialog) reverts to the last saved version; Restore lists automatic
snapshots and is itself reversible; Publish requires the explicit review
dialog and never happens silently; unsaved/saved/published states are
distinct in the header; failures surface real errors (no phantom success).

## 6. Shared portfolio data handling

- One `SiteConfig` draft per user (server row `users.siteConfig` +
  `siteDesign`), rendered from the user's real profile/projects/collections.
  Both tabs mutate the same in-memory draft; there is exactly one website
  record and one portfolio identity.
- Cross-mode reflection: a save in either tab persists the same draft, so the
  other tab sees it (same state object live; a fresh mount refetches the
  server draft).
- Conflict handling: the chat proposal flow records the config fingerprint it
  was generated from; if the draft moved since, the preview banner states
  "Your draft changed since this proposal was generated — saving replaces
  those newer edits with what you see here." Server-side saves snapshot
  revisions, so overwrite is always recoverable via Restore.
- Ownership/authorization unchanged: all `/api/me/site/*` routes are
  session-owned; the studio is behind `RequireAuth label="Code Giftz"`.

## 7. Security, approval and preserved systems

RIISHE, LAXII (incl. the CODE GIFTZ ↔ LAXII handoff backend and the LAXII-side
integration dialog), the CODE GIFTZ secure execution modules (`src/lib/giftz/*`,
`/api/giftz/*`), task persistence, rollback, approval gates and Phase 3–7
controls are untouched. No payment/billing/subscription code exists anywhere
in this change. No existing check was weakened.

## 8. Tests and build evidence (this session, real exit codes)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | **exit 0** |
| `bun run lint` | **exit 0** |
| `bun test` | **exit 0 — 372 pass / 0 fail**, 24 files, 2,523 expects (367 baseline + 5 new) |
| Isolated production build (`bun run build` in a clean rsync copy) | **exit 0** |
| Standalone server boot | `/` → 200; `/api/ready` → `{"ok":true,"ready":true,...}` |
| New tests | `tests/style-templates.test.ts` pins 14 ids (order, uniqueness, schema-valid, fonts/motion ids real, no indigo/blue); `tests/studio-isolation.test.ts` +5: font-role isolation (heading change never touches nav/button; one role never touches another), per-section band scoping (background/width/spacing/headingAlign never leak to siblings), custom hex round-trip, new templates schema-valid + content-complete |

**Independent re-verification after the follow-up pass (delay + preview
states + mobile overflow fix), same session:** `bunx tsc --noEmit` exit 0 ·
`bun run lint` exit 0 · `bun test` exit 0 — **375 pass / 0 fail**, 24 files,
2,534 expects (372 + 3 new delay tests in `tests/audit-regressions.test.ts`:
schema default/fail-closed bounds, CSS plumbing on top of stagger,
site-wide delay surviving per-section overrides) · isolated production build
**exit 0** (✓ Compiled 31.4s; sole warning = the documented benign
edge-compiled instrumentation `process.exit` note) · standalone server:
`/` 200, `/api/ready` ok + `startup.env_validated`.

Browser E2E (demo account, real APIs, desktop 1440 + mobile 390):

- Two tabs render; default Customization; switching preserves an unsaved
  change (heading alignment Centered → CODE GIFTZ → back → still Centered).
- Customization: 14 template cards; Portfolio Showcase live preview at
  Mobile toggle (real render) → Apply ("your pages and content were kept") →
  Revert ("Reset to Portfolio Showcase defaults — your content was kept");
  per-section Background=Accent wash applied to the hero only; new section
  controls (width/spacing/alignment/background) render in SectionEditor.
- CODE GIFTZ: chat auto-opens the last session; real turn added a
  testimonials section (`pages/home.json` MODIFIED, 6 sections was 5, 6
  checks passed); isolated preview rendered it in the right position;
  Request changes prefilled the composer; banner Discard restored the draft.
- Mobile: Customization shows Preview|Studio zones, CODE GIFTZ shows
  Chat|Preview; mode tabs wrap cleanly under the wordmark; shell bottom nav
  unaffected.
- A React key warning introduced by the `SectionBand` wrapper was caught by
  this E2E pass and fixed (band is keyed); console clean after reload.

**Second E2E pass (follow-up controls, real browser, demo account):**
- All 14 template categories verified in the gallery (Minimal Index →
  Interactive, incl. Portfolio Showcase + Interactive); no chat panel in
  Customization mode; no rail/templates in CODE GIFTZ mode.
- Tab-switch preservation round-trip: unsaved name change + composer draft
  text both survived Customization → CODE GIFTZ → Customization → CODE GIFTZ;
  Unsaved-changes badge stayed correct throughout; auto-reopened session and
  in-flight turn polling survive switches (panels stay mounted).
- Reload preview: click remounts the iframe and the real site re-renders
  (Maya Okonkwo content back on screen). Loading overlay present in the DOM
  path (too fast to observe on localhost).
- Delay slider: End key → "Delay · 600 ms"; live preview elements picked up
  `--bs-delay: 600ms` inline (verified in the iframe DOM); Home key reset to 0.
- Real chat turn: "Change the site tagline to exactly 'Two modes, one
  studio.'" → reply + proposal card (`site.json` MODIFIED, "Updated
  tagline.", verification results) → Preview changes → isolated banner →
  Discard restored the draft exactly.
- **Mobile overflow fix caught live:** the new Reload-preview toolbar made
  the canvas column overflow the fixed-height workspace at 390 px; the
  transform-scaled iframe painted OVER the static zone tabs (hit-testing
  blocked — Playwright reported `div.bean-site` covering the click). Fixed
  (stage may shrink below its desktop minHeight on <md; zone nav gained a
  stacking guarantee `relative z-10`) and re-verified: Chat/Preview/Studio
  zone tabs clickable in both modes at 390 px, zero overlap.

## 9. Known limitations

- Chat responses are not token-streamed (the durable turn pipeline reports
  staged progress instead); the POST endpoint returns 202 + taskId by design.
- Typography "font size" is the 3-step responsive type-scale ladder (plus
  heading weight/line-height/tracking), not a free numeric px control;
  text alignment exists for headings (site-wide + per-section), not body copy.
- Per-section layout "grid" is expressed through the per-type `layout`
  variants + site-wide column count; there is no per-section arbitrary
  column-picker.
- Template mini-swatch previews are stylized token renders; the truthful
  "actual visual preview" is the Live preview dialog (real renderer, real
  content, device toggle).
- The 126 CDN fonts load lazily on first selection; a very cold first render
  of an exotic family can fall back for a moment until the css2 link resolves
  (idempotent, per-family, silent-fallback by design).
- No payment integration exists (per task): both tabs are fully usable
  without any billing gate.
