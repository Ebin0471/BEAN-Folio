"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronsUpDown,
  Download,
  Heart,
  Maximize,
  RefreshCw,
  Scissors,
  Sparkles,
  Wand2,
} from "lucide-react";

import { api } from "@/lib/client";
import { BANNER_ASPECT_CLASS } from "@/lib/banner";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/bean/Spinner";
import { MediaThumb } from "@/components/bean/MediaThumb";

import { mediaUrl, type LaxiiChatMessage } from "./types";

/**
 * Centre thread (§Phase 6): user prompts, assistant generation cards with
 * variation grids, selection rings, live progress, honest failures with
 * retry, image actions and a before/after version comparison.
 */
export function Thread({
  messages,
  hasConversation,
  selectedAssetId,
  onSelectOutput,
  onRetry,
  onToggleFavourite,
  onUseImage,
}: {
  messages: LaxiiChatMessage[];
  hasConversation: boolean;
  selectedAssetId: string | null;
  onSelectOutput: (messageId: string, assetId: string) => void;
  onRetry: (jobId: string) => void;
  onToggleFavourite: (assetId: string, favourite: boolean) => void;
  onUseImage: (assetId: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  if (!hasConversation) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="max-w-lg text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-gold-soft ring-1 ring-primary/30">
            <Wand2 className="size-6 text-primary" aria-hidden />
          </span>
          <h2 className="mt-4 font-display text-xl font-semibold">Create anything, then refine it by talking</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Describe an image and LAXII generates real variations with a configured provider. Then edit conversationally —
            change the background, transform clothing or lighting, remove the background, expand the canvas, upscale, or
            produce fresh variations of any result. Your images stay private to your account.
          </p>
          <ul className="mx-auto mt-5 grid max-w-md gap-2 text-left text-xs text-muted-foreground">
            <li className="rounded-lg border border-border/60 bg-card/60 px-3 py-2">
              <Sparkles className="mr-2 inline size-3.5 text-primary" aria-hidden />
              “A cinematic portrait of an executive in a charcoal suit, champagne-gold studio light”
            </li>
            <li className="rounded-lg border border-border/60 bg-card/60 px-3 py-2">
              <Wand2 className="mr-2 inline size-3.5 text-primary" aria-hidden />
              “Change the background to a luxury office” — edits the selected image
            </li>
            <li className="rounded-lg border border-border/60 bg-card/60 px-3 py-2">
              <Scissors className="mr-2 inline size-3.5 text-primary" aria-hidden />
              “Remove the background” — transparent PNG cutout via local MODNet matting
            </li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-5 laxii-scroll" aria-label="Conversation">
      <div className="mx-auto grid max-w-3xl gap-4 pb-4">
        {messages.map((m) =>
          m.role === "USER" ? (
            <UserBubble key={m.id} message={m} />
          ) : (
            <AssistantCard
              key={m.id}
              message={m}
              selectedAssetId={selectedAssetId}
              onSelectOutput={onSelectOutput}
              onRetry={onRetry}
              onToggleFavourite={onToggleFavourite}
              onUseImage={onUseImage}
            />
          )
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function UserBubble({ message }: { message: LaxiiChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-primary/25 bg-gold-soft/20 px-4 py-2.5 text-sm leading-relaxed">
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
        {message.refs.length > 0 ? (
          <div className="mt-2 flex gap-1.5">
            {message.refs.map((r) => (
              <img key={r} src={mediaUrl(r)} alt="Reference" className="size-10 rounded-md border border-border/60 object-cover" loading="lazy" />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantCard({
  message,
  selectedAssetId,
  onSelectOutput,
  onRetry,
  onToggleFavourite,
  onUseImage,
}: {
  message: LaxiiChatMessage;
  selectedAssetId: string | null;
  onSelectOutput: (messageId: string, assetId: string) => void;
  onRetry: (jobId: string) => void;
  onToggleFavourite: (assetId: string, favourite: boolean) => void;
  onUseImage: (assetId: string) => void;
}) {
  const [comparing, setComparing] = useState(false);
  const running = message.status === "RUNNING" || message.status === "QUEUED";
  const failed = message.status === "FAILED";
  const selected = message.selectedAssetId ?? message.outputs[0]?.mediaAssetId ?? null;
  const parentThumb = message.parentAssetId && message.outputs.length ? message.parentAssetId : null;

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 p-3 sm:p-4" data-status={message.status ?? undefined}>
      {/* meta row */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          {message.operation ? message.operation.replace("_", " ") : "Generating"}
          {message.meta?.providerLabel ? <span>· {message.meta.providerLabel}</span> : message.provider ? <span>· {message.provider}</span> : null}
          {message.meta?.estimatedCostUSD != null && message.meta.estimatedCostUSD > 0 ? (
            <span title="Documented estimate from the provider capability registry — external APIs are paid inference">
              · ≈${message.meta.estimatedCostUSD.toFixed(3)}
            </span>
          ) : null}
        </span>
        {selected ? (
          <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent" onClick={() => setComparing((v) => !v)}>
            <ChevronsUpDown className="size-3" aria-hidden /> Compare
          </button>
        ) : null}
      </div>

      {/* assistant note (e.g. remove-bg explainer) */}
      {message.text ? <p className="mt-2 text-sm text-muted-foreground">{message.text}</p> : null}

      {/* live progress */}
      {running ? (
        <div className="mt-3 rounded-xl border border-primary/30 bg-gold-soft/10 p-3" role="status" aria-live="polite">
          <div className="flex items-center gap-2 text-sm">
            <Spinner className="size-4 text-primary" />
            <span className="font-medium">{message.stage ?? "Working"}</span>
            <span className="ml-auto text-xs text-muted-foreground">{message.progress}%</span>
          </div>
          <Progress value={message.progress} className="mt-2 h-1.5" />
        </div>
      ) : null}

      {/* honest failure */}
      {failed ? (
        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
          <p className="text-sm text-red-500">{message.error ?? "Generation failed."}</p>
          {message.jobId ? (
            <Button size="sm" variant="outline" className="mt-2 gap-1.5 border-red-500/30" onClick={() => onRetry(message.jobId!)}>
              <RefreshCw className="size-3.5" aria-hidden /> Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* variation grid */}
      {message.outputs.length > 0 ? (
        <div className={`mt-3 grid gap-2 ${message.outputs.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
          {message.outputs.map((out) => {
            const isSelected = selected === out.mediaAssetId;
            return (
              <figure
                key={out.mediaAssetId}
                className={`group relative overflow-hidden rounded-xl border transition-colors ${
                  isSelected ? "border-primary/60 ring-2 ring-primary/30" : "border-border/60 hover:border-primary/40"
                }`}
              >
                <button
                  type="button"
                  className="block w-full cursor-pointer"
                  onClick={() => onSelectOutput(message.id, out.mediaAssetId)}
                  aria-pressed={isSelected}
                  aria-label={isSelected ? "Selected output" : "Select this output"}
                >
                  <MediaThumb
                    src={mediaUrl(out.mediaAssetId)}
                    alt={`Generated ${out.width}×${out.height}`}
                    kind="IMAGE"
                    aspect={message.operation === "BANNER" ? BANNER_ASPECT_CLASS : "aspect-square"}
                    className="w-full"
                  />
                </button>
                {isSelected ? (
                  <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                    <Check className="size-3" aria-hidden /> In use
                  </span>
                ) : null}
                <figcaption className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-background/80 px-2 py-1.5 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <span className="truncate text-[10px] text-muted-foreground">
                    {out.width}×{out.height}
                    {out.format ? ` · ${out.format}` : ""}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <IconAction label="Save to favourites" onClick={() => onToggleFavourite(out.mediaAssetId, true)}>
                      <Heart className="size-3.5" aria-hidden />
                    </IconAction>
                    <IconAction label="Download" onClick={() => downloadAsset(out.mediaAssetId, out.format ?? "PNG")}>
                      <Download className="size-3.5" aria-hidden />
                    </IconAction>
                    <IconAction label="Use this image — continue from here" onClick={() => onUseImage(out.mediaAssetId)}>
                      <Maximize className="size-3.5" aria-hidden />
                    </IconAction>
                  </span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      ) : null}

      {/* version comparison (parent → selected) */}
      {comparing && parentThumb && selected && parentThumb !== selected ? (
        <CompareSlider before={mediaUrl(parentThumb)} after={mediaUrl(selected)} />
      ) : comparing && selected && !parentThumb ? (
        <p className="mt-2 text-xs text-muted-foreground">This image has no earlier version in the conversation to compare with.</p>
      ) : null}
    </div>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** Lightweight before/after slider — same interaction as Profile Studio's. */
export function CompareSlider({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = useState(50);
  return (
    <div className="relative mt-3 overflow-hidden rounded-xl border border-border/60">
      <img src={after} alt="After" className="block w-full" draggable={false} />
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${pos}%` }}>
        <img src={before} alt="Before" className="absolute inset-0 h-full w-full object-cover" style={{ width: "100%" }} draggable={false} />
      </div>
      <div className="absolute inset-y-0 w-0.5 bg-primary" style={{ left: `${pos}%` }} aria-hidden />
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label="Compare before and after"
        className="absolute inset-x-4 bottom-2 accent-[var(--primary)]"
      />
      <span className="absolute left-2 top-2 rounded-full bg-background/80 px-2 py-0.5 text-[10px]">Before</span>
      <span className="absolute right-2 top-2 rounded-full bg-background/80 px-2 py-0.5 text-[10px]">After</span>
    </div>
  );
}

async function downloadAsset(assetId: string, format: string) {
  const res = await fetch(mediaUrl(assetId), { credentials: "include" });
  if (!res.ok) return;
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `laxii-${assetId.slice(-6)}.${format.toLowerCase()}`;
  a.click();
  URL.revokeObjectURL(a.href);
}
