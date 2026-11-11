"use client";

/**
 * SaveControls — the header's save-state cluster, SCOPED TO ONE STUDIO MODE.
 *
 * The two Website Studio modes have fully independent save workflows:
 *
 *   - Customization: primary "Save changes" + Revert + Restore. Status
 *     reflects the Customization save lifecycle (Unsaved changes / Saving… /
 *     Saved HH:MM / Save failed).
 *   - CODE GIFTZ: primary "Save Draft" (saves the generated website when one
 *     is previewed, else the draft) + Discard + Restore. Status reflects the
 *     CODE GIFTZ save lifecycle, including the isolated-proposal state.
 *
 * Only the ACTIVE mode's cluster is rendered by the parent, so there is never
 * a duplicate Save button and never a shared save state. The publish workflow
 * stays a separate, explicit approval path. All copy is honest: a failed save
 * keeps the dirty state and surfaces "Save failed" — the badge never claims
 * "Saved".
 */

import { useState } from "react";
import {
  Check,
  CloudUpload,
  History,
  Loader2,
  RotateCcw,
  TriangleAlert,
  Undo2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type StudioSaveMode = "customization" | "giftz";

/** Per-mode save lifecycle, tracked independently by the parent. */
export interface ModeSaveStatus {
  state: "idle" | "saving" | "saved" | "failed";
  /** Completion time of the last successful save (epoch ms) — shown as "Saved HH:MM". */
  at: number | null;
}

export interface SaveControlsProps {
  /** Which studio mode this cluster belongs to (drives labels + status copy). */
  mode: StudioSaveMode;
  dirty: boolean;
  status: ModeSaveStatus;
  publishing: boolean;
  hasPublished: boolean;
  /** Published but the saved draft differs from the live snapshot. */
  draftAheadOfLive: boolean;
  /** A chat proposal is currently rendered in the isolated preview. */
  proposalActive: boolean;
  /** Human-readable unsaved-change list for the badge popover. */
  unsavedChanges: string[];
  /** CODE GIFTZ draft safety: confirm before a generated website is saved. */
  confirmBeforeSave?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onOpenRevisions: () => void;
  onPublishRequest: () => void;
  onUnpublish: () => void;
}

function clockLabel(at: number | null): string {
  if (!at) return "";
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function SaveControls({
  mode,
  dirty,
  status,
  publishing,
  hasPublished,
  draftAheadOfLive,
  proposalActive,
  unsavedChanges,
  confirmBeforeSave = false,
  onSave,
  onDiscard,
  onOpenRevisions,
  onPublishRequest,
  onUnpublish,
}: SaveControlsProps) {
  const [discardOpen, setDiscardOpen] = useState(false);
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);

  const showDiscard = proposalActive || dirty;
  const saving = status.state === "saving";

  const savedClock = clockLabel(status.at);
  const saveLabel = mode === "giftz" ? "Save Draft" : "Save changes";

  let badge: { label: string; className: string; dot?: "amber" | "green" | "red"; icon?: React.ReactNode } | null = null;
  if (status.state === "failed") {
    badge = {
      label: "Save failed — try again",
      className: "border-destructive/40 bg-destructive/10 text-destructive",
      icon: <TriangleAlert className="size-3" aria-hidden />,
    };
  } else if (saving) {
    badge = {
      label: "Saving…",
      className: "border-border/60 bg-muted/40 text-muted-foreground",
      icon: <Loader2 className="size-3 animate-spin" aria-hidden />,
    };
  } else if (proposalActive) {
    badge = {
      label: "Previewing — not saved",
      className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      icon: <TriangleAlert className="size-3" aria-hidden />,
    };
  } else if (dirty) {
    badge = {
      label: "Unsaved changes",
      className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      dot: "amber",
    };
  } else if (status.state === "saved" && savedClock) {
    badge = {
      label: `Saved ${savedClock}`,
      className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      icon: <Check className="size-3" aria-hidden />,
    };
  } else if (hasPublished) {
    badge = {
      label: draftAheadOfLive ? "Published · draft ahead of live" : "Published",
      className: draftAheadOfLive
        ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      icon: draftAheadOfLive ? <TriangleAlert className="size-3" aria-hidden /> : <Check className="size-3" aria-hidden />,
    };
  } else {
    badge = {
      label: "Saved",
      className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      icon: <Check className="size-3" aria-hidden />,
    };
  }

  const badgeTitle = proposalActive
    ? "The canvas shows an isolated proposal preview — Save Draft keeps it, Discard returns to your draft"
    : status.state === "failed"
      ? "The last save did not go through — your changes are still on the canvas"
      : hasPublished && draftAheadOfLive
        ? "The live website shows an older snapshot — republish to update it"
        : hasPublished
          ? "The live website matches your saved draft"
          : mode === "giftz"
            ? "Your draft is saved — Save Draft keeps generated websites"
            : "Your draft is saved — publish to make it public";

  function requestSave() {
    if (confirmBeforeSave && proposalActive) {
      setSaveConfirmOpen(true);
      return;
    }
    onSave();
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* state badge — click lists the unsaved changes when dirty */}
      {dirty && !proposalActive && unsavedChanges.length > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent/60", badge.className)}
              aria-label={`${badge.label} — show what changed`}
              title="Show the unsaved changes"
            >
              {badge.icon ?? <span className={cn("size-1.5 rounded-full", badge.dot === "amber" ? "bg-amber-500" : "bg-emerald-500")} aria-hidden />}
              {badge.label}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-3">
            <p className="text-xs font-semibold">Unsaved changes ({unsavedChanges.length})</p>
            <ul className="mt-1.5 max-h-48 list-inside list-disc space-y-0.5 overflow-y-auto text-[11px] text-muted-foreground" style={{ scrollbarWidth: "thin" }}>
              {unsavedChanges.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : (
        <span
          className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium", badge.className)}
          role="status"
          title={badgeTitle}
        >
          {badge.icon ?? <span className={cn("size-1.5 rounded-full", badge.dot === "amber" ? "bg-amber-500" : badge.dot === "red" ? "bg-destructive" : "bg-emerald-500")} aria-hidden />}
          {badge.label}
        </span>
      )}

      {/* THE mode's primary save action — one per mode, never duplicated */}
      <Button
        variant="outline"
        size="sm"
        className="h-8"
        onClick={requestSave}
        disabled={saving || (!dirty && !proposalActive)}
        title={mode === "giftz" ? "Save your draft — keeps the generated website when one is previewed" : "Save your draft (private until you publish)"}
      >
        {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
        {saveLabel}
      </Button>

      {/* Discard / Revert — only when there is something to discard */}
      {showDiscard && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-muted-foreground hover:text-destructive"
          onClick={() => setDiscardOpen(true)}
          title={proposalActive ? "Discard the proposal preview and return to your draft" : "Revert your draft to the last saved version"}
        >
          <Undo2 className="size-4" aria-hidden />
          <span className="hidden 2xl:inline">{mode === "giftz" ? "Discard" : "Revert"}</span>
        </Button>
      )}

      {/* Restore previous — server-side revisions */}
      <Button variant="ghost" size="sm" className="h-8" onClick={onOpenRevisions} title="Restore a previous saved version">
        <History className="size-4" aria-hidden />
        <span className="hidden 2xl:inline">Restore</span>
      </Button>

      {/* Publish / Republish — the SEPARATE, explicit approval workflow */}
      <Button
        variant="outline"
        size="sm"
        className="h-8 border-primary/40 text-primary hover:bg-gold-soft/60 hover:text-primary"
        onClick={onPublishRequest}
        disabled={publishing}
        title={hasPublished ? "Review and update the live website with your saved draft" : "Review and publish your saved draft to your public URL"}
      >
        {publishing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CloudUpload className="size-4" aria-hidden />}
        {hasPublished ? "Republish" : "Publish"}
      </Button>

      {/* Unpublish */}
      {hasPublished && (
        <Button variant="ghost" size="sm" className="h-8 text-muted-foreground hover:text-destructive" onClick={() => setUnpublishOpen(true)} title="Take the website offline — your draft is kept">
          Unpublish
        </Button>
      )}

      {/* Save confirm (CODE GIFTZ draft safety — replaces the draft with the generated website) */}
      <AlertDialog open={saveConfirmOpen} onOpenChange={setSaveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save this generated website as your draft?</AlertDialogTitle>
            <AlertDialogDescription>
              The isolated preview becomes your saved draft — replacing the current one (a snapshot of it is kept in
              “Restore”). Your published site only changes when you publish again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setSaveConfirmOpen(false);
                onSave();
              }}
            >
              <Check className="size-4" aria-hidden /> Save Draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Discard confirm */}
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{proposalActive ? "Discard this proposal preview?" : "Discard unsaved changes?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {proposalActive
                ? "The canvas returns to your current draft. The proposal stays in the conversation — you can preview it again from the chat."
                : "Your draft reverts to the last saved version. Unsaved changes from this device are removed and cannot be recovered."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep changes</AlertDialogCancel>
            <AlertDialogAction
              className={cn("bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              onClick={() => {
                setDiscardOpen(false);
                onDiscard();
              }}
            >
              <RotateCcw className="size-4" aria-hidden /> Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unpublish confirm */}
      <AlertDialog open={unpublishOpen} onOpenChange={setUnpublishOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take the website offline?</AlertDialogTitle>
            <AlertDialogDescription>
              Visitors will see your standard profile again. Your draft and its saved versions are kept — republish any
              time to put the website back online.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it online</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setUnpublishOpen(false);
                onUnpublish();
              }}
            >
              Unpublish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
