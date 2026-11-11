<!-- ⚠️ HISTORICAL FEATURE DOC: the Portfolio Studio stack (portfolio-schema/kit/views + /api/portfolio/*) was removed from the codebase as dead, unreachable legacy code (the live website builder uses SiteDesign + src/components/bean/site/*). Kept for design reference only. -->

# Portfolio Studio (RETIRED SYSTEM — superseded by Website Studio / SiteDesign)

Every BEAN Folio account can compose a standalone, publishable portfolio
website from their **real** profile and project data — no code required, with
a safe advanced layer for custom CSS and JSON configuration.

Public URL: `#/site/<slug>` (slug defaults to the username, editable in the
studio). Case studies: `#/site/<slug>/work/<projectId>`.

## Architecture at a glance

| Piece | Where | Notes |
|---|---|---|
| Config schema (single source of truth) | `src/lib/portfolio-schema.ts` | zod-validated `PortfolioConfig`: theme, layout, motion, hero, 13 section types, 22 widget types, advanced (custom CSS). Section/widget `data` blobs are validated per type. |
| Config bootstrap | `src/lib/portfolio-defaults.ts` | First studio visit seeds a config from the owner's real profile + published projects. Empty sections/widgets are created **hidden**. |
| CSS sanitizer/scoper | `src/lib/portfolio-css.ts` | Custom CSS is stripped (`@import`, `javascript:`/`data:` URLs, breakouts, binding) and scoped under `[data-pf]`; `html/body/:root` are rewritten to the portfolio root. |
| Theme engine | `src/components/bean/portfolio/theme.ts` | Maps config → `--pf-*` custom properties (colors, radius, type pairing, scale, width, spacing, shadows, glass). |
| Templates | `src/components/bean/portfolio/templates.ts` | 10 presets (Luxury Editorial, Cinematic Creator, Minimal Developer, Designer Case Study, Video Editor Reel, Photographer Gallery, Architect, Writer & Researcher, Product Designer, Personal Brand). A template presets theme/layout/motion only — **content is never touched**. |
| Renderer | `src/components/bean/portfolio/PortfolioRenderer.tsx` + `sections.tsx` + `widgets.tsx` | One renderer powers the public site, the case-study pages' chrome and the studio preview (`interactive=false` shows honest "empty" hints). |
| Studio | `src/views/PortfolioStudioView.tsx` | Tabs: Content / Design / Layout / Widgets / Advanced. Live preview, desktop/tablet/mobile preview, undo/redo (60 steps, keystroke coalescing), autosave (1.2 s debounce) with explicit status, publish, versions, JSON export/import, draft rebuild from profile. |
| Public site | `src/views/PortfolioSiteView.tsx` + `src/app/api/site/[slug]/route.ts` | Serves **only the published snapshot**. Unpublished → 404 for everyone except the owner (draft preview). |
| Case studies | `src/views/PortfolioCaseStudyView.tsx` | Editorial project page rendered inside the owner's theme; project data comes from the existing visibility-enforcing `GET /api/projects/:id`. |

## Preview architecture (why an iframe)

Tailwind breakpoints respond to the **viewport**, so a width-constrained div
cannot honestly simulate a phone. The studio therefore previews through a
same-origin iframe:

- `#/embed/draft/<slug>` — chrome-free site render of the owner's **draft**
  (`GET /api/site/<slug>?draft=1`, self-only). Refreshes after every autosave.
- `#/embed/site/<slug>` — chrome-free render of the published snapshot.

`#/embed/*` routes are public-class (no onboarding hijack) and render without
the app header/footer (bare mode in `page.tsx`).

## Persistence & ownership

- Tables: `Portfolio` (1:1 with user, holds `slug`, `templateId`, `draft`
  JSON, `published` JSON snapshot, `publishedAt`) and `PortfolioRevision`
  (last 20 publish snapshots).
- Every mutation is session-scoped — there is no portfolio-by-id path; you can
  only ever touch your own row. Slug changes validate `[a-z0-9-]{3,24}` and
  409 on collisions. Revisions restore is scoped by `portfolioId` (foreign ids
  404).
- Publishing snapshots the draft verbatim; the live site never renders a
  half-saved draft. "Restore" copies a snapshot back into the **draft** (never
  straight to live).

## Content integrity rules

- Stats, services, experience, testimonials and writing are **user-provided**;
  the system never fabricates them. Empty sections/widgets are invisible to
  visitors and (in the studio preview only) shown as dashed
  "hidden from visitors" hints.
- Projects referenced by the site are the owner's `PUBLISHED` + `PUBLIC`
  projects only. Unlisted/private projects can be picked in the studio
  (marked "unlisted — hidden on public site") but are filtered server-side
  from the public payload. Case studies inherit the strict
  `GET /api/projects/:id` visibility ladder (drafts 404, private 404, unlisted
  by direct link).
- The contact section posts to the existing `POST /api/inquiries` flow
  (recipient's BEAN inbox; signed-out visitors get an honest sign-in prompt).

## Advanced mode

- **Custom CSS** (8,000 char cap): see sanitizer above. Output is injected as
  `textContent` of a `<style>` inside the portfolio root — no HTML parsing,
  no escape hatch to the app shell (verified: `body{background:…}` cannot
  restyle BEAN Folio around it).
- **JSON export/import**: `GET /api/portfolio/export` (download) and
  `POST /api/portfolio/import` (replaces the draft, re-ids sections/widgets,
  never publishes). The exported wrapper is `{ kind: "beanfolio-portfolio",
  version, slug, templateId, config }`.

## SEO — implemented vs. deferred (honest split)

Implemented client-side per portfolio:
- document `title` + meta description; `noindex` for draft previews and
  non-public case studies;
- JSON-LD `ProfilePage`/`Person` built **only** from published fields;
- lazy media, fixed dimensions (aspect classes), fast first paint.

Deferred until the app gains server-rendered routes (the sandbox serves the
whole product from a single `/` page with hash routing — hash fragments are
not separately crawlable): real `/:slug` SSR routes, `sitemap.xml`,
per-portfolio Open Graph image generation, canonical URLs. The data model
(`slug`, published snapshot) is already the shape those routes need; see
`docs/deployment.md` for the path.

## Widget catalog (22)

techStack, githubRepos (manual entries — nothing is fetched on the owner's
behalf), featuredVideo, imageGallery (lightbox), audioPlayer,
projectTimeline, experienceTimeline, achievements, resumeDownload,
socialLinks, availability (fed from profile), testimonials, writingFeed,
currentProgress, faq, linkButtons, stats, ctaBanner, codeShowcase,
beforeAfter (drag comparator), comparison (two projects), demoPreview.

Each widget supports: title, optional description, visibility, width
(full/half), "insert after section" positioning, and per-type editors.

---

# Multi-page sites, the 3-column studio, Code Giftz AI (v2 upgrade)

## Config v2 — pages

The portfolio config is now a **multi-page site** (`version: 2`). Every page
owns its hero (rendered on the home page only), sections and widgets;
theme/layout/motion/custom-CSS stay site-wide. Rules enforced by
`parseConfig` (schema is the single source of truth):

- exactly one home page (always published; reachable at the bare `#/site/<slug>`);
- sub-page slugs: 3–24 chars `[a-z0-9-]`, unique, `work` reserved
  (case studies live at `#/site/<slug>/work/<projectId>`);
- per-page publication: a page with `isPublished: false` is stripped from the
  public payload **server-side** (its content never leaves the server for
  anonymous visitors) and deep links render the 404 page; the owner can still
  preview it;
- per-page SEO: `seoTitle` / `seoDescription` override the tab title,
  meta description and Open Graph tags;
- v1 configs (hero + sections at the top level) are migrated transparently on
  read by `migrateConfig` — one "Home" page — and stored as v2 on the next save.

Public URL map: `#/site/<slug>` (home) · `#/site/<slug>/<page>` (sub-page) ·
`#/site/<slug>/work/<projectId>` (case study) · `#/site/<slug>/<bogus>` → 404.

## Studio workspace (redesigned)

Three-pane builder (Framer/Webflow-style, BEAN identity kept):

- **Left** — pages (add / rename / reorder / duplicate / delete, per-page
  nav + publication toggles) and the selected page's structure: sections and
  widgets with drag-and-drop reordering (HTML5 DnD + move up/down buttons as
  the keyboard-accessible alternative), hide/show, duplicate, remove.
- **Center** — the live preview iframe (same-origin `#/embed/draft/...`),
  desktop/tablet/mobile widths. **Click any block to select it**; **double-click
  hero name/title/intro or a section heading to edit that text inline**
  (contentEditable syncs back into the draft + autosave).
- **Right** — the inspector: hero editor, per-section editors, per-widget
  editors, page settings (name/slug/nav/public/SEO) or the site-wide design
  controls (template, colors, typography, surfaces, layout, motion, custom CSS,
  export/import/rebuild) when nothing is selected.
- **Toolbar** — template, undo/redo (Ctrl+Z / Ctrl+Shift+Z, 60 steps,
  keystroke-coalesced), save status, device selector, **Code Giftz AI**,
  versions, view site, save, publish.

Mobile/tablet: the panes become drawers ("Structure" / "Design"); the preview
stays full-width. Nothing is forced into three columns.

## Code Giftz AI — website designer

`POST /api/ai/design` (server-side only, behind the same consent + 6/min +
30/day gates as the rest of BEAN Intelligence): reads the user's own draft +
profile + project list, and asks the configured model for a **structured
proposal** (`summary`, `rationale`, `changes[]`) using a closed op vocabulary
(setTheme/setLayout/setMotion/setHero, add/update/remove/reorder sections,
add/update/remove widgets, page meta, addPage).

Safety pipeline, in order: JSON extraction → zod op validation → op-by-op
application into a clone (unknown ids skipped, generated ids never taken from
the model, section/widget data re-normalized against the type schemas, slug
rules re-checked) → full `parseConfig` validation of the candidate → only then
returned to the studio. The studio shows **Before/After previews** rendered
with the owner's real data; **Apply** writes the draft (undo-able, autosaved);
the published site is never touched until an explicit publish. Invalid model
output fails closed with a 502 and an honest message — nothing is applied.

## Code Giftz widget library (additions, 22 → 29)

New in v2: `codeSandbox` (live HTML/CSS/JS executed ONLY inside a sandboxed
iframe: `sandbox="allow-scripts"`, no same-origin, plus a `default-src 'none'`
CSP inside the srcdoc — no network, no cookies, no storage, no parent access),
`terminalDemo`, `codeCompare` (two highlighted panes with copy buttons),
`archDiagram`, `githubSummary` (numbers entered by the owner, labeled as
manual — never fetched), `embedCard` (screenshot + link; external pages are
never iframed), `readmePreview` (markdown-lite, links restricted to http(s)).
Code widgets gained copy-to-clipboard controls.

## Publishing confirmation

A successful publish opens a confirmation dialog with the **real public URL**
(`origin + path + #/site/<slug>`), a working copy-link action and an open
button. Republish snapshots a new version (kept in Versions, cap 20);
unpublish takes the site offline (public 404).
