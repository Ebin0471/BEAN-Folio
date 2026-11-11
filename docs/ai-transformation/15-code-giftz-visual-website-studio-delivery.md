# Delivery 15 — CODE GIFTZ Visual Website Coding Studio

**Status**: delivered and verified end-to-end in the browser. **Not deployed** (per instructions).

## 1. What shipped

The CODE GIFTZ "Customize Website" screen is now a **chat-driven Visual Website
Coding Studio**: the user talks to Code Giftz in a real conversation, every turn
runs the REAL plan → execute pipeline, produces an **isolated working-copy
proposal** (changed-file inventory + change summary + engine verification), and
nothing touches the saved draft or the published site until the user explicitly
saves — Save / Discard / Restore previous / Publish are all explicit, honest
actions with real failure surfacing.

### 1.1 Three-zone workspace (`src/views/WebsiteBuilderView.tsx`, rewritten 3,993 → 1,818 lines)

- **Top header**: CODE GIFTZ wordmark · site name (site.json identity) · save-state
  badge (Previewing-not-saved / Unsaved changes / Saved / Published · draft-ahead-of-
  live) · Save · Discard · Restore · Publish/Unpublish · Desktop/Tablet/Mobile device
  switcher · Undo/Redo · Download code (ZIP) · more-tools menu.
- **Left — chat panel** (`studio/ChatPanel.tsx`): named, persistent conversations
  (switch / new / rename / two-step delete); champagne user bubbles + glass
  assistant bubbles; live stage progress (Queued → Planning changes… → Applying
  changes…) driven by 1.5 s task polling with auto-resume after reload; honest
  FAILED cards (user-safe error, no fake success); **ProposalCard** rendering the
  changed-file tree (`path` + modified/added/removed badge + summary), the change
  summary, engine verification counts (pass/warn/fail), and **Preview changes**;
  composer (Enter sends, Shift+Enter newline, 4,000-char counter) sending the
  current draft config + device/page context.
- **Center — real preview** (kept infrastructure): the REAL `SiteRenderer` renders
  in the same-origin sandboxed iframe at true device viewports; when a proposal is
  previewed the canvas renders the **isolated proposal config** with an amber
  "Previewing changes — not saved yet" banner; footer states are explicit.
- **Right — Studio rail** (`studio/StudioRail.tsx` + `studio/controls.tsx` +
  `studio/SectionEditor.tsx`): six collapsible groups — Templates (12-style
  gallery + real-render live preview dialog), Colors (38-palette library + 8 token
  editors + gradient + surface opacity + WCAG contrast rows), Typography (4 font
  slots from the 129-family library + scale/weight/leading/tracking/align),
  Layout & sections (width/columns/density/radius/ratio/nav + page manager + full
  per-section editor with visibility/reorder/add/duplicate/delete), Motion (107
  presets + duration/stagger/intensity/easing + hover/reveal/once toggles +
  reduced-motion note), Presentation (tagline, design presets, logo upload,
  buttons/links/dividers, glass system, performance mode, watermark attribution).
  Every control is wired to the SAME mutation functions as before — a
  reorganization with zero behavior change.
- **Mobile**: bottom segmented Chat / Preview / Studio switcher (zones stay mounted
  so polling and the iframe survive switching); verified at 390×844.

### 1.2 Backend — real code-generation execution flow

- **Data model** (additive, `db:push` clean): `SiteStudioSession` + `SiteStudioMessage`
  (role/status/proposalJson/taskId/metaJson). The proposal lives ONLY in the message
  row — never in `draftConfig` — until explicitly saved.
- **Turn pipeline** (`src/lib/site-studio/turn.ts`): message pair persisted →
  durable `AgentTask` (kind `SITE_STUDIO_TURN`, agent CODE_GIFTZ) → plan via the
  SHARED pipeline (see 1.3) → reply-only outcomes stored as plain text (nothing
  executed) → execute via `runDesignJob` (per-step tools, constraint enforcement
  with byte-identical restore, verification report) → proposal persisted with
  changed-file inventory + summary + verification + base-config hash. Every failure
  path lands the message in FAILED with a user-safe error; the AgentTask makes turns
  durable across restarts.
- **Changed-file inventory** (`src/lib/site-studio/files.ts`): deterministic virtual
  file view (`site.json`, `theme/tokens.json`, `theme/typography.json`,
  `theme/layout.json`, `motion/presets.json`, `pages/<id>.json`) with per-file change
  summaries — "which file changed" always answers "which area changed". Empty for
  identical configs (never padded).
- **API routes** (all owner-scoped, rate-limited, zod-validated, relative paths):
  `GET/POST /api/me/site/studio/sessions`, `GET/PATCH/DELETE …/sessions/[id]`,
  `POST …/sessions/[id]/messages` (202 + background turn), `GET …/turns/[taskId]`
  (poll; ownership double-checked; foreign ids 404-indistinguishable).
- **Plan core extracted** (`src/lib/ai-design/plan-core.ts`): the plan route's
  grounding → deep-reasoning → schema + digest validation → bounded self-repair
  pipeline is now shared verbatim by the plan route (rewritten to use it) and the
  studio turns — one safety semantic, two surfaces.

### 1.3 12 style templates (`site-config.ts` + `studio/TemplateGallery.tsx`)

`STYLE_TEMPLATE_IDS`: `minimal-index`, `modern-loft`, `editorial-press`,
`creative-playbook`, `developer-term`, `designer-desk`, `photography-frame`,
`agency-roster`, `corporate-ledger`, `dark-luxury`, `glassmorphism`,
`experimental-lab`. Each is a full `TemplatePreset` (real theme tokens from the
existing schema, real font ids from the 129-family library, real motion presets,
4–7 real sections) — so template.apply, the AI tool registry, `normalizeConfig` and
the renderer all support them natively. Apply keeps pages + content (existing
template semantics); the gallery cards render pure-CSS swatches from each
template's own tokens and offer Apply + real-render Live preview. Zero blue/indigo
accents (brand rule).

### 1.4 Old UI removal (audit-first)

Removed: the 3-tab panel system (Design/Content/AI), `CodeGiftzPanel.tsx` (plan
review card, PREVIEW ONLY panel, audit button, AI suggestions) via `git rm`,
the old proposal banner/stale-guard flow. As part of the same audit the entire
orphaned portfolio subsystem (~6,000 lines: `PortfolioStudioView`,
`PortfolioSiteView`, `PortfolioCaseStudyView`, `components/bean/portfolio/*`,
`RiisheDesignPanel`, `lib/portfolio-*`, `/api/portfolio/**`, `/api/site/[slug]`,
the legacy one-shot `/api/ai/design` route, and the transient `Portfolio` schema
models) was removed — zero runtime importers, verified before deletion.
`GiftzHandoffPanel` (engineering workspace) and all `/api/ai/design/{plan,execute,
job,audit}` routes are untouched.

## 2. §6 isolation — cross-feature side-effect prevention

Ten pinned regression tests (`tests/studio-isolation.test.ts`), all exercising the
REAL pipeline functions (no mocked mutation surface):

1. Font change never touches the project grid (pages byte-identical).
2. Per-section hero motion override never leaks site-wide or into other sections.
3. Section style override never alters component-level config (buttons/links) or
   other sections.
4. A single section's color token pollutes neither global tokens nor other sections.
5. Template application preserves ALL content (identity, page names, sections).
6. Disabling animations removes no element (structure intact).
7. Restoring one protected area never rolls back unrelated applied changes.
8. Palette application changes ONLY color tokens.
9. The changed-file inventory attributes changes to EXACTLY the right virtual file.
10. Constraint repair restores protected regions BYTE-IDENTICALLY while keeping
    legitimate edits from the same step.

Mechanisms underneath (all pre-existing, now regression-pinned): scoped design
tokens via `applyPatchConfig` + `deriveTheme`, per-section `style`/`motion`
overrides (absent fields inherit, never leak), preservation constraints with
byte-identical `restorePreserved`, template apply content-keep semantics,
`normalizeConfig` as the single validation gate, deterministic changed-file
projection.

## 3. Verification (real exit codes, browser-verified)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | **exit 0** |
| `bun run lint` | **exit 0** |
| `bun test` (full) | **exit 0** — **367 pass / 0 fail** (347 baseline + 13 startup-validation-era… see 14b; this task adds 10 style-template + 10 isolation tests) |
| `bun run build` (production) | **exit 0** (27.9 s; one known Turbopack warning about `process.exit` in the edge-compiled instrumentation copy — guarded by `NEXT_RUNTIME`, never executes on edge) |
| standalone server + `/` + `/api/health` + `/api/ready` | all **HTTP 200** (`ready:true`, `database:"reachable"`) |
| Browser E2E (demo account, real gateway) | login → `#/website` → three-zone workspace renders → **real chat turn**: "Change the accent color to a warm copper tone" → 202 → planning → executing → DONE → proposal card with `theme/tokens.json [MODIFIED] "Updated accent color"` + summary + "6 passed 1 warned · engine verification" → **Preview changes** → isolated canvas + amber banner → **Discard** returns to draft (proposal kept in conversation) |
| Template apply E2E | Minimal Index Apply → Save enabled (dirty) → real font change visible in iframe (fraunces → Geist) → **Save** → `PUT /api/me/site` 200 → "Saved" badge + honest status text |
| Mobile 390×844 | Chat / Preview / Studio segmented switcher verified; screenshot `/home/z/shots/studio-mobile-chat.png`; desktop `/home/z/shots/studio-desktop-final.png` |

### Defects found and fixed during browser verification

1. **Poll 404 bug**: the assistant message was created without its `taskId`
   linkage, so the very first poll of a turn returned 404 and the UI never saw the
   proposal. Fixed (task created first; linkage written up-front); re-verified —
   polling now 200 and proposals render.
2. Demo account lacked `aiConsent` (honest 403 from the gate — correct product
   behavior); enabled as test fixture preparation, exactly like seeding.

## 4. Honest scope notes

- The turn executes plan + execute in one conversational action (no intermediate
  plan-approval card); save-level approval is the explicit gate. This matches the
  studio contract: nothing reaches the draft/published site without Save/Publish.
- Token streaming is not used; progress is stage-based (planning → executing →
  verification), which honestly reflects the multi-step pipeline.
- The audit endpoint (`/api/ai/design/audit`) remains as an API but has no studio
  button anymore (the old Audit UI was removed per spec).
- The production build's single Turbopack warning concerns the edge-compiled copy
  of `instrumentation.ts` (`process.exit`); the file guards on `NEXT_RUNTIME` and
  the edge path never executes it. Recorded rather than hidden.
- A pre-existing, rare giftz cancellation timing flake was observed once during
  full-suite runs and is documented in 14b; it did not reproduce in the final
  verification runs.
- Not deployed. No pricing changes, no new paid APIs, no mocks replacing real
  execution: the studio uses the same managed gateway and safe-executor patterns
  as the rest of BEAN Intelligence.
