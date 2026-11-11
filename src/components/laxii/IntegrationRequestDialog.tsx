"use client";

/**
 * Phase 5 — Workflow 2 entry point (LAXII → CODE GIFTZ).
 *
 * A self-contained "Website integration" action on a LAXII version: the user
 * picks an authorized CODE GIFTZ repository, describes the integration, and
 * the handoff is created at AWAITING_APPROVAL. Nothing runs before the user
 * approves the handoff — and the engineering plan has its own second gate.
 */

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/bean/Spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/client";
import { giftzApi, intelligenceApi, type GiftzRepositoryDTO } from "@/lib/giftz-client";

export function IntegrationRequestDialog({
  mediaId,
  width,
  height,
  sourceTaskId,
  sourceLabel,
}: {
  mediaId: string;
  width: number | null;
  height: number | null;
  sourceTaskId?: string | null;
  sourceLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<GiftzRepositoryDTO[] | null>(null);
  const [repoId, setRepoId] = useState<string>("");
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || repos) return;
    void giftzApi
      .listRepositories()
      .then((r) => {
        setRepos(r);
        if (r.length > 0) setRepoId((cur) => cur || r[0].id);
      })
      .catch(() => setRepos([]));
  }, [open, repos]);

  const submit = async () => {
    if (!repoId || request.trim().length < 8) return;
    setBusy(true);
    try {
      const out = await intelligenceApi.createHandoff({
        mediaId,
        repoId,
        request: request.trim(),
        sourceTaskId: sourceTaskId ?? null,
        sourceLabel,
      });
      toast.success(
        out.duplicate ? "An active handoff for this asset already exists — review it in GIFTZ." : "Handoff created — approve it in the GIFTZ workspace.",
        { description: "GIFTZ will plan the integration; a second approval guards the code change." }
      );
      setOpen(false);
      setRequest("");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not create the handoff");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Request website integration for this asset" title="Website integration" className="h-7 gap-1.5 border-white/10 bg-white/[0.03] text-[11px]" data-testid="laxii-integrate-button">
          <Globe className="size-3.5" aria-hidden /> <span className="hidden md:inline">Website integration</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md border-white/15 bg-[#0d0f14] text-white">
        <DialogHeader>
          <DialogTitle className="text-sm">Request website integration — LAXII → GIFTZ</DialogTitle>
          <DialogDescription className="text-xs text-white/55">
            {width && height ? `Asset ${width}×${height} · ` : ""}The asset is shared as a verified reference. GIFTZ will plan the integration; you approve the handoff AND the plan before anything changes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <p className="mb-1.5 text-xs font-medium text-white/70">Authorized repository</p>
            {repos === null ? (
              <Spinner className="size-4" />
            ) : repos.length === 0 ? (
              <p className="text-xs text-white/45">No GIFTZ workspace yet — create one in the GIFTZ workspace first.</p>
            ) : (
              <Select value={repoId} onValueChange={setRepoId}>
                <SelectTrigger className="w-full border-white/15 bg-black/30 text-sm text-white/85" aria-label="Repository">
                  <SelectValue placeholder="Select a repository" />
                </SelectTrigger>
                <SelectContent className="border-white/15 bg-[#0d0f14] text-white">
                  {repos.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name} · {r.fileCount} files
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-white/70">Integration requirements</p>
            <Textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={3}
              placeholder="e.g. Show this banner at the top of the site entry page and add a test that verifies the asset loads"
              className="resize-none border-white/15 bg-black/30 text-sm text-white/85 placeholder:text-white/30"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} className="border-white/20 text-white/70 hover:bg-white/5">
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || !repoId || request.trim().length < 8} className="bg-[#c8a24a] text-black hover:bg-[#d9b45e]">
            {busy ? <Spinner className="size-3.5" /> : <Globe className="size-3.5" aria-hidden />}
            Create handoff proposal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
