"use client";

/**
 * LAXII Resume Studio — M33.5-C versions card.
 *
 * Explicit, bounded revision history for the open resume document:
 *  - "Save version" snapshots the current state (user provenance);
 *  - restore snapshots the CURRENT state first, so restoring never silently
 *    erases a newer document (restore-forward is always possible);
 *  - pinned snapshots are excluded from pruning;
 *  - compare shows a structural diff between the revision and the live
 *    document (facts removed / reworded / reordered — never invented).
 */

import { useCallback, useEffect, useState } from "react";
import { History, Pin, PinOff, Save, Undo2, ArrowLeftRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { laxiiApi, type ResumeData, type ResumeRevisionSummary } from "@/lib/laxii-client";
import { diffResumeDocuments } from "@/lib/laxii/resume-diff";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const OP_LABEL: Record<string, string> = {
  SAVE: "Saved version",
  RESUME_GENERATE: "Before regenerate",
  RESUME_TAILOR: "Before tailoring",
  RESUME_REPHRASE: "Before rephrase",
  TAILOR_COPY: "Tailoring",
  RESTORE: "Before restore",
};

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const mins = Math.max(1, Math.round((Date.now() - d) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function LaxiiResumeVersions({
  conversationId,
  liveData,
  onRestored,
}: {
  conversationId: string;
  liveData: ResumeData;
  onRestored: (resume: ResumeData) => void;
}) {
  const [revisions, setRevisions] = useState<ResumeRevisionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [label, setLabel] = useState("");
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ id: string; data: ResumeData } | null>(null);
  const [expanded, setExpanded] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await laxiiApi.resumeRevisions(conversationId);
      setRevisions(res.revisions);
    } catch {
      setRevisions([]);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function saveVersion() {
    setBusy("save");
    try {
      await laxiiApi.resumeRevisionSave(conversationId, label.trim() || undefined);
      setLabel("");
      await reload();
    } catch {
      // surfaced by toast at call site? keep silent-free: error state below
      setError("Could not save the version.");
    } finally {
      setBusy("");
    }
  }

  // Local error line (kept self-contained instead of toasts for testability).
  const [error, setError] = useState("");

  async function restore(id: string) {
    setBusy(`restore:${id}`);
    setError("");
    try {
      const res = await laxiiApi.resumeRevisionRestore(conversationId, id);
      onRestored(res.resume);
      setConfirmRestore(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed.");
    } finally {
      setBusy("");
    }
  }

  async function togglePin(rev: ResumeRevisionSummary) {
    setBusy(`pin:${rev.id}`);
    try {
      await laxiiApi.resumeRevisionPin(conversationId, rev.id, !rev.pinned);
      await reload();
    } catch {
      setError("Could not update the pin.");
    } finally {
      setBusy("");
    }
  }

  async function openCompare(id: string) {
    setBusy(`compare:${id}`);
    try {
      const res = await laxiiApi.resumeRevisionDetail(conversationId, id);
      setCompare({ id, data: (res as unknown as { data: ResumeData }).data });
    } catch {
      setError("Could not load the revision for compare.");
    } finally {
      setBusy("");
    }
  }

  const visible = expanded ? revisions.slice(0, 30) : revisions.slice(0, 4);
  const diff = compare ? diffResumeDocuments(compare.data, liveData) : null;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5" data-testid="laxii-resume-versions">
      <div className="mb-3 flex min-h-7 items-center gap-2">
        <span className="text-primary"><History className="size-4" aria-hidden /></span>
        <h4 className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Versions</h4>
        {loading ? <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden /> : null}
      </div>

      <div className="flex gap-1.5">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Version name (optional)"
          aria-label="Version name"
          className="h-8 min-w-0 flex-1 border-white/10 bg-white/[0.04] text-[12px]"
        />
        <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1 border-white/15 bg-white/[0.04] text-[11.5px]" onClick={() => void saveVersion()} disabled={busy === "save"} data-testid="laxii-resume-version-save">
          {busy === "save" ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Save className="size-3" aria-hidden />} Save version
        </Button>
      </div>

      {error ? <p className="mt-1.5 text-[11px] text-rose-400" role="alert">{error}</p> : null}

      {revisions.length === 0 && !loading ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          No versions yet — snapshots are also created automatically before tailoring, rephrasing and restores.
        </p>
      ) : null}

      <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto laxii-scroll">
        {visible.map((rev) => (
          <li key={rev.id} className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className={cn("min-w-0 flex-1 truncate text-[11.5px]", rev.pinned ? "text-primary" : "text-foreground/80")}>
                {rev.label || OP_LABEL[rev.operation] || rev.operation}
                {rev.provenance === "ai" ? <span className="ml-1 text-[9.5px] uppercase text-muted-foreground">auto</span> : null}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(rev.createdAt)}</span>
              <button type="button" aria-label={rev.pinned ? "Unpin version" : "Pin version"} onClick={() => void togglePin(rev)} className="text-muted-foreground hover:text-primary" disabled={busy === `pin:${rev.id}`}>
                {rev.pinned ? <Pin className="size-3.5 text-primary" aria-hidden /> : <PinOff className="size-3.5" aria-hidden />}
              </button>
              <button type="button" aria-label={`Compare ${rev.label || "version"} with current`} onClick={() => void openCompare(rev.id)} className="text-muted-foreground hover:text-foreground" disabled={busy === `compare:${rev.id}`}>
                <ArrowLeftRight className="size-3.5" aria-hidden />
              </button>
              {confirmRestore === rev.id ? (
                <span className="flex shrink-0 items-center gap-1">
                  <button type="button" className="rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground" onClick={() => void restore(rev.id)} disabled={busy === `restore:${rev.id}`}>
                    {busy === `restore:${rev.id}` ? "…" : "Confirm"}
                  </button>
                  <button type="button" className="text-[10px] text-muted-foreground" onClick={() => setConfirmRestore(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" aria-label={`Restore ${rev.label || "version"}`} onClick={() => setConfirmRestore(rev.id)} className="text-muted-foreground hover:text-foreground">
                  <Undo2 className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {revisions.length > 4 ? (
        <button type="button" className="mt-1.5 text-[11px] text-primary hover:underline" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `Show all ${revisions.length} versions`}
        </button>
      ) : null}

      {compare && diff ? (
        <div className="mt-2.5 rounded-lg border border-white/10 bg-white/[0.03] p-2.5" data-testid="laxii-resume-version-compare">
          <p className="mb-1 text-[11px] font-semibold text-foreground/80">Compare: selected version → current document</p>
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            {diff.summary.map((s, i) => (
              <li key={i}>· {s}</li>
            ))}
          </ul>
          <button type="button" className="mt-1 text-[10.5px] text-muted-foreground hover:text-foreground" onClick={() => setCompare(null)}>
            Close compare
          </button>
        </div>
      ) : null}

      <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">
        Restoring never erases the current document — it snapshots first, so you can always restore forward. Pinned
        versions are kept even when history is trimmed (max 30).
      </p>
    </div>
  );
}
