"use client";

/**
 * CodeWorkspace — the GIFTZ "Code" tab (contract §8): the generated website's
 * REAL project file tree plus a professional code editor.
 *
 * LEFT  — 200px file tree (grouped client-side on "/" segments). Every row
 *         carries a source dot: generated = muted gray, user = gold, ai =
 *         emerald (sr-only labels included).
 * RIGHT — open-file TABS (dirty dot per tab) + toolbar (path breadcrumb,
 *         Undo/Redo/Find, Edit/Preview toggle, Diff toggle, Save / Revert /
 *         New / Rename / Delete / Find in project) and the editing surface:
 *         a CodeMirror 6 editor (syntax highlighting, line numbers, history,
 *         find & replace, diagnostics navigation) for UTF-8 files, with a
 *         read-only "Preview" toggle rendering the SAVED content through
 *         react-syntax-highlighter and a line-diff view of unsaved changes.
 *         Binary (base64) rows get an honest notice card instead of an editor.
 *
 * GZ-2: the editor edits the SAME real project files the agent edits — one
 * source of truth, no separate editor state. Saving writes through
 * PUT /api/giftz/sites/:id/files/content (source becomes "user"). Saving
 * `site.config.json` re-reads the site detail and hands the refreshed config
 * to the parent (onConfigSynced) so the rendered canvas follows the file
 * tree — sync rule S2. Cmd/Ctrl+S saves the open file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Redo2,
  RotateCcw,
  Save,
  Search,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client";
import {
  deleteSiteFile,
  getSiteBuild,
  listSiteBuilds,
  listSiteFiles,
  readSiteFile,
  renameSiteFile,
  writeSiteFile,
  type GiftzProjectFileDTO,
} from "@/lib/giftz-client";
import { normalizeConfig, type SiteConfig } from "@/lib/site-config";
import { cn } from "@/lib/utils";
import {
  GiftzCodeEditor,
  editorLanguageForPath,
  type GiftzEditorLanguage,
} from "./GiftzCodeEditor";
import { lineDiff } from "@/lib/giftz/editor-utils";

// ------------------------------------------------------------------ helpers

/** File-type icon (kept coarse — the tree stays readable at 11px). */
function iconForPath(path: string): LucideIcon {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"].includes(ext)) return ImageIcon;
  if (["html", "css", "js", "mjs", "ts", "jsx", "tsx"].includes(ext)) return FileCode;
  return FileText;
}

/** Syntax language for the read-only highlighter (best-effort by extension). */
function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "svg" || ext === "xml") return "markup";
  if (ext === "css") return "css";
  if (ext === "js" || ext === "mjs" || ext === "jsx") return "javascript";
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "json" || ext === "webmanifest") return "json";
  if (ext === "md") return "markdown";
  return "text";
}

const SOURCE_DOT: Record<string, string> = {
  generated: "bg-muted-foreground/40",
  user: "bg-[#e5c878]",
  ai: "bg-emerald-500",
};

const SOURCE_LABEL: Record<string, string> = {
  generated: "generated file",
  user: "your edited file",
  ai: "AI written file",
};

/** Client mirror of the server path rules (server is authoritative). */
function projectPathError(raw: string): string | null {
  const p = raw.trim();
  if (!p) return "A file path is required.";
  if (p.startsWith("/")) return "Paths are relative — no leading slash.";
  if (p.includes("\\")) return "Backslashes are not allowed — use / to separate folders.";
  if (p.includes("..")) return "\"..\" segments are not allowed.";
  if (p.includes("\0")) return "The path contains an invalid character.";
  if (p.length > 200) return "Paths are limited to 200 characters.";
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "A file path is required.";
  if (segments.length > 8) return "Paths can be at most 8 folders deep.";
  for (const s of segments) {
    if (s.startsWith(".")) return "Folder and file names cannot start with a dot.";
    if (s === ".git") return "A \".git\" folder is not allowed.";
  }
  return null;
}

interface FileTreeNode {
  name: string;
  path: string;
  dir: boolean;
  depth: number;
  file?: GiftzProjectFileDTO;
  children: FileTreeNode[];
}

/** Build-diagnostic shape the workspace reads from the latest build. */
interface GiftzBuildDiagnosticLite {
  path: string;
  severity: string;
  message: string;
}

/** Pure client grouping of the flat file list on "/" segments. */
function buildTree(files: GiftzProjectFileDTO[]): FileTreeNode[] {
  const dirs = new Map<string, FileTreeNode>();
  const root: FileTreeNode[] = [];

  const ensureDir = (path: string): FileTreeNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const segments = path.split("/");
    const node: FileTreeNode = {
      name: segments[segments.length - 1],
      path,
      dir: true,
      depth: segments.length - 1,
      children: [],
    };
    dirs.set(path, node);
    const parentPath = segments.slice(0, -1).join("/");
    if (parentPath) ensureDir(parentPath).children.push(node);
    else root.push(node);
    return node;
  };

  for (const f of files) {
    const segments = f.path.split("/");
    if (segments.length === 1) {
      root.push({ name: f.path, path: f.path, dir: false, depth: 0, file: f, children: [] });
      continue;
    }
    ensureDir(segments.slice(0, -1).join("/")).children.push({
      name: segments[segments.length - 1],
      path: f.path,
      dir: false,
      depth: segments.length - 1,
      file: f,
      children: [],
    });
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.dir) sortNodes(n.children);
    return nodes;
  };
  sortNodes(root);

  // Depth-first flatten honoring open state happens at render time; here we
  // return the nested forest and let the renderer walk it recursively.
  return root;
}

// ------------------------------------------------------------------ component

export function CodeWorkspace({
  siteId,
  onConfigSynced,
  refreshToken,
  className,
}: {
  siteId: string;
  /** Fired after `site.config.json` is saved and the server confirms a valid config. */
  onConfigSynced: (config: SiteConfig) => void;
  /** Bumped by the parent after saves / proposal applies — reloads the tree. */
  refreshToken: number;
  className?: string;
}) {
  const [files, setFiles] = useState<GiftzProjectFileDTO[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);

  // ---- open tabs + per-path draft state (GZ-2): every open file keeps its
  // own draft so switching tabs never discards unsaved work.
  const [tabs, setTabs] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [savedMap, setSavedMap] = useState<Record<string, string>>({});
  const [draftMap, setDraftMap] = useState<Record<string, string>>({});
  const [binaryMap, setBinaryMap] = useState<Record<string, boolean>>({});
  const [metaMap, setMetaMap] = useState<Record<string, GiftzProjectFileDTO | null>>({});

  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  // Editor API (undo/redo/find bound to the live CodeMirror view).
  const editorApiRef = useRef<{ undo: () => void; redo: () => void; find: () => void } | null>(null);
  const [jumpTo, setJumpTo] = useState<{ line: number; epoch: number } | null>(null);

  // Latest build diagnostics — the error/warning strip under the editor.
  const [diagnostics, setDiagnostics] = useState<GiftzBuildDiagnosticLite[] | null>(null);

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const expandedSeedRef = useRef(false);

  // dialogs
  const [newOpen, setNewOpen] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [closeTabConfirm, setCloseTabConfirm] = useState<string | null>(null);
  // project-wide search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<{ path: string; line: number; text: string }[] | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const dialogOpen = newOpen || renameOpen || deleteOpen || closeTabConfirm !== null || searchOpen;

  const activeSaved = selectedPath !== null ? savedMap[selectedPath] ?? "" : "";
  const activeDraft = selectedPath !== null ? draftMap[selectedPath] ?? "" : "";
  const activeBinary = selectedPath !== null ? binaryMap[selectedPath] ?? false : false;
  const activeLanguage: GiftzEditorLanguage = selectedPath ? editorLanguageForPath(selectedPath) : "text";
  const dirty = selectedPath !== null && !activeBinary && activeDraft !== activeSaved;

  interface GiftzBuildDiagnosticLite {
    path: string;
    severity: string;
    message: string;
  }

  const reloadFiles = useCallback(async () => {
    setTreeLoading(true);
    try {
      const r = await listSiteFiles(siteId);
      setFiles(r.files);
      setTreeError(null);
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : "Could not load the project files");
    } finally {
      setTreeLoading(false);
    }
  }, [siteId]);

  const loadDiagnostics = useCallback(async () => {
    try {
      const list = await listSiteBuilds(siteId);
      if (!list.builds[0]) {
        setDiagnostics(null);
        return;
      }
      const detail = await getSiteBuild(siteId, list.builds[0].id);
      setDiagnostics(detail.build.diagnostics ?? []);
    } catch {
      setDiagnostics(null);
    }
  }, [siteId]);

  useEffect(() => {
    expandedSeedRef.current = false;
    setSelectedPath(null);
    setTabs([]);
    void reloadFiles();
    void loadDiagnostics();
  }, [siteId, refreshToken, reloadFiles, loadDiagnostics]);

  // Seed-expanded tree on first successful load (folders start open).
  useEffect(() => {
    if (!files || expandedSeedRef.current) return;
    expandedSeedRef.current = true;
    const dirs = new Set<string>();
    for (const f of files) {
      const segments = f.path.split("/");
      for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
    }
    setExpandedDirs(dirs);
  }, [files]);

  // Auto-open index.html (or the first file) when nothing is selected.
  useEffect(() => {
    if (!files) return;
    setSelectedPath((current) => {
      if (current && files.some((f) => f.path === current)) return current;
      return files.find((f) => f.path === "index.html")?.path ?? files[0]?.path ?? null;
    });
  }, [files]);

  // Drop stale tabs/selection when a file vanished from the tree.
  useEffect(() => {
    if (!files) return;
    const exists = new Set(files.map((f) => f.path));
    setTabs((prev) => prev.filter((p) => exists.has(p)));
    setSelectedPath((prev) => (prev && exists.has(prev) ? prev : null));
  }, [files]);

  const loadContent = useCallback(
    async (path: string, force = false) => {
      // Already cached (and not forced) → just switch to the cached draft.
      if (!force && path in savedMapRef.current && path in draftMapRef.current) return;
      setContentLoading(true);
      setContentError(null);
      try {
        const r = await readSiteFile(siteId, path);
        const content = r.binary ? "" : (r.file.content ?? "");
        setBinaryMap((m) => ({ ...m, [path]: r.binary }));
        setSavedMap((m) => ({ ...m, [path]: content }));
        setDraftMap((m) => ({ ...m, [path]: m[path] ?? content }));
        const meta = filesRef.current?.find((f) => f.path === path) ?? null;
        setMetaMap((m) => ({
          ...m,
          [path]: meta
            ? { ...meta, source: r.file.source, encoding: r.file.encoding, mime: r.file.mime, updatedAt: r.file.updatedAt }
            : null,
        }));
      } catch (e) {
        setContentError(e instanceof Error ? e.message : "Could not open this file");
      } finally {
        setContentLoading(false);
      }
    },
    [siteId]
  );

  // Ref mirrors of the caches — loadContent reads them WITHOUT depending on
  // them, so a keystroke (draftMap change) never re-triggers the content load.
  const savedMapRef = useRef<Record<string, string>>({});
  const draftMapRef = useRef<Record<string, string>>({});
  const filesRef = useRef<GiftzProjectFileDTO[] | null>(null);
  useEffect(() => {
    savedMapRef.current = savedMap;
    draftMapRef.current = draftMap;
    filesRef.current = files;
  }, [savedMap, draftMap, files]);

  // Ensure the ACTIVE path is loaded whenever the selection changes.
  useEffect(() => {
    if (!selectedPath) return;
    void loadContent(selectedPath);
  }, [selectedPath, loadContent]);

  // Tabs follow the selection.
  useEffect(() => {
    if (!selectedPath) return;
    setTabs((prev) => (prev.includes(selectedPath) ? prev : [...prev, selectedPath]));
  }, [selectedPath]);

  const openFileAt = useCallback(
    (path: string, line?: number) => {
      setSelectedPath(path);
      setPreviewMode(false);
      if (line !== undefined) {
        // The line jump is applied by the editor after the content arrives —
        // epoch bump ensures repeat clicks on the same line re-trigger.
        setJumpTo({ line, epoch: Date.now() });
      }
    },
    []
  );

  const afterConfigFileSave = useCallback(async () => {
    // S2: the server already synced GiftzSite.config from the written file.
    // Re-read the site detail and hand the refreshed config to the canvas.
    try {
      const r = await api<{ site: { config: unknown } }>(`/api/giftz/sites/${encodeURIComponent(siteId)}`);
      const config = normalizeConfig(r.site.config);
      if (config) onConfigSynced(config);
    } catch {
      // Honest, non-blocking: the FILE was saved; the canvas sync could not be
      // confirmed right now (network/server hiccup). The next save reconciles.
      toast.warning("site.config.json saved — the canvas config could not be refreshed just now");
    }
  }, [siteId, onConfigSynced]);

  const save = useCallback(async () => {
    if (!selectedPath || activeBinary || saving) return;
    setSaving(true);
    try {
      await writeSiteFile(siteId, selectedPath, activeDraft, "utf8");
      setSavedMap((m) => ({ ...m, [selectedPath]: activeDraft }));
      toast.success("File saved");
      await reloadFiles();
      await loadDiagnostics();
      if (selectedPath === "site.config.json") await afterConfigFileSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the file");
    } finally {
      setSaving(false);
    }
  }, [selectedPath, activeBinary, saving, siteId, activeDraft, reloadFiles, loadDiagnostics, afterConfigFileSave]);

  const revert = useCallback(() => {
    if (!selectedPath || activeBinary) return;
    setDraftMap((m) => ({ ...m, [selectedPath]: savedMap[selectedPath] ?? "" }));
  }, [selectedPath, activeBinary, savedMap]);

  // Cmd/Ctrl+S saves the open file (skipped while a dialog owns the keyboard).
  useEffect(() => {
    if (!selectedPath || dialogOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (!activeBinary && activeDraft !== activeSaved) void save();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedPath, dialogOpen, activeBinary, activeDraft, activeSaved, save]);

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const createFile = async () => {
    const error = projectPathError(newPath);
    if (error) {
      setNewError(error);
      return;
    }
    const path = newPath.trim();
    setCreating(true);
    try {
      await writeSiteFile(siteId, path, "", "utf8");
      setNewOpen(false);
      setNewPath("");
      setNewError(null);
      await reloadFiles();
      setSavedMap((m) => ({ ...m, [path]: "" }));
      setDraftMap((m) => ({ ...m, [path]: m[path] ?? "" }));
      openFileAt(path);
      toast.success("File created");
    } catch (e) {
      setNewError(e instanceof Error ? e.message : "Could not create the file");
    } finally {
      setCreating(false);
    }
  };

  const submitRename = async () => {
    if (!selectedPath) return;
    const error = projectPathError(renameTo);
    if (error) {
      setRenameError(error);
      return;
    }
    const to = renameTo.trim();
    if (to === selectedPath) {
      setRenameError("The new path is the same as the current one.");
      return;
    }
    setRenaming(true);
    try {
      await renameSiteFile(siteId, selectedPath, to);
      setRenameOpen(false);
      setRenameTo("");
      setRenameError(null);
      await reloadFiles();
      // Move the cached draft to the new path so unsaved work survives.
      setSavedMap((m) => {
        const next = { ...m };
        if (selectedPath in next) {
          next[to] = next[selectedPath];
          delete next[selectedPath];
        }
        return next;
      });
      setDraftMap((m) => {
        const next = { ...m };
        if (selectedPath in next) {
          next[to] = next[selectedPath];
          delete next[selectedPath];
        }
        return next;
      });
      setTabs((prev) => prev.map((p) => (p === selectedPath ? to : p)));
      openFileAt(to);
      toast.success("File renamed");
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : "Could not rename the file");
    } finally {
      setRenaming(false);
    }
  };

  const submitDelete = async () => {
    if (!selectedPath) return;
    setDeleting(true);
    try {
      await deleteSiteFile(siteId, selectedPath);
      setDeleteOpen(false);
      setSelectedPath(null);
      setTabs((prev) => prev.filter((p) => p !== selectedPath));
      await reloadFiles();
      await loadDiagnostics();
      toast.success("File deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the file");
    } finally {
      setDeleting(false);
    }
  };

  const requestCloseTab = (path: string) => {
    const tabDirty = binaryMap[path] ? false : (draftMap[path] ?? "") !== (savedMap[path] ?? "");
    if (tabDirty) {
      setCloseTabConfirm(path);
      return;
    }
    setTabs((prev) => prev.filter((p) => p !== path));
    setSelectedPath((prev) => (prev === path ? tabs.find((p) => p !== path) ?? null : prev));
  };

  const runProjectSearch = async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    try {
      const r = await api<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>(
        `/api/giftz/sites/${encodeURIComponent(siteId)}/files/search?q=${encodeURIComponent(q)}`
      );
      setSearchResults(r.matches);
      setSearchTruncated(r.truncated);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Could not search the project");
      setSearchResults(null);
    } finally {
      setSearching(false);
    }
  };

  // Diagnostics for the ACTIVE file, ordered errors first.
  const activeDiagnostics = useMemo(() => {
    if (!selectedPath || !diagnostics) return [];
    return diagnostics
      .filter((d) => d.path === selectedPath)
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
      .slice(0, 12);
  }, [selectedPath, diagnostics]);

  /** Extract "line N" from a build diagnostic message when present. */
  const lineFromDiagnostic = (message: string): number | null => {
    const m = /\bat line (\d+)/.exec(message);
    return m ? Number(m[1]) : null;
  };

  const diffLines = useMemo(() => {
    if (!showDiff || !selectedPath || activeBinary) return null;
    return lineDiff(activeSaved, activeDraft);
  }, [showDiff, selectedPath, activeBinary, activeSaved, activeDraft]);

  const isConfigFile = selectedPath === "site.config.json";

  const tree = useMemo(() => (files ? buildTree(files) : []), [files]);

  const renderNodes = (nodes: FileTreeNode[]): React.ReactNode =>
    nodes.map((node) => {
      if (node.dir) {
        const open = expandedDirs.has(node.path);
        return (
          <li key={`dir:${node.path}`}>
            <button
              type="button"
              onClick={() => toggleDir(node.path)}
              aria-expanded={open}
              className="flex h-7 w-full items-center gap-1 rounded px-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/60"
              style={{ paddingLeft: 6 + node.depth * 12 }}
            >
              {open ? (
                <ChevronDown className="size-3 shrink-0" aria-hidden />
              ) : (
                <ChevronRight className="size-3 shrink-0" aria-hidden />
              )}
              {open ? (
                <FolderOpen className="size-3.5 shrink-0 text-primary/70" aria-hidden />
              ) : (
                <Folder className="size-3.5 shrink-0 text-primary/70" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
            </button>
            {open && <ul className="space-y-px">{renderNodes(node.children)}</ul>}
          </li>
        );
      }
      const Icon = iconForPath(node.path);
      const tabDirty = binaryMap[node.path] ? false : (draftMap[node.path] ?? "") !== (savedMap[node.path] ?? "");
      return (
        <li key={node.path}>
          <button
            type="button"
            onClick={() => openFileAt(node.path)}
            aria-current={selectedPath === node.path || undefined}
            className={cn(
              "flex h-7 w-full items-center gap-1 rounded px-1.5 text-left text-[11px] transition-colors",
              selectedPath === node.path ? "bg-accent text-foreground" : "hover:bg-accent/60"
            )}
            style={{ paddingLeft: 6 + node.depth * 12 }}
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={node.path}>
              {node.name}
            </span>
            {tabDirty && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", SOURCE_DOT[node.file?.source ?? "generated"] ?? "bg-muted-foreground/40")}
            />
            <span className="sr-only">
              {SOURCE_LABEL[node.file?.source ?? "generated"] ?? "generated file"}
              {tabDirty ? " — unsaved changes" : ""}
            </span>
          </button>
        </li>
      );
    });

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-card/40 sm:flex-row", className)}>
      {/* LEFT — file tree (stacks above the editor on narrow/mobile widths) */}
      <div
        className="flex max-h-44 min-h-0 shrink-0 flex-col border-b border-border/60 bg-card/60 sm:max-h-none sm:w-[200px] sm:border-b-0 sm:border-r"
        aria-label="Project files"
      >
        <div className="flex shrink-0 items-center justify-between gap-1 px-2 py-1.5">
          <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Files</p>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="New file"
              title="New file"
              onClick={() => {
                setNewPath("");
                setNewError(null);
                setNewOpen(true);
              }}
            >
              <FilePlus2 className="size-3.5" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Find in project"
              title="Find in project"
              onClick={() => {
                setSearchQuery("");
                setSearchResults(null);
                setSearchError(null);
                setSearchOpen(true);
              }}
            >
              <Search className="size-3.5" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Reload file tree"
              title="Reload file tree"
              onClick={() => void reloadFiles()}
            >
              <RefreshCw className={cn("size-3.5", treeLoading && "animate-spin")} aria-hidden />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1.5" style={{ scrollbarWidth: "thin" }}>
          {treeLoading && !files ? (
            <p className="flex items-center gap-2 px-2 py-3 text-[11px] text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading files…
            </p>
          ) : treeError ? (
            <div className="px-2 py-2" role="alert">
              <p className="flex items-start gap-1.5 text-[11px] leading-snug text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {treeError}
              </p>
              <Button variant="outline" size="sm" className="mt-2 h-7 px-2 text-[11px]" onClick={() => void reloadFiles()}>
                <RefreshCw className="size-3" aria-hidden /> Retry
              </Button>
            </div>
          ) : files && files.length === 0 ? (
            <p className="px-2 py-3 text-[11px] leading-snug text-muted-foreground">
              No project files yet — save the generated website in Chat to compile its files.
            </p>
          ) : (
            <ul className="space-y-px">{renderNodes(tree)}</ul>
          )}
        </div>
      </div>

      {/* RIGHT — tabs + toolbar + editor */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* open-file tabs */}
        {tabs.length > 0 ? (
          <div
            className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border/60 bg-card/40 px-1.5 py-1"
            role="tablist"
            aria-label="Open files"
            style={{ scrollbarWidth: "thin" }}
          >
            {tabs.map((path) => {
              const tabBinary = binaryMap[path] ?? false;
              const tabDirty = tabBinary ? false : (draftMap[path] ?? "") !== (savedMap[path] ?? "");
              const active = path === selectedPath;
              const Icon = iconForPath(path);
              return (
                <div
                  key={path}
                  className={cn(
                    "group flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
                    active ? "border-border bg-accent text-foreground" : "border-transparent text-muted-foreground hover:bg-accent/60"
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => openFileAt(path)}
                    className="flex max-w-[180px] items-center gap-1 truncate"
                    title={path}
                  >
                    <Icon className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{path.split("/").pop()}</span>
                    {tabDirty && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${path}${tabDirty ? " (has unsaved changes)" : ""}`}
                    className="rounded p-0.5 text-muted-foreground opacity-70 transition-opacity hover:bg-accent hover:opacity-100"
                    onClick={() => requestCloseTab(path)}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5">
          <p className="mr-1 min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={selectedPath ?? undefined}>
            {selectedPath ?? "No file selected"}
            {dirty && (
              <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <span aria-hidden className="size-1.5 rounded-full bg-amber-500" /> unsaved
              </span>
            )}
          </p>
          {selectedPath && !activeBinary && (
            <>
              {/* Undo / Redo / Find — bound to the live CodeMirror view */}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-[11px]"
                onClick={() => editorApiRef.current?.undo()}
                disabled={previewMode}
                title="Undo (editor history)"
                aria-label="Undo"
              >
                <Undo2 className="size-3.5" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-[11px]"
                onClick={() => editorApiRef.current?.redo()}
                disabled={previewMode}
                title="Redo (editor history)"
                aria-label="Redo"
              >
                <Redo2 className="size-3.5" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-[11px]"
                onClick={() => editorApiRef.current?.find()}
                disabled={previewMode}
                title="Find and replace in this file (Ctrl/Cmd+F)"
                aria-label="Find and replace in this file"
              >
                <Search className="size-3.5" aria-hidden />
              </Button>
              {/* Edit / Preview / Diff toggles */}
              <div className="flex rounded-md border border-border/60 p-0.5" role="tablist" aria-label="Editor view">
                {(["edit", "diff", "preview"] as const).map((v) => {
                  const selected = v === "preview" ? previewMode : v === "diff" ? showDiff && !previewMode : !previewMode && !showDiff;
                  const onClick = () => {
                    if (v === "preview") {
                      setPreviewMode(true);
                    } else if (v === "diff") {
                      setPreviewMode(false);
                      setShowDiff(true);
                    } else {
                      setPreviewMode(false);
                      setShowDiff(false);
                    }
                  };
                  return (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={onClick}
                      disabled={v === "diff" && activeDraft === activeSaved}
                      className={cn(
                        "rounded px-2 py-0.5 text-[10px] font-medium capitalize transition-colors disabled:opacity-40",
                        selected ? "bg-gold-soft text-primary" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {v}
                    </button>
                  );
                })}
              </div>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => void save()} disabled={!dirty || saving} title="Save file (Cmd/Ctrl+S)">
                {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />} Save
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={revert} disabled={!dirty} title="Revert to the saved content">
                <RotateCcw className="size-3.5" aria-hidden /> Revert
              </Button>
            </>
          )}
          {selectedPath && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setRenameTo(selectedPath);
                  setRenameError(null);
                  setRenameOpen(true);
                }}
                title="Rename or move this file"
              >
                <Pencil className="size-3.5" aria-hidden /> Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-7 px-2 text-[11px]", isConfigFile && "pointer-events-none opacity-40")}
                onClick={() => setDeleteOpen(true)}
                title={isConfigFile ? "site.config.json is the website's own config — edit it and save, or manage the website config in Chat" : "Delete this file"}
                aria-disabled={isConfigFile}
              >
                <Trash2 className="size-3.5" aria-hidden /> Delete
              </Button>
            </>
          )}
        </div>

        {/* build diagnostics for the open file — click to jump */}
        {selectedPath && activeDiagnostics.length > 0 && !previewMode ? (
          <div className="max-h-28 shrink-0 overflow-y-auto border-b border-border/60 bg-background/60 px-2 py-1" style={{ scrollbarWidth: "thin" }} aria-label="Build diagnostics for this file">
            {activeDiagnostics.map((d, i) => {
              const line = lineFromDiagnostic(d.message);
              return (
                <button
                  key={`${d.path}:${i}`}
                  type="button"
                  onClick={() => {
                    if (line !== null) setJumpTo({ line, epoch: Date.now() });
                  }}
                  className={cn(
                    "flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left font-mono text-[10.5px] leading-snug transition-colors hover:bg-accent/60",
                    d.severity === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400"
                  )}
                  title={line !== null ? `Jump to line ${line}` : undefined}
                >
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 break-words">
                    {d.severity === "error" ? "error" : "warning"}: {d.message}
                    {line !== null ? ` (line ${line})` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {!selectedPath ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            <p className="max-w-xs text-center text-xs leading-relaxed text-muted-foreground">
              Select a file from the tree — generated, edited and AI-written files all live in the same project.
            </p>
          </div>
        ) : contentLoading && !(selectedPath in savedMap) ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4" role="status">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Opening file…
            </p>
          </div>
        ) : contentError && !(selectedPath in savedMap) ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4" role="alert">
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <TriangleAlert className="size-4" aria-hidden /> {contentError}
            </p>
            <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => void loadContent(selectedPath, true)}>
              <RefreshCw className="size-3" aria-hidden /> Try again
            </Button>
          </div>
        ) : activeBinary ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            <div className="max-w-sm rounded-lg border border-white/10 bg-[#0d0f14] p-4 text-center">
              <TriangleAlert className="mx-auto size-5 text-amber-500" aria-hidden />
              <p className="mt-2 text-xs font-medium text-white/90">Binary file (base64-encoded asset)</p>
              <p className="mt-1 break-all font-mono text-[11px] text-white/60">{selectedPath}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-white/60">
                Images, fonts and media are stored as-is and served by the preview and the published site. Text editing is
                not available for binary assets.
              </p>
            </div>
          </div>
        ) : previewMode ? (
          <div className="min-h-0 flex-1 overflow-auto rounded-b-lg bg-[#0d0f14] p-2" style={{ scrollbarWidth: "thin" }}>
            <SyntaxHighlighter
              language={languageForPath(selectedPath)}
              style={oneDark}
              wrapLongLines
              customStyle={{ margin: 0, background: "transparent", fontSize: "0.75rem", lineHeight: 1.5 }}
            >
              {activeSaved || "(empty file)"}
            </SyntaxHighlighter>
            <p className="px-1 pb-1 pt-2 text-[10px] text-white/50">Saved content — switch to Edit for the working copy.</p>
          </div>
        ) : showDiff && diffLines ? (
          <div className="min-h-0 flex-1 overflow-auto bg-[#0d0f14] p-2" style={{ scrollbarWidth: "thin" }}>
            <p className="pb-1.5 text-[10px] text-white/50">
              Unsaved changes vs saved content — {diffLines.filter((l) => l.type === "add").length} added /{" "}
              {diffLines.filter((l) => l.type === "del").length} removed line(s). Switch to Edit to keep editing, Save to
              write them to the project.
            </p>
            <div className="font-mono text-[11px] leading-relaxed">
              {diffLines.map((line, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "whitespace-pre-wrap break-all px-2",
                    line.type === "add" && "bg-emerald-500/10 text-emerald-300",
                    line.type === "del" && "bg-red-500/10 text-red-300",
                    line.type === "ctx" && "text-white/60"
                  )}
                >
                  <span className="select-none pr-2 text-white/30">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
                  {line.text || " "}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <GiftzCodeEditor
            value={activeDraft}
            language={activeLanguage}
            onChange={(next) => setDraftMap((m) => (selectedPath ? { ...m, [selectedPath]: next } : m))}
            onSave={() => void save()}
            jumpTo={jumpTo}
            onReady={(api) => {
              editorApiRef.current = api;
            }}
            ariaLabel={`File content — ${selectedPath}`}
          />
        )}

        {fileMetaFor(selectedPath, metaMap) && (
          <p className="shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", SOURCE_DOT[fileMetaFor(selectedPath, metaMap)!.source] ?? "bg-muted-foreground/40")}
              />
              {fileMetaFor(selectedPath, metaMap)!.source} · {fileMetaFor(selectedPath, metaMap)!.encoding} ·{" "}
              {(fileMetaFor(selectedPath, metaMap)!.sizeBytes / 1024).toFixed(1)} KB · updated{" "}
              {new Date(fileMetaFor(selectedPath, metaMap)!.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </p>
        )}
      </div>

      {/* New file dialog */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">New file</DialogTitle>
            <DialogDescription>
              A relative path inside the project — folders are created implicitly (for example{" "}
              <span className="font-mono">assets/app.js</span>).
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newPath}
            onChange={(e) => {
              setNewPath(e.target.value);
              setNewError(projectPathError(e.target.value));
            }}
            placeholder="assets/app.js"
            aria-label="New file path"
            aria-invalid={newError ? true : undefined}
            className="h-9 font-mono text-xs"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void createFile();
            }}
          />
          {newError && (
            <p className="text-[11px] text-destructive" role="alert">
              {newError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createFile()} disabled={creating || Boolean(newError) || newPath.trim().length === 0}>
              {creating ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FilePlus2 className="size-4" aria-hidden />} Create file
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Rename file</DialogTitle>
            <DialogDescription>
              Move or rename <span className="break-all font-mono">{selectedPath}</span>. The destination must not already exist.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameTo}
            onChange={(e) => {
              setRenameTo(e.target.value);
              setRenameError(projectPathError(e.target.value));
            }}
            aria-label="New path"
            aria-invalid={renameError ? true : undefined}
            className="h-9 font-mono text-xs"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
            }}
          />
          {renameError && (
            <p className="text-[11px] text-destructive" role="alert">
              {renameError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submitRename()} disabled={renaming || Boolean(renameError)}>
              {renaming ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Pencil className="size-4" aria-hidden />} Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Delete file</DialogTitle>
            <DialogDescription>
              Permanently delete <span className="break-all font-mono">{selectedPath}</span> from this generated website? A
              version snapshot of the current tree is kept, so the file stays recoverable from Version history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Keep file
            </Button>
            <Button variant="destructive" onClick={() => void submitDelete()} disabled={deleting}>
              {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />} Delete file
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close-dirty-tab confirmation */}
      <Dialog open={closeTabConfirm !== null} onOpenChange={(open) => !open && setCloseTabConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Unsaved changes</DialogTitle>
            <DialogDescription>
              <span className="break-all font-mono">{closeTabConfirm}</span> has unsaved changes. Close the tab and discard
              them?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseTabConfirm(null)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const path = closeTabConfirm;
                setCloseTabConfirm(null);
                if (!path) return;
                setTabs((prev) => prev.filter((p) => p !== path));
                setSelectedPath((prev) => (prev === path ? tabs.find((p) => p !== path) ?? null : prev));
              }}
            >
              Discard and close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Project-wide search */}
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-display">Find in project</DialogTitle>
            <DialogDescription>Case-insensitive text search across the project&apos;s text files (≤40 results).</DialogDescription>
          </DialogHeader>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void runProjectSearch();
            }}
          >
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search text…"
              aria-label="Search query"
              className="h-9 text-xs"
              autoFocus
            />
            <Button type="submit" size="sm" className="h-9 px-3" disabled={searching || searchQuery.trim().length === 0}>
              {searching ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Search className="size-3.5" aria-hidden />} Search
            </Button>
          </form>
          {searchError ? (
            <p className="text-[11px] text-destructive" role="alert">
              {searchError}
            </p>
          ) : null}
          {searchResults !== null ? (
            searchResults.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No matches found.</p>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-md border border-border/60" style={{ scrollbarWidth: "thin" }}>
                {searchTruncated ? (
                  <p className="border-b border-border/60 px-2 py-1 text-[10px] text-amber-600 dark:text-amber-400">
                    Results capped at 40 matches — refine the query to see more.
                  </p>
                ) : null}
                <ul>
                  {searchResults.map((match, i) => (
                    <li key={`${match.path}:${match.line}:${i}`} className="border-b border-border/40 last:border-b-0">
                      <button
                        type="button"
                        className="flex w-full items-baseline gap-2 px-2 py-1 text-left transition-colors hover:bg-accent/60"
                        onClick={() => {
                          setSearchOpen(false);
                          openFileAt(match.path, match.line);
                        }}
                      >
                        <span className="shrink-0 font-mono text-[10px] text-primary">{match.path}:{match.line}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">{match.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSearchOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Meta lookup helper (typed, avoids repeated map indexing in JSX). */
function fileMetaFor(
  path: string | null,
  metaMap: Record<string, GiftzProjectFileDTO | null>
): GiftzProjectFileDTO | null {
  if (!path) return null;
  return metaMap[path] ?? null;
}
