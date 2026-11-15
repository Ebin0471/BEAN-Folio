"use client";

/**
 * CodeWorkspace — the GIFTZ "Code" tab (contract §8): the generated website's
 * REAL project file tree plus a code editor.
 *
 * LEFT  — 200px file tree (grouped client-side on "/" segments). Every row
 *         carries a source dot: generated = muted gray, user = gold, ai =
 *         emerald (sr-only labels included).
 * RIGHT — toolbar (path breadcrumb, dirty dot, Save / Revert / New / Rename /
 *         Delete) and the editing surface: a monospace textarea for UTF-8
 *         files with a read-only "Preview" toggle rendering the SAVED content
 *         through react-syntax-highlighter (Prism, oneDark — same import
 *         pattern as the portfolio widgets). Binary (base64) rows get an
 *         honest notice card instead of an editor.
 *
 * Saving writes through PUT /api/giftz/sites/:id/files/content (source becomes
 * "user"). Saving `site.config.json` re-reads the site detail and hands the
 * refreshed config to the parent (onConfigSynced) so the rendered canvas
 * follows the file tree — sync rule S2. Cmd/Ctrl+S saves the open file.
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
  RotateCcw,
  Save,
  Trash2,
  TriangleAlert,
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
  listSiteFiles,
  readSiteFile,
  renameSiteFile,
  writeSiteFile,
  type GiftzProjectFileDTO,
} from "@/lib/giftz-client";
import { normalizeConfig, type SiteConfig } from "@/lib/site-config";
import { cn } from "@/lib/utils";

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

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileMeta, setFileMeta] = useState<GiftzProjectFileDTO | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [savedContent, setSavedContent] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

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
  const dialogOpen = newOpen || renameOpen || deleteOpen;

  const dirty = selectedPath !== null && !binary && draft !== savedContent;

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

  useEffect(() => {
    expandedSeedRef.current = false;
    setSelectedPath(null);
    setFileMeta(null);
    void reloadFiles();
  }, [siteId, refreshToken, reloadFiles]);

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

  // Auto-select index.html (or the first file) when nothing is selected.
  useEffect(() => {
    if (!files) return;
    setSelectedPath((current) => {
      if (current && files.some((f) => f.path === current)) return current;
      return files.find((f) => f.path === "index.html")?.path ?? files[0]?.path ?? null;
    });
  }, [files]);

  // Drop a stale selection when the selected file vanished from the tree.
  useEffect(() => {
    if (!files || !selectedPath) return;
    if (!files.some((f) => f.path === selectedPath)) {
      setSelectedPath(null);
      setFileMeta(null);
    }
  }, [files, selectedPath]);

  // Ref mirror of the tree — loadContent reads it WITHOUT depending on it, so
  // a tree refresh never re-triggers the content effect (which would clobber
  // the user's unsaved draft with the server copy).
  const filesRef = useRef<GiftzProjectFileDTO[] | null>(null);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const loadContent = useCallback(
    async (path: string) => {
      setContentLoading(true);
      setContentError(null);
      setPreviewMode(false);
      try {
        const r = await readSiteFile(siteId, path);
        setBinary(r.binary);
        const content = r.binary ? "" : (r.file.content ?? "");
        setSavedContent(content);
        setDraft(content);
        const meta = filesRef.current?.find((f) => f.path === path) ?? null;
        setFileMeta(
          meta
            ? { ...meta, source: r.file.source, encoding: r.file.encoding, mime: r.file.mime, updatedAt: r.file.updatedAt }
            : null
        );
      } catch (e) {
        setContentError(e instanceof Error ? e.message : "Could not open this file");
        setBinary(false);
        setSavedContent("");
        setDraft("");
      } finally {
        setContentLoading(false);
      }
    },
    [siteId]
  );

  useEffect(() => {
    if (!selectedPath) return;
    void loadContent(selectedPath);
  }, [selectedPath, loadContent]);

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
    if (!selectedPath || binary || saving) return;
    setSaving(true);
    try {
      await writeSiteFile(siteId, selectedPath, draft, "utf8");
      setSavedContent(draft);
      toast.success("File saved");
      await reloadFiles();
      if (selectedPath === "site.config.json") await afterConfigFileSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the file");
    } finally {
      setSaving(false);
    }
  }, [selectedPath, binary, saving, siteId, draft, reloadFiles, afterConfigFileSave]);

  const revert = useCallback(() => {
    if (!selectedPath || binary) return;
    void loadContent(selectedPath);
  }, [selectedPath, binary, loadContent]);

  // Cmd/Ctrl+S saves the open file (skipped while a dialog owns the keyboard).
  useEffect(() => {
    if (!selectedPath || dialogOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (!binary && draft !== savedContent) void save();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedPath, dialogOpen, binary, draft, savedContent, save]);

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
      setSelectedPath(path);
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
      setSelectedPath(to);
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
      setFileMeta(null);
      await reloadFiles();
      toast.success("File deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the file");
    } finally {
      setDeleting(false);
    }
  };

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
      return (
        <li key={node.path}>
          <button
            type="button"
            onClick={() => setSelectedPath(node.path)}
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
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", SOURCE_DOT[node.file?.source ?? "generated"] ?? "bg-muted-foreground/40")}
            />
            <span className="sr-only">{SOURCE_LABEL[node.file?.source ?? "generated"] ?? "generated file"}</span>
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

      {/* RIGHT — toolbar + editor */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5">
          <p className="mr-1 min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={selectedPath ?? undefined}>
            {selectedPath ?? "No file selected"}
            {dirty && (
              <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <span aria-hidden className="size-1.5 rounded-full bg-amber-500" /> unsaved
              </span>
            )}
          </p>
          {selectedPath && !binary && (
            <>
              {/* Edit/Preview toggle — matches the app's mini tab-strip language */}
              <div className="flex rounded-md border border-border/60 p-0.5" role="tablist" aria-label="Editor view">
                {(["edit", "preview"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={previewMode === (v === "preview")}
                    onClick={() => setPreviewMode(v === "preview")}
                    className={cn(
                      "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                      previewMode === (v === "preview") ? "bg-gold-soft text-primary" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {v === "edit" ? "Edit" : "Preview"}
                  </button>
                ))}
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

        {!selectedPath ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            <p className="max-w-xs text-center text-xs leading-relaxed text-muted-foreground">
              Select a file from the tree — generated, edited and AI-written files all live in the same project.
            </p>
          </div>
        ) : contentLoading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4" role="status">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Opening file…
            </p>
          </div>
        ) : contentError ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4" role="alert">
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <TriangleAlert className="size-4" aria-hidden /> {contentError}
            </p>
            <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => void loadContent(selectedPath)}>
              <RefreshCw className="size-3" aria-hidden /> Try again
            </Button>
          </div>
        ) : binary ? (
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
              {savedContent || "(empty file)"}
            </SyntaxHighlighter>
            <p className="px-1 pb-1 pt-2 text-[10px] text-white/50">Saved content — switch to Edit for the working copy.</p>
          </div>
        ) : (
          <label className="flex min-h-0 flex-1 flex-col">
            <span className="sr-only">File content — {selectedPath}</span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="min-h-[220px] w-full flex-1 resize-none bg-[#0d0f14] p-3 font-mono text-xs leading-relaxed text-white/85 outline-none"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  if (dirty) void save();
                }
              }}
            />
          </label>
        )}

        {fileMeta && (
          <p className="shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className={cn("size-1.5 rounded-full", SOURCE_DOT[fileMeta.source] ?? "bg-muted-foreground/40")} />
              {fileMeta.source} · {fileMeta.encoding} · {(fileMeta.sizeBytes / 1024).toFixed(1)} KB · updated{" "}
              {new Date(fileMeta.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
    </div>
  );
}
