"use client";

/**
 * GiftzVersionDialog — version history for the GIFTZ generated website
 * (contract §8): snapshot list, compare, and restore.
 *
 * · List: label, source badge (ai / user / publish / restore / auto), created
 *   time, file count.
 * · "Diff vs current": real unified patches from
 *   GET /versions/[id]/diff — expandable <pre> rows colored like the legacy
 *   diff viewer (added emerald / removed red).
 * · Compare: pick any two snapshots — the changed-path inventory is computed
 *   from the two version file lists (path-level, honest about what the API
 *   exposes; content patches exist only against the current tree).
 * · Restore: confirmation first (the working tree is replaced; unsaved canvas
 *   edits are lost), then POST /versions/[id]/restore + onRestored().
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, RotateCcw, Scale, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getSiteVersion,
  getVersionDiff,
  listSiteVersions,
  restoreSiteVersion,
  type GiftzVersionChangedFileDTO,
  type GiftzVersionDTO,
} from "@/lib/giftz-client";
import { cn } from "@/lib/utils";

const SOURCE_BADGE: Record<string, string> = {
  ai: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  user: "border-primary/40 bg-gold-soft text-primary",
  publish: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  restore: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  auto: "border-border/60 bg-muted/40 text-muted-foreground",
};

/** Unified-diff line coloring — legacy GiftzView DiffViewer palette. */
function patchLineClass(line: string): string {
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-200";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-200";
  if (line.startsWith("@@")) return "text-primary";
  return "text-muted-foreground";
}

function PatchView({ patch }: { patch: string }) {
  return (
    <pre className="max-h-56 overflow-auto rounded border border-border/50 bg-[#0d0f14] p-2 font-mono text-[11px] leading-snug" style={{ scrollbarWidth: "thin" }}>
      {patch.split("\n").map((line, i) => (
        <span key={i} className={cn("block whitespace-pre-wrap break-all px-1", patchLineClass(line))}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

interface PathChange {
  path: string;
  action: "added" | "removed" | "modified";
}

export function GiftzVersionDialog({
  open,
  onOpenChange,
  siteId,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  /** Fired after a successful restore — the parent reloads site + files + config. */
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<GiftzVersionDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diff, setDiff] = useState<GiftzVersionChangedFileDTO[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [compareMode, setCompareMode] = useState(false);
  const [compareA, setCompareA] = useState<string | null>(null);
  const [compareB, setCompareB] = useState<string | null>(null);
  const [compareResult, setCompareResult] = useState<PathChange[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const [restoreTarget, setRestoreTarget] = useState<GiftzVersionDTO | null>(null);
  const [restoring, setRestoring] = useState(false);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listSiteVersions(siteId);
      setVersions(r.versions);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load versions");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    if (!open) return;
    setDiffFor(null);
    setDiff(null);
    setCompareMode(false);
    setCompareA(null);
    setCompareB(null);
    setCompareResult(null);
    void loadVersions();
  }, [open, loadVersions]);

  const loadDiff = async (versionId: string) => {
    if (diffFor === versionId && diff) {
      setDiffFor(null);
      setDiff(null);
      return;
    }
    setDiffFor(versionId);
    setDiffLoading(true);
    setDiffError(null);
    setExpanded(new Set());
    setCompareResult(null);
    try {
      const r = await getVersionDiff(siteId, versionId);
      setDiff(r.changed);
    } catch (e) {
      setDiffError(e instanceof Error ? e.message : "Could not load the diff");
    } finally {
      setDiffLoading(false);
    }
  };

  const runCompare = async () => {
    if (!compareA || !compareB) return;
    setComparing(true);
    setCompareError(null);
    setDiffFor(null);
    setDiff(null);
    try {
      const [a, b] = await Promise.all([getSiteVersion(siteId, compareA), getSiteVersion(siteId, compareB)]);
      const aPaths = new Map(a.version.files.map((f) => [f.path, f.sizeBytes]));
      const bPaths = new Map(b.version.files.map((f) => [f.path, f.sizeBytes]));
      const changes: PathChange[] = [];
      for (const [path, size] of bPaths) {
        if (!aPaths.has(path)) changes.push({ path, action: "added" });
        else if (aPaths.get(path) !== size) changes.push({ path, action: "modified" });
      }
      for (const path of aPaths.keys()) {
        if (!bPaths.has(path)) changes.push({ path, action: "removed" });
      }
      changes.sort((x, y) => x.path.localeCompare(y.path));
      setCompareResult(changes);
    } catch (e) {
      setCompareError(e instanceof Error ? e.message : "Could not compare the selected versions");
    } finally {
      setComparing(false);
    }
  };

  const pickCompare = (id: string) => {
    setCompareResult(null);
    if (compareA === id) {
      setCompareA(null);
      return;
    }
    if (compareB === id) {
      setCompareB(null);
      return;
    }
    if (!compareA) {
      setCompareA(id);
      return;
    }
    setCompareB(id);
  };

  const submitRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const r = await restoreSiteVersion(siteId, restoreTarget.id);
      toast.success("Version restored", { description: `${r.fileCount} files written — the previous tree was snapshotted.` });
      setRestoreTarget(null);
      onOpenChange(false);
      onRestored();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not restore this version");
    } finally {
      setRestoring(false);
    }
  };

  const versionLabel = (id: string | null) => versions?.find((v) => v.id === id)?.label ?? "snapshot";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Version history</DialogTitle>
            <DialogDescription>
              Snapshots are taken automatically on saves, AI applies, publishes and restores. Restoring replaces the working
              tree — a snapshot of what you are leaving behind is always kept.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => {
                setCompareMode((c) => !c);
                setCompareA(null);
                setCompareB(null);
                setCompareResult(null);
                setCompareError(null);
              }}
            >
              <Scale className="size-3" aria-hidden /> {compareMode ? "Exit compare" : "Compare versions"}
            </Button>
            {compareMode && (
              <p className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground">
                {compareA ? `A: ${versionLabel(compareA)}` : "Pick version A"} · {compareB ? `B: ${versionLabel(compareB)}` : "pick version B"}
              </p>
            )}
          </div>

          <div className="max-h-96 space-y-1.5 overflow-y-auto pr-0.5" style={{ scrollbarWidth: "thin" }}>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading versions…
              </div>
            ) : loadError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5" role="alert">
                <p className="flex items-start gap-1.5 text-[11px] leading-snug text-destructive">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {loadError}
                </p>
                <Button variant="outline" size="sm" className="mt-2 h-7 px-2 text-[11px]" onClick={() => void loadVersions()}>
                  Retry
                </Button>
              </div>
            ) : versions && versions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No versions yet — the first snapshot appears when this website is saved.
              </p>
            ) : (
              versions?.map((v) => (
                <div key={v.id} className="rounded-md border border-border/60 p-2.5">
                  <div className="flex items-center gap-2">
                    {compareMode && (
                      <span className="flex shrink-0 gap-0.5">
                        <button
                          type="button"
                          onClick={() => pickCompare(v.id)}
                          aria-pressed={compareA === v.id || compareB === v.id}
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase transition-colors",
                            compareA === v.id || compareB === v.id
                              ? "border-primary/40 bg-gold-soft text-primary"
                              : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground"
                          )}
                          title="Select for compare"
                        >
                          {compareA === v.id ? "A" : compareB === v.id ? "B" : "pick"}
                        </button>
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5">
                        <span className="min-w-0 truncate text-xs font-medium">{v.label}</span>
                        <Badge variant="outline" className={cn("shrink-0 px-1 py-0 text-[9px] uppercase", SOURCE_BADGE[v.source] ?? SOURCE_BADGE.auto)}>
                          {v.source}
                        </Badge>
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {new Date(v.createdAt).toLocaleString()} · {v.fileCount} {v.fileCount === 1 ? "file" : "files"}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => void loadDiff(v.id)}>
                      {diffFor === v.id ? "Hide diff" : "Diff vs current"}
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1 px-2 text-[11px]" onClick={() => setRestoreTarget(v)}>
                      <RotateCcw className="size-3" aria-hidden /> Restore
                    </Button>
                  </div>

                  {diffFor === v.id && (
                    <div className="mt-2 border-t border-border/50 pt-2">
                      {diffLoading ? (
                        <p className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground" role="status">
                          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Computing diff…
                        </p>
                      ) : diffError ? (
                        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-destructive" role="alert">
                          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {diffError}
                        </p>
                      ) : diff && diff.length === 0 ? (
                        <p className="py-1 text-[11px] text-muted-foreground">Identical to the current working tree.</p>
                      ) : (
                        <ul className="space-y-1">
                          {diff?.map((c) => {
                            const isOpen = expanded.has(c.path);
                            return (
                              <li key={c.path} className="rounded border border-border/50 bg-muted/20">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpanded((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(c.path)) next.delete(c.path);
                                      else next.add(c.path);
                                      return next;
                                    })
                                  }
                                  aria-expanded={isOpen}
                                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
                                >
                                  <ChevronDown className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isOpen ? "rotate-180" : "")} aria-hidden />
                                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{c.path}</span>
                                  <span
                                    className={cn(
                                      "shrink-0 text-[9px] font-semibold uppercase tracking-wide",
                                      c.action === "added"
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : c.action === "removed"
                                          ? "text-destructive"
                                          : "text-primary"
                                    )}
                                  >
                                    {c.action}
                                  </span>
                                </button>
                                {isOpen && (c.patch ? <div className="px-2 pb-2"><PatchView patch={c.patch} /></div> : (
                                  <p className="px-2 pb-2 text-[10px] text-muted-foreground">No text patch available for this file (binary or metadata-only change).</p>
                                ))}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {compareMode && (
            <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5">
              {comparing ? (
                <p className="flex items-center gap-2 text-[11px] text-muted-foreground" role="status">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden /> Comparing snapshots…
                </p>
              ) : compareError ? (
                <p className="flex items-start gap-1.5 text-[11px] leading-snug text-destructive" role="alert">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {compareError}
                </p>
              ) : compareResult ? (
                compareResult.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">The two snapshots contain the same file paths at the same sizes.</p>
                ) : (
                  <ul className="max-h-40 space-y-0.5 overflow-y-auto" style={{ scrollbarWidth: "thin" }} aria-label="Changed paths between the two versions">
                    {compareResult.map((c) => (
                      <li key={`${c.action}-${c.path}`} className="flex items-center gap-1.5 text-[11px]">
                        <span
                          className={cn(
                            "shrink-0 font-semibold uppercase tracking-wide",
                            c.action === "added"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : c.action === "removed"
                                ? "text-destructive"
                                : "text-primary"
                          )}
                        >
                          {c.action}
                        </span>
                        <span className="min-w-0 truncate font-mono">{c.path}</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Pick two snapshots above, then compare. Size-based compare is path-level — content patches are available per version via
                  “Diff vs current”.
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7 gap-1.5 px-2 text-[11px]"
                onClick={() => void runCompare()}
                disabled={!compareA || !compareB || comparing}
              >
                <Scale className="size-3" aria-hidden /> Compare A → B
              </Button>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* restore confirmation */}
      <Dialog open={restoreTarget !== null} onOpenChange={(v) => (!v ? setRestoreTarget(null) : undefined)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Restore this version?</DialogTitle>
            <DialogDescription>
              Restoring <span className="font-medium">{restoreTarget?.label}</span> replaces the current working tree —{" "}
              {restoreTarget?.fileCount ?? 0} files will be written. Unsaved canvas edits are lost. A snapshot of the tree you
              are leaving is created automatically, so this stays reversible from this same history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => void submitRestore()} disabled={restoring}>
              {restoring ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />} Restore version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
