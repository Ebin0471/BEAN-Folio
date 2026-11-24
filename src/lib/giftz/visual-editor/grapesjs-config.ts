/**
 * BEAN Folio — GrapesJS editor construction for the GIFTZ visual editor.
 *
 * ORIGINAL BEAN adapter code (not copied from upstream examples/presets —
 * the `gjs-preset-webpage` plugin and upstream demo CSS are deliberately NOT
 * installed; see docs/oss/website-editor-evaluation.md §2). The editor core
 * is the pinned open-source `grapesjs` package (BSD-3-Clause).
 *
 * Design: obsidian/gold surfaces, compact controls, no upstream branding —
 * the chrome is styled by `grapesjs-bean.css` below via `editor.on("load")`
 * style injection scoped to the editor root (no application-wide CSS leaks).
 */

import type { Editor } from "grapesjs";
import { buildEditorHtml } from "@/lib/giftz/visual-editor/round-trip";

/**
 * BEAN-native section blocks. These are BEAN-original presets composed from
 * plain HTML/CSS (no upstream blocks): creators drop them onto GIFTZ pages
 * and the exported markup passes the existing build validator unchanged.
 */
export const BEAN_VISUAL_BLOCKS: Array<{
  id: string;
  label: string;
  category: string;
  html: string;
  css: string;
}> = [
  {
    id: "bean-hero",
    label: "Hero",
    category: "BEAN sections",
    html: `<section class="bean-hero"><h1>Your headline</h1><p>A short introduction to your work.</p><a class="bean-btn" href="#contact">Get in touch</a></section>`,
    css: `.bean-hero{padding:72px 24px;text-align:center}.bean-hero h1{font-size:40px;margin:0 0 12px}.bean-hero p{margin:0 auto 20px;max-width:560px;color:#555}.bean-btn{display:inline-block;padding:10px 20px;border:1px solid #c8a44d;border-radius:999px;color:#1a1a1a;text-decoration:none}`,
  },
  {
    id: "bean-about",
    label: "About",
    category: "BEAN sections",
    html: `<section class="bean-about"><h2>About</h2><p>Two or three sentences about who you are and what you do.</p></section>`,
    css: `.bean-about{padding:56px 24px;max-width:720px;margin:0 auto}.bean-about h2{font-size:26px;margin:0 0 12px}.bean-about p{margin:0;color:#444;line-height:1.6}`,
  },
  {
    id: "bean-projects",
    label: "Projects grid",
    category: "BEAN sections",
    html: `<section class="bean-projects"><h2>Selected work</h2><div class="bean-grid"><article class="bean-card"><h3>Project one</h3><p>Short description.</p></article><article class="bean-card"><h3>Project two</h3><p>Short description.</p></article><article class="bean-card"><h3>Project three</h3><p>Short description.</p></article></div></section>`,
    css: `.bean-projects{padding:56px 24px}.bean-projects h2{font-size:26px;margin:0 0 20px;text-align:center}.bean-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));max-width:960px;margin:0 auto}.bean-card{border:1px solid #e2ded2;border-radius:12px;padding:20px;background:#fff}.bean-card h3{margin:0 0 8px;font-size:17px}.bean-card p{margin:0;color:#555;font-size:14px}`,
  },
  {
    id: "bean-contact",
    label: "Contact",
    category: "BEAN sections",
    html: `<section class="bean-contact" id="contact"><h2>Contact</h2><p>Email <a href="mailto:hello@example.com">hello@example.com</a> to start a conversation.</p></section>`,
    css: `.bean-contact{padding:56px 24px;text-align:center}.bean-contact h2{font-size:26px;margin:0 0 12px}.bean-contact p{margin:0;color:#444}`,
  },
];

/** BEAN chrome CSS — scoped under `.bean-visual-editor` (the wrapper class). */
export const BEAN_EDITOR_CSS = `
.bean-visual-editor{--gjs-primary-color:#c8a44d;--gjs-secondary-color:#1b1b1b;}
.bean-visual-editor .gjs-editor{background:#101010;color:#e8e3d5;font-family:inherit;}
.bean-visual-editor .gjs-pn-panel{background:#161616;border-color:#2a2a26;}
.bean-visual-editor .gjs-pn-panels,.bean-visual-editor .gjs-pn-commands{background:#161616;}
.bean-visual-editor .gjs-blocks-c .gjs-block{background:#1c1c1a;border:1px solid #2a2a26;color:#d9d2c0;border-radius:8px;min-height:56px}
.bean-visual-editor .gjs-blocks-c .gjs-block:hover{border-color:#c8a44d}
.bean-visual-editor .gjs-block-label{color:#d9d2c0;font-size:11px}
.bean-visual-editor .gjs-block-category .gjs-title{color:#c8a44d;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.bean-visual-editor .gjs-layer-title{color:#e8e3d5}
.bean-visual-editor .gjs-clm-tags .gjs-clm-tag{background:#2a2a26;color:#e8e3d5}
.bean-visual-editor .gjs-sm-label,.bean-visual-editor .gjs-clm-label{color:#bdb7a6}
.bean-visual-editor .gjs-field,.bean-visual-editor .gjs-select,.bean-visual-editor input,.bean-visual-editor select,.bean-visual-editor textarea{background:#1c1c1a;border-color:#2a2a26;color:#e8e3d5}
.bean-visual-editor .gjs-traits-label{color:#c8a44d}
.bean-visual-editor .gjs-cv-canvas__frames{background:#0a0a0a}
.bean-visual-editor .gjs-toolbar .gjs-toolbar-item{background:#2a2a26;color:#e8e3d5}
.bean-visual-editor .gjs-badge{background:#c8a44d;color:#101010}
.bean-visual-editor .gjs-off-prm{display:none}
`;

export interface BeanEditorOptions {
  /** The page's ORIGINAL HTML (already validated as visually editable by round-trip.ts). */
  html: string;
  /** The combined CSS (linked stylesheet content + inline styles). */
  css: string;
  /** Change callback — fires (debounced by the caller) after real edits. */
  onChange?: () => void;
}

/**
 * Build the editor into `container`. Returns the editor instance; the caller
 * OWNS disposal (editor.destroy() on unmount/project switch — VisualWorkspace
 * guarantees exactly one live instance per mount).
 */
export async function createBeanVisualEditor(container: HTMLElement, opts: BeanEditorOptions): Promise<Editor> {
  // Client-only dynamic import keeps the GrapesJS bundle out of the server
  // graph and out of the initial route payload.
  const grapesjs = (await import("grapesjs")).default;
  const editor = grapesjs.init({
    container,
    // No upstream presets — BEAN blocks + traits only (license + branding rule).
    // Panels use the editor's built-in layout (blocks left, layers/settings
    // right, traits top) restyled to BEAN's chrome by BEAN_EDITOR_CSS —
    // scoped under .bean-visual-editor so nothing leaks into the app.
    height: "100%",
    width: "auto",
    storageManager: false, // persistence is BEAN's file pipeline, never GrapesJS storage
    styleManager: { sectors: [{ name: "Typography", open: false, buildProps: ["font-family", "font-size", "font-weight", "letter-spacing", "line-height", "color", "text-align"] }, { name: "Dimension", open: false, buildProps: ["width", "height", "padding", "margin"] }, { name: "Decorations", open: false, buildProps: ["border-radius", "border", "background-color", "background", "box-shadow"] }] },
    canvas: { styles: [] },
    projectData: {
      pages: [{ id: "bean-page", component: buildEditorHtml(opts.html, opts.css) }],
    },
  });

  // BEAN blocks (original presets) — registered once per editor instance.
  const bm = editor.BlockManager;
  for (const b of BEAN_VISUAL_BLOCKS) {
    bm.add(b.id, { label: b.label, category: b.category, content: `<style>${b.css}</style>${b.html}` });
  }

  // BEAN chrome + dirty tracking (guarded so programmatic setup never counts).
  editor.on("load", () => {
    const root = editor.getContainer() ?? container;
    const wrapper = root.closest?.(".bean-visual-editor") ?? container;
    if (wrapper && !document.getElementById("bean-visual-editor-css")) {
      const style = document.createElement("style");
      style.id = "bean-visual-editor-css";
      style.textContent = BEAN_EDITOR_CSS;
      document.head.appendChild(style);
    }
  });
  if (opts.onChange) {
    let armed = false;
    setTimeout(() => {
      armed = true;
    }, 400);
    editor.on("update", () => {
      if (armed) opts.onChange?.();
    });
  }
  return editor;
}

/** Export the round-trip artifacts from a live editor instance. */
export function exportBeanVisualProject(editor: Editor): { html: string; css: string } {
  return {
    html: editor.getHtml() ?? "",
    css: editor.getCss() ?? "",
  };
}
