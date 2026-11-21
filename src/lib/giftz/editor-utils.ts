/**
 * GIFTZ Code workspace — pure editor utilities (GZ-2).
 *
 * Client-safe, dependency-free helpers shared by the Code workspace UI and
 * its tests: bounded line-diffing of unsaved drafts and editor language
 * resolution from project paths. Kept out of the components so the logic is
 * unit-testable without pulling the CodeMirror/React surface.
 */

// ------------------------------------------------------------------ language

export type GiftzEditorLanguage = "html" | "css" | "javascript" | "json" | "text";

/** Map a project path to the editor language (mirror of the preview highlighter). */
export function editorLanguageForPath(path: string): GiftzEditorLanguage {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "svg" || ext === "xml") return "html";
  if (ext === "css") return "css";
  if (ext === "js" || ext === "mjs") return "javascript";
  if (ext === "json" || ext === "webmanifest") return "json";
  return "text";
}

// ------------------------------------------------------------------ line diff

export type DiffLineType = "add" | "del" | "ctx";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * Bounded LCS line diff of the working draft vs the saved content — powers
 * the workspace "Diff" toggle. Lines beyond the caps collapse into honest
 * markers so huge files cannot blow up the panel.
 */
export function lineDiff(before: string, after: string, maxLines = 600): DiffLine[] {
  // The empty string is ZERO lines (not one empty line) — "delete everything"
  // must read as pure deletions, not deletions plus an added blank line.
  const a = before === "" ? [] : before.split("\n").slice(0, 4000);
  const b = after === "" ? [] : after.split("\n").slice(0, 4000);
  // LCS table (a.length * b.length) — capped to keep the workspace responsive.
  if (a.length * b.length > 4_000_000) {
    return [
      { type: "del", text: `(file too large to diff line-by-line — ${a.length} saved lines)` },
      { type: "add", text: `(file too large to diff line-by-line — ${b.length} draft lines)` },
    ];
  }
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < m) out.push({ type: "del", text: a[i++] });
  while (j < n) out.push({ type: "add", text: b[j++] });

  if (out.length > maxLines) {
    const head = out.slice(0, maxLines);
    head.push({ type: "ctx", text: `… diff truncated after ${maxLines} lines` });
    return head;
  }
  return out;
}
