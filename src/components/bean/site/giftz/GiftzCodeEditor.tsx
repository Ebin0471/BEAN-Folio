"use client";

/**
 * GiftzCodeEditor — the professional editing surface of the GIFTZ Code
 * workspace (GZ-2). A thin, app-styled wrapper around CodeMirror 6 (MIT —
 * see docs/product/GIFTZ_OPEN_SOURCE_REGISTER.md):
 *
 *   · syntax highlighting for html / css / js / json (plain text fallback),
 *   · line numbers, active-line highlight, bracket matching, history
 *     (undo/redo via the standard keymap AND the parent's toolbar buttons),
 *   · find & replace (CodeMirror's search panel, Ctrl/Cmd+F),
 *   · indent-with-spaces, dark obsidian theme matching the workspace,
 *   · external jump-to-line requests (build diagnostics navigation),
 *   · Cmd/Ctrl+S is forwarded to the parent (the workspace's save contract).
 *
 * The editor owns NO separate file state: it renders the value the workspace
 * hands it and reports edits upward — the same real project files the agent
 * edits, one source of truth.
 */

import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  highlightWhitespace,
  ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo,
  redo,
  indentWithTab,
} from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import {
  syntaxHighlighting,
  indentUnit,
  bracketMatching,
  HighlightStyle,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { editorLanguageForPath, type GiftzEditorLanguage } from "@/lib/giftz/editor-utils";

// The language mapping is shared with the tests and the Code workspace via
// lib/giftz/editor-utils.ts (pure) — re-exported here for component consumers.
export { editorLanguageForPath };
export type { GiftzEditorLanguage };

const giftzHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "#6b7280", fontStyle: "italic" },
  { tag: t.keyword, color: "#e5c878" },
  { tag: t.string, color: "#a3be8c" },
  { tag: t.number, color: "#d8a657" },
  { tag: t.tagName, color: "#e06c75" },
  { tag: t.attributeName, color: "#d8a657" },
  { tag: t.attributeValue, color: "#a3be8c" },
  { tag: t.propertyName, color: "#7aa2f7" },
  { tag: t.definition(t.propertyName), color: "#7aa2f7" },
  { tag: t.function(t.variableName), color: "#61afef" },
  { tag: t.variableName, color: "#e0e0e6" },
  { tag: t.typeName, color: "#e5c878" },
  { tag: t.bool, color: "#d8a657" },
  { tag: t.null, color: "#d8a657" },
  { tag: t.operator, color: "#c0c0c8" },
  { tag: t.punctuation, color: "#9aa0a6" },
  { tag: t.link, color: "#7aa2f7" },
  { tag: t.invalid, color: "#f87171" },
]);

const giftzTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    backgroundColor: "#0d0f14",
    color: "#e0e0e6",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "#e5c878", padding: "8px 0" },
  ".cm-gutters": {
    backgroundColor: "#0a0c10",
    color: "#4b5563",
    border: "none",
    paddingRight: "4px",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#e5c878" },
  ".cm-activeLine": { backgroundColor: "rgba(229, 200, 120, 0.05)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(229, 200, 120, 0.22) !important",
  },
  ".cm-cursor": { borderLeftColor: "#e5c878" },
  ".cm-matchingBracket": {
    backgroundColor: "rgba(229, 200, 120, 0.15)",
    outline: "1px solid rgba(229, 200, 120, 0.45)",
  },
  ".cm-searchMatch": { backgroundColor: "rgba(229, 200, 120, 0.22)" },
  ".cm-searchMatch-selected": { backgroundColor: "rgba(229, 200, 120, 0.45)" },
  ".cm-panels": { backgroundColor: "#12151c", color: "#e0e0e6", borderColor: "#2a2f3a" },
  ".cm-panel.cm-search label": { fontSize: "11px", color: "#9aa0a6" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": {
    fontSize: "11px",
    backgroundColor: "#1a1e27",
    color: "#e0e0e6",
    border: "1px solid #2a2f3a",
    borderRadius: "4px",
    padding: "1px 4px",
  },
  ".cm-tooltip": { backgroundColor: "#12151c", border: "1px solid #2a2f3a" },
});

function languageExtension(language: GiftzEditorLanguage) {
  switch (language) {
    case "html":
      return html({ autoCloseTags: true });
    case "css":
      return css();
    case "javascript":
      return javascript();
    case "json":
      return json();
    default:
      return [];
  }
}

export interface GiftzCodeEditorProps {
  value: string;
  language: GiftzEditorLanguage;
  /** Reports the new draft upward on every edit. */
  onChange: (value: string) => void;
  /** Cmd/Ctrl+S inside the editor triggers the workspace save. */
  onSave?: () => void;
  /** Focus + select a 1-based line (build diagnostics navigation). Bump epoch to re-trigger. */
  jumpTo?: { line: number; epoch: number } | null;
  readOnly?: boolean;
  ariaLabel?: string;
  /** Assigned once the view exists — toolbar undo/redo/search bound to the live view. */
  onReady?: (api: { undo: () => void; redo: () => void; find: () => void }) => void;
}

export function GiftzCodeEditor({
  value,
  language,
  onChange,
  onSave,
  jumpTo,
  readOnly = false,
  ariaLabel,
  onReady,
}: GiftzCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onReadyRef = useRef(onReady);
  const languageComp = useRef(new Compartment());
  const readOnlyComp = useRef(new Compartment());
  const editableComp = useRef(new Compartment());
  // The last value the PARENT pushed in — external updates reconfigure the
  // doc; the editor's own edits never re-trigger that path.
  const externalValueRef = useRef(value);

  // Keep the latest callback identities outside render (react-hooks/refs).
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onReadyRef.current = onReady;
  }, [onChange, onSave, onReady]);

  // Create the view once.
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: externalValueRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          bracketMatching(),
          highlightWhitespace(),
          highlightSelectionMatches(),
          indentUnit.of("  "),
          EditorState.allowMultipleSelections.of(true),
          languageComp.current.of(languageExtension(language)),
          readOnlyComp.current.of(EditorState.readOnly.of(readOnly)),
          editableComp.current.of(EditorView.editable.of(!readOnly)),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          syntaxHighlighting(giftzHighlightStyle),
          giftzTheme,
          EditorView.updateListener.of((update: ViewUpdate) => {
            if (update.docChanged) {
              const next = update.state.doc.toString();
              // Programmatic doc replacements (file switch / revert / search
              // jump) must NOT echo back as user edits — the parent's draft
              // for a still-loading file would be overwritten with the
              // transient empty doc (observed live: an opened file arrived
              // "unsaved + empty"). Only edits that DIVERGE from the value
              // the parent last pushed are user edits.
              if (next === externalValueRef.current) return;
              externalValueRef.current = next;
              onChangeRef.current(next);
            }
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    onReadyRef.current?.({
      undo: () => undo(view),
      redo: () => redo(view),
      find: () => openSearchPanel(view),
    });
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // External value changes (file switch, revert, external apply) replace the doc.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === externalValueRef.current) return;
    externalValueRef.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      // A file switch / revert is a hard reset — collapse the history so
      // undo cannot walk back into another file's content.
      annotations: [],
    });
  }, [value]);

  // Language + readOnly reconfigure without recreating the view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageComp.current.reconfigure(languageExtension(language)),
    });
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        readOnlyComp.current.reconfigure(EditorState.readOnly.of(readOnly)),
        editableComp.current.reconfigure(EditorView.editable.of(!readOnly)),
      ],
    });
  }, [readOnly]);

  // Jump-to-line requests (diagnostics navigation).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jumpTo) return;
    const lineNumber = Math.max(1, Math.min(jumpTo.line, view.state.doc.lines));
    const line = view.state.doc.line(lineNumber);
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }, [jumpTo]);

  return (
    <div
      ref={hostRef}
      className="min-h-0 flex-1 overflow-hidden bg-[#0d0f14]"
      aria-label={ariaLabel}
      role="group"
      onKeyDown={(e) => {
        // Cmd/Ctrl+F opens the in-editor search panel; Escape (handled by
        // CodeMirror) closes it. Kept as a DOM-level affordance so the
        // shortcut works even before the editor has focus history.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          const view = viewRef.current;
          if (view) {
            e.preventDefault();
            openSearchPanel(view);
          }
        }
      }}
    />
  );
}

/** Toolbar undo/redo/search helpers bound to the live view. */
export function useGiftzEditorCommands(viewGetter: () => EditorView | null) {
  return {
    undo: () => {
      const view = viewGetter();
      if (view) undo(view);
    },
    redo: () => {
      const view = viewGetter();
      if (view) redo(view);
    },
    find: () => {
      const view = viewGetter();
      if (view) openSearchPanel(view);
    },
  };
}
