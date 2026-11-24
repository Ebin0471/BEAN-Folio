# GIFTZ Visual-Editor Round-Trip PoC — RESULT (executed evidence)

**Executed:** 2026-11-24 (UTC), agent-browser (Chrome 158) against the loopback harness
(`serve.ts`, port 3102). Sample: `sample-page.html` + `sample-style.css` — a representative
GIFTZ-generated page (viewport/lang meta, one linked stylesheet, vendor gsap script + motion
runtime script with prefers-reduced-motion guard, nav links, section ids, images with alt).
Editor: pinned `grapesjs@0.23.9` (BSD-3-Clause) loaded from the local dist bundle.

## Method

1. Import the sample page into the editor (CSS injected as an editor-managed `<style>` block —
   see finding F-2 below).
2. Apply a REAL edit (replace the hero `<h1>` text via the text-component API).
3. Export (`getHtml()` + `getCss()`).
4. Rebuild the project document with the adapter's `reconstructDocument()` (the exact logic in
   `src/lib/giftz/visual-editor/round-trip.ts`) and compare structurally.

## Verified preservation matrix (all browser-verified, not claimed)

| Item | Result |
| --- | --- |
| `<!DOCTYPE html>` + `<html lang="en">` wrapper | KEPT (taken from the original document) |
| Head block (meta charset/viewport, title, stylesheet `<link>`) | KEPT VERBATIM (never passes through the editor model) |
| Nav links + `aria-label` | KEPT |
| Section ids/classes (`id="hero"`, `class="card"` …) | KEPT |
| `img src` + `alt` attributes | KEPT |
| Vendor script (`assets/vendor/gsap.min.js`) | RE-INJECTED VERBATIM (2/2 script tags) |
| Inline motion script incl. `prefers-reduced-motion` guard | RE-INJECTED VERBATIM |
| Text edit (hero headline) | APPLIED in the export |
| Full stylesheet round-trip | COMPLETE: CSS variables, every class rule, grid layout (2,337+ chars exported) |
| Applied-CSS editability | exported CSS is a full, workable stylesheet |

## Findings that shaped the adapter (F-1…F-3)

- **F-1 — scripts are stripped by the editor model.** `getHtml()` emits ZERO script tags
  regardless of placement. Adapter answer: body scripts are extracted at load and re-injected
  verbatim at save (`reconstructDocument`); head scripts ride inside the verbatim head. The
  visual editor NEVER claims to edit scripts — the Code workspace remains their editor, and the
  save toast reports how many script tags were preserved.
- **F-2 — the `styles` project-data entry round-trips only partially** (a naive pass kept 2 of
  ~12 rules). Adapter answer: the stylesheet content is injected as an in-document
  `<style id="bean-visual-css">` block, which GrapesJS parses completely into its CSS composer
  (PoC-verified: full rule set exports).
- **F-3 — the export is wrapper-less** (starts at the body children; head items flatten into the
  beginning). Adapter answer: `reconstructDocument()` splices the original verbatim head +
  doctype + `<html lang>` wrapper back, strips the flattened head items from the export, and
  re-attaches body scripts before `</body>`.

## Documented, non-semantic normalization

Body whitespace and attribute order are normalized by the editor; comment nodes inside the
body are not preserved. The head is untouched verbatim. Eligibility rules
(`analyzePageStyles`) refuse pages whose styling does not fit the safe round-trip shape
(multi-stylesheet or external CSS) with an honest explanation, keeping the Code workspace
fully available.

## Evidence files

- `harness.png` / `../../agent-ctx/roundtrip/harness.png` — the harness after import+export.
- `../../agent-ctx/roundtrip/harness-after-edit.png` — after the real edit + reconstruction.
- `../../agent-ctx/roundtrip/exported.html` / `exported.css` — first-run export capture.
