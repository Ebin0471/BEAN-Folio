"use client";

/**
 * Phase 5 — cross-capability handoff section for the CODE GIFTZ workspace.
 *
 * Renders both directions of the CODE GIFTZ ⇄ LAXII workflow:
 *  - Workflow 1 (CODE GIFTZ → LAXII): creative asset requests — composer,
 *    brief review card with approve/reject, live generation status, and the
 *    SEPARATE integration step (asset → engineering task → own plan gate).
 *  - Workflow 2 (LAXII → CODE GIFTZ): incoming handoffs — asset preview,
 *    source/destination identification, approve/reject/cancel, and the
 *    downstream engineering task link + relationship history.
 *
 * Visual language: obsidian + champagne gold, consistent with the rest of
 * the workspace. No provider branding anywhere.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, CircleX, Image as ImageIcon, Link2, Play, RefreshCw, ShieldAlert, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/bean/Spinner";
import { ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";
import { creativeApi, giftzApi, intelligenceApi, type CreativeTaskDTO, type GiftzRepositoryDTO, type HandoffDetailDTO } from "@/lib/giftz-client";

const HANDOFF_ACTIVE = new Set(["QUEUED", "ANALYZING", "PROPOSING", "AWAITING_APPROVAL", "GENERATING", "RUNNING"]);

function statusTone(status: string): string {
  if (status === "COMPLETED") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (status === "FAILED") return "border-red-500/40 bg-red-500/10 text-red-300";
  if (status === "CANCELLED") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  if (HANDOFF_ACTIVE.has(status)) return "border-[#c8a24a]/50 bg-[#c8a24a]/10 text-[#e5c878]";
  return "border-white/15 bg-white/5 text-white/60";
}

export function GiftzHandoffSection({ repos, selectedRepoId }: { repos: GiftzRepositoryDTO[] | null; selectedRepoId: string | null }) {
  const [creative, setCreative] = useState<CreativeTaskDTO[] | null>(null);
  const [handoffs, setHandoffs] = useState<HandoffDetailDTO[] | null>(null);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, h] = await Promise.all([creativeApi.list(), intelligenceApi.listHandoffs()]);
      setCreative(c.tasks);
      setHandoffs(h.handoffs);
    } catch {
      /* keep previous state — the panel is non-fatal */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const anyActive = (creative ?? []).some((t) => HANDOFF_ACTIVE.has(t.status)) || (handoffs ?? []).some((h) => HANDOFF_ACTIVE.has(h.status));
  useEffect(() => {
    if (!anyActive) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => void refresh(), 4000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [anyActive, refresh]);

  const createRequest = useCallback(async () => {
    if (!selectedRepoId || request.trim().length < 8) return;
    setBusy("create-creative");
    try {
      const out = await creativeApi.create(selectedRepoId, request.trim());
      if (out.duplicate) toast.info("Re-attached to the active creative request for this repository");
      else toast.success("Creative request proposed — review it below before anything is generated");
      setRequest("");
      await refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not create the creative request");
    } finally {
      setBusy(null);
    }
  }, [selectedRepoId, request, refresh]);

  const creativeAction = useCallback(
    async (kind: "approve" | "reject" | "integrate", task: CreativeTaskDTO, integrationText?: string) => {
      setBusy(`${kind}-${task.id}`);
      try {
        if (kind === "approve") {
          await creativeApi.approve(task.id);
          toast.success("Approved — LAXII is generating through its quality pipeline");
        } else if (kind === "reject") {
          await creativeApi.reject(task.id);
          toast.info("Creative request rejected — nothing was generated");
        } else {
          const out = await creativeApi.integrate(task.id, integrationText ?? "");
          toast.success("Integration planned — review the engineering plan below (approval required before any change)");
          await giftzApi.getTask(out.integrationTaskId).catch(() => undefined);
        }
        await refresh();
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Action failed");
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const handoffAction = useCallback(
    async (kind: "approve" | "reject" | "cancel", handoff: HandoffDetailDTO) => {
      setBusy(`${kind}-${handoff.id}`);
      try {
        if (kind === "approve") {
          const out = await intelligenceApi.approveHandoff(handoff.id);
          toast.success("Handoff approved — CODE GIFTZ is planning the integration");
          await giftzApi.getTask(out.downstreamTaskId).catch(() => undefined);
        } else if (kind === "reject") {
          await intelligenceApi.rejectHandoff(handoff.id);
          toast.info("Handoff rejected — nothing was executed");
        } else {
          await intelligenceApi.cancelHandoff(handoff.id);
          toast.info("Handoff cancelled");
        }
        await refresh();
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Action failed");
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return (
    <Card className="border-white/10 bg-[#0d0f14]">
      <CardContent className="p-4 sm:p-6">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg border border-[#c8a24a]/40 bg-[#c8a24a]/10">
            <Sparkles className="size-4 text-[#e5c878]" aria-hidden />
          </div>
          <h2 className="text-sm font-semibold text-white/90">Cross-capability handoffs — CODE GIFTZ ⇄ LAXII</h2>
          <Badge variant="outline" className="border-[#c8a24a]/40 text-[10px] text-[#e5c878]">
            user-approved only
          </Badge>
        </div>
        <p className="mb-4 text-xs text-white/50">
          Creative generation and repository integration are separate, individually approved steps. Assets are shared as verified references — never copied files.
        </p>

        {/* Workflow 1 composer */}
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <p className="mb-2 text-xs font-medium text-white/70">Request a creative asset for the selected repository</p>
          {selectedRepoId ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Textarea
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                placeholder="e.g. Build needs a portfolio banner for the site header — propose a 942×190 asset"
                className="min-h-[44px] flex-1 resize-none border-white/10 bg-black/30 text-sm text-white/85 placeholder:text-white/30"
                rows={2}
              />
              <Button onClick={() => void createRequest()} disabled={busy === "create-creative" || request.trim().length < 8} className="h-9 shrink-0 bg-[#c8a24a] text-black hover:bg-[#d9b45e]">
                {busy === "create-creative" ? <Spinner className="size-4" /> : <Play className="size-4" aria-hidden />}
                Propose brief
              </Button>
            </div>
          ) : (
            <p className="text-xs text-white/40">Select a repository first — the request is grounded in its real inspection.</p>
          )}
        </div>

        {/* Creative task cards (Workflow 1) */}
        <div className="mt-4 space-y-3">
          {creative === null ? (
            <>
              <Skeleton className="h-20 w-full bg-white/5" />
              <Skeleton className="h-20 w-full bg-white/5" />
            </>
          ) : creative.length === 0 ? (
            <p className="py-2 text-center text-xs text-white/40">No creative asset requests yet.</p>
          ) : (
            creative.map((task) => (
              <CreativeCard key={task.id} task={task} busy={busy} onAction={creativeAction} />
            ))
          )}
        </div>

        <Separator className="my-5 bg-white/10" />

        {/* Workflow 2 — incoming handoffs */}
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white/85">
          <Link2 className="size-4 text-[#c8a24a]" aria-hidden /> Incoming handoffs — LAXII → CODE GIFTZ
        </h3>
        <div className="space-y-3">
          {handoffs === null ? (
            <Skeleton className="h-20 w-full bg-white/5" />
          ) : handoffs.length === 0 ? (
            <p className="py-2 text-center text-xs text-white/40">
              No incoming handoffs. Request one from the LAXII studio via “Website integration”.
            </p>
          ) : (
            handoffs.map((handoff) => <HandoffCard key={handoff.id} handoff={handoff} busy={busy} onAction={handoffAction} />)
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- Workflow 1 card

function CreativeCard({
  task,
  busy,
  onAction,
}: {
  task: CreativeTaskDTO;
  busy: string | null;
  onAction: (kind: "approve" | "reject" | "integrate", task: CreativeTaskDTO, integrationText?: string) => Promise<void>;
}) {
  const [integrationText, setIntegrationText] = useState("");
  const brief = task.brief;
  const generating = task.status === "GENERATING";
  return (
    <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn("text-[10px]", statusTone(task.status))}>
          {generating ? (
            <>
              <Spinner className="mr-1 size-3" /> generating
            </>
          ) : (
            task.status
          )}
        </Badge>
        <span className="flex items-center gap-1 text-[11px] text-white/45">
          CODE GIFTZ <ArrowRight className="size-3" aria-hidden /> LAXII {task.assetSpec.width}×{task.assetSpec.height}
        </span>
        {task.digestSummary && (
          <span className="text-[11px] text-white/35">
            repo inspected · {task.digestSummary.fileCount} files{task.digestSummary.packageName ? ` · ${task.digestSummary.packageName}` : ""}
          </span>
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-xs text-white/70">{task.request}</p>

      {task.proposal && (
        <div className="mt-2 space-y-1 rounded-md border border-[#c8a24a]/25 bg-[#c8a24a]/5 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#e5c878]">Structured handoff — creative brief</p>
          <p className="text-xs text-white/80">
            <span className="text-white/45">Headline:</span> “{task.proposal.headline}”
          </p>
          <p className="text-xs text-white/70">
            <span className="text-white/45">Direction:</span> {task.proposal.visualDirection}
          </p>
          {task.proposal.audience && (
            <p className="text-xs text-white/70">
              <span className="text-white/45">Audience:</span> {task.proposal.audience}
            </p>
          )}
          {brief && (
            <p className="text-xs text-white/55">
              Canvas {brief.canvas.width}×{brief.canvas.height} · palette {brief.palette.slice(0, 4).join(", ") || "from site identity"}
              {brief.typography.items.length > 0 ? ` · text: ${brief.typography.items.map((t) => `"${t.text}"`).join(", ")}` : " · no rendered text"}
            </p>
          )}
          {task.proposal.avoid.length > 0 && <p className="text-xs text-white/45">Avoid: {task.proposal.avoid.join("; ")}</p>}
          <p className="text-[11px] text-white/40">{task.proposal.rationale}</p>
        </div>
      )}

      {task.mediaId && task.result && (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
          {/* Asset preview — served by the ownership-checked media route. */}
          <img src={`/api/media/${task.mediaId}/raw`} alt={`Generated banner asset ${task.result.width}×${task.result.height}`} className="h-14 w-auto max-w-[220px] rounded border border-white/10" />
          <div className="min-w-0 text-[11px] text-white/65">
            <p>
              Asset verified · {task.result.width}×{task.result.height} {task.result.mime} · {Math.round(task.result.sizeBytes / 1024)} KB
            </p>
            <p className="text-white/40">
              {task.result.qualitySummary} · {task.result.attempts} attempt(s)
            </p>
            {task.artifactId && <p className="text-white/35">artifact {task.artifactId.slice(0, 10)} · {task.status === "COMPLETED" && !task.integrationTaskId ? "ready to integrate" : task.integrationTaskId ? "linked to engineering task" : ""}</p>}
          </div>
        </div>
      )}

      {task.error && <p className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">{task.error}</p>}

      {/* Approval controls */}
      {task.status === "AWAITING_APPROVAL" && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-white/45">Approving sends this brief to LAXII. Nothing is generated before you approve.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void onAction("reject", task)} disabled={busy === `reject-${task.id}`} className="h-8 border-white/20 text-white/70 hover:bg-white/5">
              {busy === `reject-${task.id}` ? <Spinner className="size-3.5" /> : <X className="size-3.5" aria-hidden />}
              Reject
            </Button>
            <Button size="sm" onClick={() => void onAction("approve", task)} disabled={busy === `approve-${task.id}`} className="h-8 bg-[#c8a24a] text-black hover:bg-[#d9b45e]">
              {busy === `approve-${task.id}` ? <Spinner className="size-3.5" /> : <Play className="size-3.5" aria-hidden />}
              Approve &amp; generate
            </Button>
          </div>
        </div>
      )}

      {/* Separate integration approval */}
      {task.status === "COMPLETED" && task.mediaId && !task.integrationTaskId && (
        <div className="mt-2 space-y-2 rounded-md border border-white/10 bg-black/20 px-3 py-2">
          <p className="text-[11px] font-medium text-white/70">Integrate this asset into the repository — separate approval, own engineering plan gate</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Textarea
              value={integrationText}
              onChange={(e) => setIntegrationText(e.target.value)}
              placeholder="e.g. Show the banner at the top of the site entry page and cover it with a test"
              className="min-h-[40px] flex-1 resize-none border-white/10 bg-black/30 text-xs text-white/85 placeholder:text-white/30"
              rows={2}
            />
            <Button size="sm" onClick={() => void onAction("integrate", task, integrationText)} disabled={busy === `integrate-${task.id}` || integrationText.trim().length < 8} className="h-8 shrink-0 bg-[#c8a24a] text-black hover:bg-[#d9b45e]">
              {busy === `integrate-${task.id}` ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" aria-hidden />}
              Plan integration
            </Button>
          </div>
        </div>
      )}

      {task.integrationTaskId && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-white/50">
          <CheckCircle2 className="size-3.5 text-emerald-300" aria-hidden />
          Integration engineering task <code className="font-mono text-white/70">{task.integrationTaskId.slice(0, 10)}</code> — find it in the task history (its own plan approval gate applies).
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Workflow 2 card

function HandoffCard({
  handoff,
  busy,
  onAction,
}: {
  handoff: HandoffDetailDTO;
  busy: string | null;
  onAction: (kind: "approve" | "reject" | "cancel", handoff: HandoffDetailDTO) => Promise<void>;
}) {
  const active = HANDOFF_ACTIVE.has(handoff.status);
  return (
    <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn("text-[10px]", statusTone(handoff.status))}>
          {handoff.status === "RUNNING" ? (
            <>
              <Spinner className="mr-1 size-3" /> {handoff.status}
            </>
          ) : (
            handoff.status
          )}
        </Badge>
        <span className="flex items-center gap-1 text-[11px] text-white/45">
          LAXII <ArrowRight className="size-3" aria-hidden /> CODE GIFTZ
        </span>
        {handoff.repoName && <span className="text-[11px] text-white/35">repo: {handoff.repoName}</span>}
        {handoff.source.label && <span className="truncate text-[11px] text-white/35">source: {handoff.source.label}</span>}
      </div>

      <div className="mt-2 flex flex-wrap items-start gap-3">
        {handoff.mediaId && (
          <img
            src={`/api/media/${handoff.mediaId}/raw`}
            alt={`LAXII asset ${handoff.mediaMeta?.width ?? "?"}×${handoff.mediaMeta?.height ?? "?"}`}
            className="h-14 w-auto max-w-[220px] rounded border border-white/10"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-xs text-white/75">{handoff.request}</p>
          {handoff.mediaMeta && (
            <p className="mt-0.5 text-[11px] text-white/40">
              <ImageIcon className="mr-1 inline size-3" aria-hidden />
              {handoff.mediaMeta.width ?? "?"}×{handoff.mediaMeta.height ?? "?"} · {handoff.mediaMeta.mime} · {Math.round(handoff.mediaMeta.sizeBytes / 1024)} KB
            </p>
          )}
          {handoff.downstreamTaskId && (
            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-white/45">
              <ArrowRight className="size-3" aria-hidden />
              engineering task <code className="font-mono text-white/70">{handoff.downstreamTaskId.slice(0, 10)}</code>
              {handoff.downstreamStatus && <Badge variant="outline" className={cn("text-[9px]", statusTone(handoff.downstreamStatus))}>{handoff.downstreamStatus}</Badge>}
              {handoff.downstreamValidation && <span className="text-white/35">validation: {handoff.downstreamValidation}</span>}
            </p>
          )}
          {handoff.error && <p className="mt-1 text-[11px] text-red-300/80">{handoff.error}</p>}
        </div>
      </div>

      {handoff.status === "AWAITING_APPROVAL" && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-white/45">
            <ShieldAlert className="mr-1 inline size-3.5 text-[#e5c878]" aria-hidden />
            Approval creates an engineering plan — a SECOND gate guards the actual code change.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void onAction("reject", handoff)} disabled={busy === `reject-${handoff.id}`} className="h-8 border-white/20 text-white/70 hover:bg-white/5">
              {busy === `reject-${handoff.id}` ? <Spinner className="size-3.5" /> : <X className="size-3.5" aria-hidden />}
              Reject
            </Button>
            <Button size="sm" onClick={() => void onAction("approve", handoff)} disabled={busy === `approve-${handoff.id}`} className="h-8 bg-[#c8a24a] text-black hover:bg-[#d9b45e]">
              {busy === `approve-${handoff.id}` ? <Spinner className="size-3.5" /> : <Play className="size-3.5" aria-hidden />}
              Approve handoff
            </Button>
          </div>
        </div>
      )}
      {active && handoff.status !== "AWAITING_APPROVAL" && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => void onAction("cancel", handoff)} disabled={busy === `cancel-${handoff.id}`} className="h-8 border-red-500/40 text-red-300 hover:bg-red-500/10">
            {busy === `cancel-${handoff.id}` ? <Spinner className="size-3.5" /> : <CircleX className="size-3.5" aria-hidden />}
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
