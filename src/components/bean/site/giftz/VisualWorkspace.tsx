"use client";

/**
 * VisualWorkspace — the GIFTZ "Design" tab (M3/M4): the GrapesJS-based visual
 * editor operating on the site's REAL project files.
 *
 * Contract (spec Part E §14):
 * - ONE editor instance per mount, built from a client-only dynamic import,
 *   fully destroyed on unmount or page switch — no instance or state leaks
 *   between projects or accounts.
 * - Load: the selected page's HTML + its ONE linked stylesheet (or inline
 *   styles) — eligibility is decided by round-trip.ts; ineligible pages show
 *   the honest reason and keep the Code workspace fully usable.
 * - Save: exported HTML/CSS flow back through the EXISTING
 *   PUT /api/giftz/sites/:id/files/content (source "user") — the same
 *   validation, version snapshots and activity recording as every other
 *   file write. `site.config.json` is never touched here (S2 stays with the
 *   code editor / chat).
 * - Source reconciliation: file timestamps are captured at load; before a
 *   save lands, the tree is re-fetched and any file changed meanwhile (GIFTZ
 *   AI agent, Code workspace, version restore) BLOCKS the save with a
 *   reconciliation prompt — stale visual edits never overwrite newer code.
 * - Publish stays in the header (the existing pipeline); this tab never
 *   deploys anything by itself.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Monitor, Redo2, Save, Smartphone, Tablet, TriangleAlert, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { readSiteFile, listSiteFiles, writeSiteFile, type GiftzProjectFileDTO } from "@/lib/giftz-client";
import { analyzePageStyles, buildVisualSavePayload, reconstructDocument, type PageStyleAnalysis } from "@/lib/giftz/visual-editor/round-trip";
import { createBeanVisualEditor, exportBeanVisualProject } from "@/lib/giftz/visual-editor/grapesjs-config";
import type { Editor } from "grapesjs";

interface VisualWorkspaceProps {
  siteId: string;
  /** Bumped by the parent when files change elsewhere (agent/code saves). */
  refreshToken: number;
}

type DeviceKey = "desktop" | "tablet" | "mobile";
const DEVICE_WIDTHS: Record<DeviceKey, string> = { desktop: "100%", tablet: "768px", mobile: "390px" };

export default function VisualWorkspace({ siteId, refreshToken }: VisualWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [files, setFiles] = useState<GiftzProjectFileDTO[] | null>(null);
  const [pagePath, setPagePath] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PageStyleAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [device, setDevice] = useState<DeviceKey>("desktop");
  const [editorReady, setEditorReady] = useState(false);
  /** updatedAt per touched path captured at load — the reconciliation baseline. */
  const loadBaselineRef = useRef<Map<string, string>>(new Map());
  /** The editor's current page/analysis + original content (for the save path). */
  const currentRef = useRef<{ pagePath: string; analysis: PageStyleAnalysis; originalHtml: string } | null>(null);

  const htmlPages = useMemo(
    () => (files ?? []).filter((f) => f.path.endsWith(".html") && f.encoding === "utf8").sort((a, b) => {
      if (a.path === "index.html") return -1;
      if (b.path === "index.html") return 1;
      return a.path.localeCompare(b.path);
    }),
    [files]
  );

  const refreshTree = useCallback(async (): Promise<GiftzProjectFileDTO[] | null> => {
    try {
      const res = await listSiteFiles(siteId);
      setFiles(res.files);
      return res.files;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the project files");
      return null;
    }
  }, [siteId]);

  const mountEditor = useCallback(
    async (html: string, css: string) => {
      const container = containerRef.current;
      if (!container) return;
      // Exactly ONE live instance: destroy any previous editor first.
      if (editorRef.current) {
        try {
          editorRef.current.destroy();
        } catch {
          /* already gone */
        }
        editorRef.current = null;
        setEditorReady(false);
      }
      container.innerHTML = "";
      const host = document.createElement("div");
      host.className = "bean-visual-editor h-full w-full";
      container.appendChild(host);
      const editor = await createBeanVisualEditor(host, {
        html,
        css,
        onChange: () => setDirty(true),
      });
      editorRef.current = editor;
      setEditorReady(true);
      setDirty(false);
    },
    []
  );

  const loadPage = useCallback(
    async (path: string) => {
      setLoading(true);
      setLoadError(null);
      setAnalysis(null);
      setEditorReady(false);
      try {
        const [pageRes, tree] = await Promise.all([readSiteFile(siteId, path), refreshTree()]);
        const pageContent = pageRes.file.content ?? "";
        const pageAnalysis = analyzePageStyles(pageContent, path);
        setAnalysis(pageAnalysis);
        currentRef.current = { pagePath: path, analysis: pageAnalysis, originalHtml: pageContent };

        // Reconciliation baseline: EVERY file the save would touch.
        const baseline = new Map<string, string>();
        baseline.set(path, pageRes.file.updatedAt);
        if (pageAnalysis.editable && pageAnalysis.stylesheetPath) {
          const cssRow = tree?.find((f) => f.path === pageAnalysis.stylesheetPath);
          if (cssRow) {
            baseline.set(cssRow.path, cssRow.updatedAt);
          } else {
            setLoading(false);
            setLoadError(
              `The page links ${pageAnalysis.stylesheetPath} but that file is missing from the project — restore it in the Code workspace.`
            );
            return;
          }
        }
        loadBaselineRef.current = baseline;

        if (!pageAnalysis.editable) {
          setLoading(false);
          return;
        }

        let css = "";
        if (pageAnalysis.stylesheetPath) {
          const cssRes = await readSiteFile(siteId, pageAnalysis.stylesheetPath);
          css = cssRes.file.content ?? "";
        } else {
          // Inline-style page: feed the inline blocks as the editor's styles.
          css = (pageContent.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? [])
            .map((block) => block.replace(/<\/?style[^>]*>/gi, ""))
            .join("\n");
        }
        await mountEditor(pageContent, css);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "Could not load the page for visual editing");
      } finally {
        setLoading(false);
      }
    },
    [siteId, mountEditor, refreshTree]
  );

  // Initial load: pick index.html (or the first page) whenever the tree changes shape.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tree = await refreshTree();
      if (cancelled || !tree) return;
      const pages = tree.filter((f) => f.path.endsWith(".html") && f.encoding === "utf8");
      if (pages.length === 0) {
        setLoading(false);
        setLoadError("No HTML pages in this project yet — generate a website first, then edit it visually.");
        return;
      }
      const preferred = pages.find((p) => p.path === "index.html") ?? pages[0];
      setPagePath(preferred.path);
      await loadPage(preferred.path);
    })();
    return () => {
      cancelled = true;
    };
    // refreshToken deliberately NOT in deps: external changes surface via the
    // reconciliation check at save time (a silent mid-edit reload would lose
    // the creator's visual work).
  }, [siteId]);

  // Unmount / project switch: destroy the editor (no leaks).
  useEffect(() => {
    const editor = editorRef.current;
    return () => {
      if (editorRef.current) {
        try {
          editorRef.current.destroy();
        } catch {
          /* already destroyed */
        }
        editorRef.current = null;
      }
      void editor;
    };
  }, [siteId]);

  const applyDevice = useCallback(
    (key: DeviceKey) => {
      setDevice(key);
      const editor = editorRef.current;
      if (!editor) return;
      try {
        const dm = editor.Devices;
        const name = key === "desktop" ? "Desktop" : key === "tablet" ? "Tablet" : "Mobile";
        const existing = dm.getDevices().find((d) => String(d.getName()) === name);
        if (existing) {
          dm.select(String(existing.id));
        } else {
          dm.select(String(dm.add({ name, width: DEVICE_WIDTHS[key] }).id));
        }
      } catch {
        /* device switching is cosmetic — never block editing */
      }
    },
    []
  );

  const reconcile = useCallback(async (): Promise<{ ok: boolean; changedPaths: string[] }> => {
    const res = await listSiteFiles(siteId);
    const changedPaths: string[] = [];
    for (const [path, atLoad] of loadBaselineRef.current.entries()) {
      const row = res.files.find((f) => f.path === path);
      if (row && row.updatedAt !== atLoad) changedPaths.push(path);
      if (!row) changedPaths.push(path);
    }
    return { ok: changedPaths.length === 0, changedPaths };
  }, [siteId]);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    const current = currentRef.current;
    if (!editor || !current || saving) return;
    setSaving(true);
    try {
      // 1. Reconcile FIRST — stale visual edits never overwrite newer code.
      const { ok, changedPaths } = await reconcile();
      if (!ok) {
        toast.error("Files changed elsewhere since you opened the visual editor", {
          description: `${changedPaths.join(", ")} was updated by the AI agent, the Code workspace or a version restore. Refresh the visual editor to load the latest files, then re-apply your changes.`,
          duration: 10_000,
        });
        return;
      }
      // 2. Export and rebuild the real document: head verbatim + edited body
      //    + scripts re-injected (PoC-verified preservation contract).
      const exported = exportBeanVisualProject(editor);
      const reconstructed = reconstructDocument(current.originalHtml, exported.html);
      const payload = buildVisualSavePayload(reconstructed.html, exported.css, current.analysis);
      // 3. Write through the EXISTING validated file API (source "user";
      //    the server snapshots a project version on each write).
      await writeSiteFile(siteId, current.pagePath, payload.html);
      if (payload.cssPath && payload.css !== null) {
        await writeSiteFile(siteId, payload.cssPath, payload.css);
      }
      // 4. Refresh the baseline so subsequent saves reconcile cleanly.
      const tree = await refreshTree();
      const baseline = new Map<string, string>();
      for (const path of [current.pagePath, ...(payload.cssPath ? [payload.cssPath] : [])]) {
        const row = tree?.find((f) => f.path === path);
        if (row) baseline.set(path, row.updatedAt);
      }
      loadBaselineRef.current = baseline;
      setDirty(false);
      toast.success("Visual changes saved to the project files", {
        description:
          reconstructed.reattachedScripts > 0
            ? `${reconstructed.reattachedScripts} script tag(s) preserved verbatim. Preview, build and publish from the other tabs.`
            : "Preview, build and publish from the other tabs — publishing uses the same verified pipeline.",
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the visual changes");
    } finally {
      setSaving(false);
    }
  }, [editorReady, reconcile, siteId, saving]);

  // Cmd/Ctrl+S saves (same contract as the Code workspace).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {htmlPages.length > 1 ? (
          <select
            aria-label="Page to edit visually"
            value={pagePath ?? ""}
            onChange={(e) => {
              setPagePath(e.target.value);
              void loadPage(e.target.value);
            }}
            className="h-8 rounded-lg border border-border/60 bg-background/60 px-2 text-xs text-foreground"
          >
            {htmlPages.map((p) => (
              <option key={p.path} value={p.path}>
                {p.path}
              </option>
            ))}
          </select>
        ) : (
          <span className="rounded-md border border-border/60 bg-muted/30 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {pagePath ?? "index.html"}
          </span>
        )}
        <div className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/60 p-0.5" role="group" aria-label="Preview device">
          {(["desktop", "tablet", "mobile"] as DeviceKey[]).map((key) => {
            const Icon = key === "desktop" ? Monitor : key === "tablet" ? Tablet : Smartphone;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={device === key}
                aria-label={`${key} preview width`}
                onClick={() => applyDevice(key)}
                className={`rounded-md p-1.5 ${device === key ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Icon className="size-3.5" aria-hidden />
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => editorRef.current?.UndoManager.undo()}
          disabled={!editorReady}
          aria-label="Undo visual edit"
        >
          <Undo2 className="size-3.5" aria-hidden /> Undo
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => editorRef.current?.UndoManager.redo()}
          disabled={!editorReady}
          aria-label="Redo visual edit"
        >
          <Redo2 className="size-3.5" aria-hidden /> Redo
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={!editorReady || saving} aria-label="Save visual changes to project files">
          {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />}
          {dirty ? "Save*" : "Save"}
        </Button>
      </div>

      {/* status strip */}
      {loadError ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {loadError}
        </p>
      ) : analysis && !analysis.editable ? (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
          <span>{analysis.notEditableReason}</span>
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Visual editing operates on the real project files — saving writes through the same validated pipeline as the
          Code workspace, and files changed elsewhere block the save until you refresh.
        </p>
      )}

      {/* editor surface */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-black/40">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the visual editor…
          </div>
        ) : (
          <div ref={containerRef} className="h-full w-full" data-testid="bean-visual-editor-root" />
        )}
      </div>
    </div>
  );
}
