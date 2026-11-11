# Delivery 17 — CODE GIFTZ & Customization: Six UI and Functionality Fixes

**Status:** implemented and verified in this session. **Not deployed.**
**Task:** six corrections to the Website Studio (`#/giftz`) — plan-schema
reliability, independent per-mode settings, left-side content editing,
templates-only Templates panel, a generated-website-only CODE GIFTZ preview,
and a fixed chat composer with independent conversation scrolling.

---

## 1. Root cause of the plan-schema error

**Error:** "The plan did not match Code Giftz's plan schema. Try rephrasing the
request." — thrown by `planDesignChange` (`src/lib/ai-design/plan-core.ts`) the
moment `designPlanSchema.safeParse` failed.

**Root cause (audited, four layers):**

1. **Diagnostics discarded.** The Zod issue list was thrown away; the user got
   a generic dead end with no repair, no retry and no reportable cause.
2. **Representation brittleness.** The strict schema is deliberately
   unforgiving, and models keep writing *representationally* different but
   semantically identical plans: `notes: null` / `constraints: null` (nulls
   fail `.optional()`), `targets: "hero"` instead of `["hero"]`,
   `kind: "Design"` / `risk: "none"` (invalid enums), `steps` as a single
   object, unknown keys inside the `.strict()` patch
   (`{"colors": {...}}`), non-hex colors (`"gold"`), and titles/summaries
   under 3 chars. Any ONE of these failed the whole plan.
3. **Planner ↔ schema ↔ executor mismatches.** `navFont`/`buttonFont` are real
   `SiteTheme` tokens the executor happily applies, but the patch schema and
   the planner prompt did not list them; `motion.delay` (a real motionSchema
   token, 0–600 ms) was missing from the patch schema and prompt. A model
   targeting them got an unavoidable schema rejection.
4. **No repair loop at the schema layer.** Constraint-level self-repair
   existed; schema-level repair did not.

**Fix (defense in depth — nothing weakened):**

- **`normalizePlanJson`** (`src/lib/ai-design/plan.ts`, pure): representation
  repair only — null→omitted for optional strings, single string→array,
  case-normalized enums (invalid dropped so schema defaults apply), steps
  object→array, junk entries dropped, missing id/title/summary synthesized
  from sibling fields, and a patch sanitizer that keeps ONLY keys the strict
  patch schemas define with valid shapes (hex-checked colors, ranged numbers,
  exact enums; flat keys fold via `coerceDesignPatch`; a patch reduced to
  nothing becomes absent, which validatePlan then reports precisely as
  "must carry a token patch"). The strict schema still validates everything
  that remains; tool membership, target existence, constraints and the
  executor's site-schema merge are enforced exactly as before.
- **`resolvePlanJson`** (`plan.ts`, pure): the FULL resolution pipeline
  (normalize → strict schema → digest validation → constraint self-repair)
  extracted so every attempt — first or repaired — runs the identical gates.
- **Bounded model repair (exactly one round)** (`plan-core.ts` +
  `planRepairPrompt` in `prompts.ts`): on a strict-schema rejection (or an
  unparseable answer), the model gets ONE repair call containing its own
  invalid JSON + the REAL validation errors + the exact contract. The repaired
  answer re-enters `resolvePlanJson` — approval gates never skipped. A second
  failure throws with the actual top schema issues quoted (never a bare
  "rephrase"). `PLAN_MAX_ATTEMPTS = 2` (1 plan + 1 repair), exported and
  tested. The completion function is injectable (`deps.complete`) for tests.
- **Schema/executor alignment:** `navFont`, `buttonFont` added to
  `themePatchSchema` + flat-key coercion + schemaDoc; `delay` added to
  `motionPatchSchema` + coercion + schemaDoc; sanitizer limits match the
  schema exactly (easing/background/microInteractions ≤ 40, preset ≤ 48).
- **Prompt contract hardened** (`planSystemPrompt`): explicit "reply/notes are
  strings, NEVER null; constraints/steps are arrays, NEVER null; kind ∈ …;
  risk ∈ …; targets/dependsOn are arrays" and the complete token-name
  whitelist for patches.

**Real-request verification (live gateway, demo account):** three real turns
passed end-to-end — a simple token edit ("Change the site tagline…", plan OK →
site.json modified, 6 checks passed), a two-step mixed request ("Add a services
section … and set the type scale to grand" → services items render, 7 checks
passed) and a large multi-file restyle ("dark editorial film-portfolio … grand
type scale … serif headings" → theme/tokens.json + theme/typography.json
modified, 7 checks passed, serif/grand rendering visible in the isolated
preview). No schema failure, no repair needed on any of them. Simple CSS
changes, section additions, component edits and multi-file modifications are
all covered by these three shapes; per the task's own bar, the claim is scoped
to what was actually run.

## 2. Independent settings architecture (Customization vs CODE GIFTZ)

New module `src/components/bean/site/studio/prefs.ts`:

- `bean:ws-prefs:customization` → `{ device }` (viewport of the site canvas).
- `bean:ws-prefs:giftz` → `{ device, autoPreview }` (viewport of the generated
  preview + auto-render of finished proposals; toggle lives in the CODE GIFTZ
  settings gear in the chat header).
- Separate keys, separate validators, SSR-safe reads, corruption-tolerant
  (invalid values fall back to defaults).

`WebsiteBuilderView` holds `customPrefs`/`giftzPrefs` + `customZone`
(`content|preview|studio`)/`giftzZone` (`chat|preview`). The header device
switcher reads/writes ONLY the active mode's prefs. Verified in-browser:
setting giftz=Mobile → customization still Desktop; setting customization=
Tablet → giftz storage unchanged; switching tabs restores each mode's own
state. Draft config and profile data stay SHARED (one portfolio identity —
never duplicated). Publish/save/approval semantics are workflow-level (they
govern the same draft) and deliberately NOT toggleable — no setting can
weaken an approval gate.

## 3. Content editor implementation (left side)

New component `src/components/bean/site/studio/ContentEditor.tsx`, rendered as
the Customization-mode LEFT panel (mobile: a new "Content" zone tab):

- **Website identity** — site title + tagline.
- **Section content (active page)** — per-section accordions with content-only
  fields for all 11 section types: heading, hero subheading + CTA label/link
  (buttons and links), about/contact bodies, services items
  (add/remove/edit), experience entries incl. education
  (add/remove/edit role/org/period/description), testimonials items
  (add/remove/edit, real-quotes-only hint), projects/collections/gallery
  headings + display limits + category filter, skills/stats pointers to the
  profile group.
- **Profile content** — professional headline, introduction/bio, location,
  availability, contact email, website, skills (chip add/remove) — saved via
  `PATCH /api/me/profile` with its own Save/Discard + validation; the editor
  seeds from the real profile (nothing invented) and re-keys on saved changes.
- Edits are direct draft mutations (same `updateSection`/`mutateConfig` the
  rail uses) → top-bar Save/Discard/undo apply; the panel states explicitly
  that these are content edits, separate from CODE GIFTZ's isolated code
  proposals. Changes render immediately in the site canvas. Verified live:
  hero heading edit → canvas update → Discard confirmation → exact revert;
  skill add → persisted via API → removed → original data restored.

## 4. Template panel separation

- `TemplateGallery` cards no longer surface the motion-preset id badge (the
  animation control that leaked into Templates). Each card now states:
  "Complete website design · structure, colors, typography, motion · works on
  desktop, tablet and mobile · your content is preserved".
- The Templates section now contains ONLY the 14 complete templates; the
  intro copy names fonts/animations/color systems as living in their own
  sections below. Those individual controls (129 fonts, 107+ motion presets,
  38 color systems, design presets) remain fully available in Typography,
  Motion, Colors & gradients, Color systems and Presentation.
- Apply / Live preview (real renderer, desktop+tablet+mobile dialog) /
  Revert behaviors unchanged and verified; `applyTemplate` keeps pages and
  content (portfolio preservation unchanged).

## 5. Generated-preview architecture (CODE GIFTZ)

- CODE GIFTZ's center workspace renders **ONLY** the isolated proposal
  (`proposalPreview`). With no generation, it shows an honest empty state —
  "No website generated yet … Your saved website is not shown here" + an
  Open Chat action — and **zero** site iframes are mounted (verified), so the
  saved portfolio can never appear as a fake generated result.
- **Auto-preview**: when a turn completes with a proposal, the generated
  website renders automatically (the CODE GIFTZ `autoPreview` setting, default
  on); a user-initiated "Preview changes" also jumps the mobile zone to
  Preview, an auto-preview does not (mobile users stay in Chat).
- Device previews (desktop/tablet/mobile), Reload preview, loading and
  render-error states reuse the existing `DeviceStage`/`PreviewFrame`
  components unchanged.
- Generate → Preview → **Save draft** (server snapshots "Before save") →
  Discard → Restore (revisions dialog) → Publish (explicit confirmation
  dialog) remain separate operations; publishing still requires explicit
  approval and the proposal banner never disappears silently. Verified live:
  generate → auto-preview with amber "not saved" banner → Discard → back to
  the empty state with the draft untouched.

## 6. Chat scrolling implementation

`ChatPanel` now enforces a hard flex contract: header and composer are
non-shrinking rows (`shrink-0`) inside `overflow-hidden`; the conversation is
the ONLY scroll region (`min-h-0 flex-1 overflow-y-auto overscroll-contain`).
The composer textarea is capped (`max-h-40`, internal scroll) so long prompts
cannot push anything out of the viewport. Enter sends, Shift+Enter inserts a
newline (verified: Shift+Enter does not trigger send); sending snaps the
conversation to the latest message and status changes auto-scroll. Loading and
error states render inside the message list, never over the composer.

**Layout regression found and fixed:** at exactly 768 px the GLOBAL site
header (wordmark + 7 nav links + bell + avatar, present on every page,
including `#/discover` — i.e. pre-existing) overflowed horizontally by ~28 px.
Minimal spacing containment in `SiteShell.tsx` (`NavItem` `px-2.5→px-2`
below `lg`, left group `gap-6→gap-4 lg:gap-6` + `min-w-0`); no behavior or
visual design change at ≥1024 px.

## 7. Test results and exit codes (real, this session's final run)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | exit 0 (clean) |
| `bun run lint` | exit 0 (0 problems) |
| `bun test` | exit 0 — **393 pass / 0 fail**, 2,581 expects, 25 files (was 375; +18 new) |
| New tests `tests/plan-schema-resilience.test.ts` | 18 pass — normalization (nulls, string→array, enums, unknown patch keys, junk tokens, steps-as-object, synthesized labels, constraint shapes, strict-schema survival), resolution (plan/reply/digest-invalid/real-diagnostics), bounded repair (exactly one repair call, repair prompt quotes real errors, failed-repair surfaces diagnostics instead of the old generic message, repaired plans still pass digest validation, `PLAN_MAX_ATTEMPTS=2`) |
| Isolated production build (`/tmp/bean-build`, `bun run build`) | exit 0 |
| Standalone (`node .next/standalone/server.js`, port 3100) | `/` 200 · `/api/health` ok · `/api/ready` ok |

Existing schema/validation/security tests were not weakened — the strict
`designPlanSchema`, tool registry, digest validation, constraint enforcement
and all approval flows still reject what they rejected before (proven by the
untouched pre-existing suites).

## 8. Browser E2E (demo account, real APIs, real gateway turns)

- **1440×900** — Customization: Content (left) + canvas + Studio rail;
  hero-heading content edit → canvas re-render + dirty → Discard dialog →
  exact revert. Templates panel: no motion badges, "Complete website design…"
  copy, Apply/Live preview/Revert intact. CODE GIFTZ: empty preview state with
  ZERO iframes (no portfolio leak); settings gear toggles auto-preview
  (persisted under `bean:ws-prefs:giftz`); real chat turn →
  "Updated the tagline." + site.json proposal + auto-preview + amber isolation
  banner; second real turn (services + type scale) → services render, 7
  checks passed; third real turn (multi-file restyle) → tokens+typography
  modified, 7 checks passed; Discard returns to the empty state.
- **1280×720 / 768×1024** — no horizontal overflow (after the pre-existing
  global-header containment fix); zones/composer correct.
- **390×844** — Customization zones Content|Preview|Studio all functional;
  CODE GIFTZ zones Chat|Preview; composer bottom 670 / Send visible (676–708)
  above zone tabs (765) and bottom nav; conversation independently scrollable
  (3544 px content in 278 px viewport); 30-line prompt caps the textarea at
  160 px with Send still visible; no page horizontal overflow.
- Screenshots: `/tmp/fix17-custom-content.png` (1440 Customization 3-zone),
  `/tmp/fix17-giftz-empty.png` (1440 empty preview + composer),
  `/tmp/fix17-giftz-generated.png` (isolated generated preview + banner),
  `/tmp/fix17-dark-restyle.png` (multi-file restyle preview),
  `/tmp/fix17-mobile-giftz.png` (390 chat + composer),
  `/tmp/fix17-390-content.png` (390 content editor),
  `/tmp/fix17-1280-giftz.png`, `/tmp/fix17-768-giftz.png`,
  `/tmp/fix17-final-1440.png`.
- Demo data left pristine: proposal discarded via the product's Discard; the
  test skill added to the profile was removed again (skills + headline
  verified restored via `/api/auth/me`).

## 9. Remaining limitations

- The model's *editorial judgment* is still its own: the "dark editorial"
  replay produced a light-paper editorial with serif/grand type — a valid,
  schema-clean plan the user can revise; the pipeline does not (and must not)
  force aesthetic outcomes.
- The repair loop retries once by design; a plan that is wrong twice fails
  with real diagnostics rather than looping (bounded cost, honest failure).
- Auto-preview renders the newest completed proposal only; reviewing an older
  proposal is one tap away on its card.
- The global header fix adjusts md-tier spacing only; ≤767 px still uses the
  mobile tab bar exactly as before.
- The composer disables input while a turn runs (pre-existing behavior) —
  history remains fully scrollable during that time.
- CODE GIFTZ preview continues to render the site-schema-driven renderer;
  raw HTML/CSS/JS generation remains unsupported by design (see
  UNSUPPORTED_CAPABILITIES).
