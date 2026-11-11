"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Download, ImagePlus, RefreshCw, Sparkles, Wand2, X } from "lucide-react";
import { toast } from "sonner";

import { api, ApiError, uploadFile } from "@/lib/client";
import { BANNER_ASPECT_CLASS } from "@/lib/banner";
import { cn } from "@/lib/utils";
import type { MediaDTO } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { MediaThumb } from "@/components/bean/MediaThumb";
import { MediaUploadButton } from "@/components/bean/MediaUploadButton";

/**
 * Profile Studio — LAXII-powered avatar & banner creation inside the existing
 * profile editing experience. Optional by design: everything here is additive
 * and nothing is written to the profile until the user explicitly approves
 * "Apply". The uploaded reference file is preserved untouched (a LAXII result
 * is a NEW MediaAsset; the original bytes are never modified).
 */

// ------------------------------------------------------------------ styles data

interface StyleCard {
  id: string;
  label: string;
  description: string;
}

const AVATAR_STYLES: StyleCard[] = [
  { id: "corporate_headshot", label: "Corporate headshot", description: "Neutral seamless backdrop, soft even light" },
  { id: "editor_portrait", label: "Editorial portrait", description: "Magazine window light, muted film tones" },
  { id: "cinematic_portrait", label: "Cinematic portrait", description: "Dramatic rim light, moody grade" },
  { id: "studio_portrait", label: "Studio portrait", description: "Bright classic studio, beauty light" },
  { id: "creative_professional", label: "Creative professional", description: "Color gels, confident contemporary set" },
  { id: "minimal_luxury", label: "Minimal luxury", description: "Champagne tones, quiet premium feel" },
];

const BANNER_STYLES: StyleCard[] = [
  { id: "dark_luxury", label: "Dark luxury", description: "Charcoal silk, restrained golden veins" },
  { id: "champagne_gold", label: "Champagne gold", description: "Warm gradient, soft golden bokeh" },
  { id: "corporate", label: "Corporate", description: "Clean blurred office depth" },
  { id: "minimal", label: "Minimal", description: "Paper & concrete, generous space" },
  { id: "creative_studio", label: "Creative studio", description: "Abstract shapes, vibrant accents" },
  { id: "cinematic", label: "Cinematic", description: "Volumetric beams, deep shadows" },
  { id: "modern_futuristic", label: "Modern futuristic", description: "Gradient mesh, neon accents" },
];

const ASPECTS = [
  { id: "2048:687", label: "2048 × 687 — BEAN Folio banner", width: 2048, height: 687 },
  { id: "2:1", label: "2:1 — classic banner", width: 1440, height: 720 },
  { id: "7:4", label: "7:4 — wide", width: 1344, height: 768 },
  { id: "4:3", label: "4:3 — framed", width: 1152, height: 864 },
];

// ------------------------------------------------------------------ types

interface LaxiiJobResult {
  mediaAssetId: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
  sharpness: number;
}

interface LaxiiJobState {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  stage: string | null;
  progress: number;
  error: string | null;
  results: LaxiiJobResult[];
}

type Mode = "AVATAR" | "BANNER";
type IdentityMode = "PRESERVE" | "AI_GUIDED";

// ------------------------------------------------------------------ component

export function ProfileStudio({
  open,
  onOpenChange,
  currentAvatarUrl,
  currentCoverUrl,
  onApplied,
  initialTab = "avatar",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currentAvatarUrl: string | null;
  currentCoverUrl: string | null;
  /** Called after the user successfully applies an avatar or banner. */
  onApplied: () => void;
  /** Workflow tab active when the studio opens (defaults to Avatar, as before). */
  initialTab?: "avatar" | "banner";
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Compact layout contract (fixed within the viewport):
          fixed header  →  shrink-0
          fixed bottom  →  the per-tab action bar (shrink-0, inside each studio)
          only the middle scrolls → flex-1 min-h-0 overflow-y-auto
      */}
      <DialogContent className="flex h-[min(92dvh,780px)] w-[min(880px,96vw)] flex-col gap-0 overflow-hidden rounded-xl border-border/60 bg-card p-0 sm:max-w-[880px]">
        <DialogHeader className="shrink-0 gap-1 border-b border-border/60 px-4 py-3 sm:px-5">
          <DialogTitle className="flex items-center gap-2 font-display text-base">
            <Wand2 className="size-4 text-primary" aria-hidden /> Profile Studio
            <Badge variant="outline" className="ml-1 rounded-full border-primary/40 text-[10px] font-normal text-primary">
              LAXII engine
            </Badge>
          </DialogTitle>
          <DialogDescription className="hidden text-xs sm:block">
            Generate professional avatars and banners with open-source AI. Nothing replaces your profile images until you
            approve it — and your uploaded originals are never modified.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue={initialTab} className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border/60 px-4 py-2 sm:px-5">
            <TabsList className="w-fit">
              <TabsTrigger value="avatar" className="gap-1.5">
                <Sparkles className="size-3.5" aria-hidden /> Avatar
              </TabsTrigger>
              <TabsTrigger value="banner" className="gap-1.5">
                <ImagePlus className="size-3.5" aria-hidden /> Banner
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="avatar" className="flex min-h-0 flex-1 flex-col outline-none">
            <AvatarStudio currentUrl={currentAvatarUrl} onApplied={onApplied} />
          </TabsContent>
          <TabsContent value="banner" className="flex min-h-0 flex-1 flex-col outline-none">
            <BannerStudio currentUrl={currentCoverUrl} onApplied={onApplied} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ shared pieces

function StyleGrid({ styles, value, onChange }: { styles: StyleCard[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {styles.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onChange(s.id)}
          aria-pressed={value === s.id}
          className={cn(
            "rounded-lg border p-2 text-left transition-colors",
            value === s.id
              ? "border-primary/50 bg-gold-soft/25"
              : "border-border/60 bg-background/40 hover:border-primary/30"
          )}
        >
          <span className={cn("block text-xs font-medium leading-tight", value === s.id && "text-primary")}>{s.label}</span>
          <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">{s.description}</span>
        </button>
      ))}
    </div>
  );
}

function SubjectWindow({
  title,
  hint,
  subject,
  onChange,
}: {
  title: string;
  hint: string;
  subject: { x: number; y: number; w: number; h: number };
  onChange: (s: { x: number; y: number; w: number; h: number }) => void;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-2.5">
      <p className="text-xs font-medium">{title}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>
      <div className="mt-2 grid gap-2.5 sm:grid-cols-3">
        <div>
          <Label className="text-[11px] text-muted-foreground">Center X — {subject.x + subject.w / 2}%</Label>
          <Slider
            className="mt-1"
            value={[subject.x + subject.w / 2]}
            min={10}
            max={90}
            step={1}
            aria-label="Subject center X"
            onValueChange={([v]) => onChange({ ...subject, x: Math.min(90, Math.max(5, v - subject.w / 2)) })}
          />
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">Center Y — {subject.y + subject.h / 2}%</Label>
          <Slider
            className="mt-1"
            value={[subject.y + subject.h / 2]}
            min={10}
            max={90}
            step={1}
            aria-label="Subject center Y"
            onValueChange={([v]) => onChange({ ...subject, y: Math.min(90, Math.max(5, v - subject.h / 2)) })}
          />
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">Size — {Math.round((subject.w + subject.h) / 2)}%</Label>
          <Slider
            className="mt-1"
            value={[(subject.w + subject.h) / 2]}
            min={20}
            max={85}
            step={1}
            aria-label="Subject size"
            onValueChange={([v]) => onChange({ ...subject, w: v, h: v })}
          />
        </div>
      </div>
    </div>
  );
}

function ReferenceBox({
  source,
  onUploaded,
  label,
}: {
  source: MediaDTO | null;
  onUploaded: (m: MediaDTO) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-border/70 bg-background/40 p-2">
      <div className="size-12 shrink-0 overflow-hidden rounded-md">
        <MediaThumb src={source?.url ?? null} alt={source ? "Reference image" : "No reference yet"} kind={source ? "IMAGE" : undefined} aspect="aspect-square" className="rounded-md" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{source ? "Reference ready" : label}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {source ? "Your original file stays untouched — results are new images." : "Upload a photo to work from. JPG, PNG or WebP."}
        </p>
      </div>
      {!source && <MediaUploadButton kind="IMAGE" label="Upload" onUploaded={onUploaded} size="sm" />}
      {source && (
        <MediaUploadButton kind="IMAGE" label="Replace" onUploaded={onUploaded} size="sm" variant="ghost" />
      )}
    </div>
  );
}

function OptionsRow({
  variations,
  onVariations,
  format,
  onFormat,
  children,
}: {
  variations: number;
  onVariations: (v: number) => void;
  format: string;
  onFormat: (v: string) => void;
  /** Extra selects (resolution / aspect) rendered in the same compact row. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
      <div>
        <Label className="text-xs">Variations</Label>
        <div className="mt-1 flex gap-1" role="group" aria-label="Number of variations">
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={variations === n}
              onClick={() => onVariations(n)}
              className={cn(
                "size-8 rounded-md border text-xs",
                variations === n ? "border-primary/50 bg-gold-soft/25 text-primary" : "border-border/60 bg-background/40"
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="w-28">
        <Label htmlFor="laxii-format" className="text-xs">
          Export format
        </Label>
        <select
          id="laxii-format"
          value={format}
          onChange={(e) => onFormat(e.target.value)}
          className="mt-1 h-8 w-full rounded-md border border-border/60 bg-background/60 px-2 text-xs"
        >
          <option value="PNG">PNG (lossless)</option>
          <option value="JPEG">JPEG</option>
          <option value="WEBP">WebP</option>
        </select>
      </div>
      {children}
    </div>
  );
}

function JobProgress({ job }: { job: LaxiiJobState | null }) {
  if (!job || (job.status !== "RUNNING" && job.status !== "QUEUED")) return null;
  return (
    <div className="rounded-lg border border-primary/30 bg-gold-soft/10 p-3" role="status">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-primary">{job.stage ?? "Working…"}</span>
        <span className="tabular-nums text-muted-foreground">{job.progress}%</span>
      </div>
      <Progress value={job.progress} className="mt-2 h-1.5" aria-label="Generation progress" />
    </div>
  );
}

// ------------------------------------------------------------------ hooks

function useJobPolling() {
  const [job, setJob] = useState<LaxiiJobState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  const poll = useCallback(
    (id: string) => {
      stop();
      timer.current = setInterval(async () => {
        try {
          const res = await api<{ job: LaxiiJobState }>(`/api/laxii/jobs/${id}`);
          setJob(res.job);
          if (res.job.status === "SUCCEEDED" || res.job.status === "FAILED" || res.job.status === "CANCELLED") {
            stop();
            if (res.job.status === "FAILED") toast.error(res.job.error ?? "Generation failed");
            if (res.job.status === "SUCCEEDED") toast.success("LAXII finished — review the results below");
          }
        } catch {
          /* transient poll errors keep polling */
        }
      }, 1500);
    },
    [stop]
  );

  const generate = useCallback(
    async (payload: Record<string, unknown>) => {
      setSubmitting(true);
      setJob({ id: "", status: "QUEUED", stage: "Queued", progress: 1, error: null, results: [] });
      try {
        const res = await api<{ job: LaxiiJobState }>("/api/laxii/jobs", { method: "POST", json: payload });
        setJob(res.job);
        poll(res.job.id);
      } catch (e) {
        setJob(null);
        toast.error(e instanceof ApiError ? e.message : "Could not start the job");
      } finally {
        setSubmitting(false);
      }
    },
    [poll]
  );

  return { job, submitting, generate, setJob };
}

async function downloadMedia(id: string, kind: string, format: string) {
  try {
    const res = await fetch(`/api/media/${id}/raw`, { credentials: "include" });
    if (!res.ok) throw new Error("Download failed");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `laxii-${kind.toLowerCase()}-${id.slice(-6)}.${format.toLowerCase()}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch {
    toast.error("Could not download the image");
  }
}

function ResultGrid({
  job,
  sourceUrl,
  compareLabel,
  onApply,
  applyingId,
  onRegenerate,
}: {
  job: LaxiiJobState | null;
  sourceUrl: string | null;
  compareLabel: string;
  onApply: (r: LaxiiJobResult) => void;
  applyingId: string | null;
  onRegenerate: () => void;
}) {
  const [selected, setSelected] = useState<LaxiiJobResult | null>(null);
  const [watchedKey, setWatchedKey] = useState<string | null>(null);
  const results = job?.status === "SUCCEEDED" ? job.results : [];

  // Derived-state reset pattern (React-recommended): reselect the first
  // variation synchronously during render when a new job's results arrive.
  const resultKey = job ? `${job.id}:${job.status}:${results.length}` : null;
  if (resultKey !== watchedKey) {
    setWatchedKey(resultKey);
    setSelected(results[0] ?? null);
  }

  if (job?.status === "FAILED") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
        <p className="font-medium text-destructive">Generation failed</p>
        <p className="mt-1 text-muted-foreground">{job.error}</p>
        <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={onRegenerate}>
          <RefreshCw className="size-3" aria-hidden /> Retry
        </Button>
      </div>
    );
  }

  if (results.length === 0) return null;

  return (
    <div className="space-y-3">
      {selected && sourceUrl && <CompareSlider before={sourceUrl} after={`/api/media/${selected.mediaAssetId}/raw`} label={compareLabel} />}
      {selected && !sourceUrl && (
        <div className="overflow-hidden rounded-lg border border-border/60">
          <MediaThumb src={`/api/media/${selected.mediaAssetId}/raw`} alt="LAXII result" kind="IMAGE" aspect={BANNER_ASPECT_CLASS} className="w-full" />
        </div>
      )}
      {results.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {results.map((r, i) => (
            <button
              key={r.mediaAssetId}
              type="button"
              aria-pressed={selected?.mediaAssetId === r.mediaAssetId}
              onClick={() => setSelected(r)}
              className={cn(
                "w-24 shrink-0 overflow-hidden rounded-md border-2",
                selected?.mediaAssetId === r.mediaAssetId ? "border-primary" : "border-transparent opacity-80"
              )}
            >
              <MediaThumb src={`/api/media/${r.mediaAssetId}/raw`} alt={`Variation ${i + 1}`} kind="IMAGE" aspect="aspect-[4/3]" />
            </button>
          ))}
        </div>
      )}
      {selected && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="rounded-full text-[10px] font-normal text-muted-foreground">
            {selected.width}×{selected.height} · {selected.format} · {(selected.bytes / 1024).toFixed(0)} KB · sharpness {selected.sharpness}/100
          </Badge>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => void downloadMedia(selected.mediaAssetId, "result", selected.format)}>
              <Download className="size-3.5" aria-hidden /> Download
            </Button>
            <Button size="sm" className="h-8 text-xs" disabled={applyingId === selected.mediaAssetId} onClick={() => onApply(selected)}>
              {applyingId === selected.mediaAssetId ? "Applying…" : "Apply…"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Draggable before/after comparison — the divider reveals the original. */
function CompareSlider({ before, after, label }: { before: string; after: string; label: string }) {
  const [pos, setPos] = useState(50);
  return (
    <div>
      <div className="relative overflow-hidden rounded-lg border border-border/60">
        <img src={after} alt={`${label} — LAXII result`} className="block w-full" draggable={false} />
        <img
          src={before}
          alt={`${label} — original`}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
          draggable={false}
        />
        <div className="pointer-events-none absolute inset-y-0" style={{ left: `${pos}%`, width: 2, background: "rgba(255,255,255,0.85)" }} aria-hidden />
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Original</span>
        <input
          type="range"
          min={0}
          max={100}
          value={pos}
          aria-label="Compare original and result"
          onChange={(e) => setPos(Number(e.target.value))}
          className="h-1 flex-1 accent-[var(--primary)]"
        />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">LAXII result</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ avatar studio

function AvatarStudio({ currentUrl, onApplied }: { currentUrl: string | null; onApplied: () => void }) {
  const [source, setSource] = useState<MediaDTO | null>(null);
  const [style, setStyle] = useState<string | null>(null);
  const [identityMode, setIdentityMode] = useState<IdentityMode>("PRESERVE");
  const [subject, setSubject] = useState({ x: 25, y: 8, w: 50, h: 60 });
  const [variations, setVariations] = useState(2);
  const [format, setFormat] = useState("PNG");
  const [size, setSize] = useState(1024);
  const [instructions, setInstructions] = useState("");
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyTarget, setApplyTarget] = useState<LaxiiJobResult | null>(null);
  const { job, submitting, generate } = useJobPolling();

  const canGenerate = Boolean(source && style);

  const regenerate = () => {
    if (!source || !style) return;
    void generate({
      kind: "AVATAR",
      style,
      identityMode,
      subject,
      variations,
      format,
      instructions: instructions.trim() || undefined,
      sourceAssetId: source.id,
      size: { width: size, height: size },
      provider: "auto",
    });
  };

  const apply = async (r: LaxiiJobResult) => {
    setApplyingId(r.mediaAssetId);
    try {
      await api("/api/me/profile", { method: "PATCH", json: { avatarMediaId: r.mediaAssetId } });
      toast.success("New avatar applied to your profile");
      onApplied();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not apply the avatar");
    } finally {
      setApplyingId(null);
      setApplyTarget(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-5">
        <ReferenceBox source={source} onUploaded={setSource} label="Upload a reference photo" />

        {/* identity mode — honest, explicit choice */}
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Identity mode">
          <button
            type="button"
            role="radio"
            aria-checked={identityMode === "PRESERVE"}
            onClick={() => setIdentityMode("PRESERVE")}
            className={cn(
              "rounded-lg border p-2.5 text-left",
              identityMode === "PRESERVE" ? "border-primary/50 bg-gold-soft/20" : "border-border/60 bg-background/40"
            )}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              Preserved-pixel portrait <Badge className="rounded-full bg-primary/15 text-[9px] font-normal text-primary">Recommended</Badge>
            </span>
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
              Your real face pixels are kept and layered onto a generated studio scene. Identity is genuinely yours.
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={identityMode === "AI_GUIDED"}
            onClick={() => setIdentityMode("AI_GUIDED")}
            className={cn(
              "rounded-lg border p-2.5 text-left",
              identityMode === "AI_GUIDED" ? "border-primary/50 bg-gold-soft/20" : "border-border/60 bg-background/40"
            )}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              AI-guided <Badge variant="outline" className="rounded-full text-[9px] font-normal text-amber-500">Experimental</Badge>
            </span>
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
              The model repaints the whole photo from your reference. Identity is NOT guaranteed to survive — always review.
            </span>
          </button>
        </div>

        <div>
          <Label className="text-xs">Style</Label>
          <div className="mt-1.5">
            <StyleGrid styles={AVATAR_STYLES} value={style} onChange={setStyle} />
          </div>
        </div>

        {identityMode === "PRESERVE" && (
          <Collapsible className="rounded-lg border border-border/60 bg-background/40">
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left">
              <span>
                <span className="block text-xs font-medium">Advanced settings</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  Subject position &amp; size for the manual mask fallback.
                </span>
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t border-border/60 p-2.5">
                <SubjectWindow
                  title="Subject window (manual mask fallback)"
                  hint="The subject is detected automatically and kept pixel-original while the background is replaced. If auto-detection is unavailable, this window becomes the manual mask — original pixels are kept inside it, everything outside is replaced."
                  subject={subject}
                  onChange={setSubject}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        <OptionsRow variations={variations} onVariations={setVariations} format={format} onFormat={setFormat}>
          <div className="w-32">
            <Label htmlFor="laxii-avatar-size" className="text-xs">
              Resolution
            </Label>
            <select
              id="laxii-avatar-size"
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className="mt-1 h-8 w-full rounded-md border border-border/60 bg-background/60 px-2 text-xs"
            >
              <option value={512}>512 × 512</option>
              <option value={768}>768 × 768</option>
              <option value={1024}>1024 × 1024</option>
            </select>
          </div>
        </OptionsRow>

        <div>
          <Label htmlFor="laxii-avatar-instructions" className="text-xs">
            Custom instructions (optional)
          </Label>
          <Textarea
            id="laxii-avatar-instructions"
            value={instructions}
            maxLength={600}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. warmer tones, slightly darker backdrop, film grain"
            className="mt-1 min-h-[44px] text-xs"
            rows={2}
          />
        </div>

        <JobProgress job={job} />
        <ResultGrid
          job={job}
          sourceUrl={source?.url ?? null}
          compareLabel="Avatar"
          applyingId={applyingId}
          onApply={setApplyTarget}
          onRegenerate={regenerate}
        />
      </div>

      {/* fixed bottom action bar — always visible, never scrolls away */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-background/70 px-4 py-2.5 backdrop-blur sm:px-5">
        <p className="hidden min-w-0 truncate text-[11px] text-muted-foreground sm:block">
          {currentUrl ? "Your current avatar stays in place until you apply a new one." : "You have no avatar yet — generate one above."}
        </p>
        <Button disabled={!canGenerate || submitting || Boolean(job && (job.status === "RUNNING" || job.status === "QUEUED"))} onClick={regenerate} className="ml-auto">
          <Wand2 className="size-4" aria-hidden /> {submitting ? "Starting…" : "Generate avatars"}
        </Button>
      </div>

      <AlertDialog open={Boolean(applyTarget)} onOpenChange={(v) => !v && setApplyTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display">Apply this avatar?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current avatar ({currentUrl ? "already set" : "none"}) will be replaced on your public profile. The
              generated image and your original upload are both kept in your library — nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => applyTarget && void apply(applyTarget)}>Apply avatar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ------------------------------------------------------------------ banner studio

function BannerStudio({ currentUrl, onApplied }: { currentUrl: string | null; onApplied: () => void }) {
  const [source, setSource] = useState<MediaDTO | null>(null);
  const [style, setStyle] = useState<string | null>(null);
  const [aspect, setAspect] = useState("2048:687");
  const [customW, setCustomW] = useState("");
  const [customH, setCustomH] = useState("");
  const [keepZone, setKeepZone] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [variations, setVariations] = useState(2);
  const [format, setFormat] = useState("PNG");
  const [instructions, setInstructions] = useState("");
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyTarget, setApplyTarget] = useState<LaxiiJobResult | null>(null);
  const { job, submitting, generate } = useJobPolling();

  const canGenerate = Boolean(style);

  const dims = (): { width: number; height: number } => {
    if (customW && customH) {
      const w = Math.min(4096, Math.max(64, parseInt(customW, 10) || 0));
      const h = Math.min(4096, Math.max(64, parseInt(customH, 10) || 0));
      if (w && h) return { width: w, height: h };
    }
    return ASPECTS.find((a) => a.id === aspect) ?? ASPECTS[0];
  };

  const regenerate = () => {
    if (!style) return;
    void generate({
      kind: "BANNER",
      style,
      variations,
      format,
      instructions: instructions.trim() || undefined,
      ...(source && keepZone
        ? { sourceAssetId: source.id, subject: keepZone }
        : {}),
      size: dims(),
      provider: "auto",
    });
  };

  const apply = async (r: LaxiiJobResult) => {
    setApplyingId(r.mediaAssetId);
    try {
      await api("/api/me/profile", { method: "PATCH", json: { coverMediaId: r.mediaAssetId } });
      toast.success("New banner applied to your profile");
      onApplied();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not apply the banner");
    } finally {
      setApplyingId(null);
      setApplyTarget(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-5">
        <div>
          <Label className="text-xs">Style</Label>
          <div className="mt-1.5">
            <StyleGrid styles={BANNER_STYLES} value={style} onChange={setStyle} />
          </div>
        </div>

        <OptionsRow variations={variations} onVariations={setVariations} format={format} onFormat={setFormat}>
          <div>
            <Label htmlFor="laxii-aspect" className="text-xs">
              Aspect ratio
            </Label>
            <select
              id="laxii-aspect"
              value={aspect}
              onChange={(e) => setAspect(e.target.value)}
              className="mt-1 h-8 rounded-md border border-border/60 bg-background/60 px-2 text-xs"
            >
              {ASPECTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">Custom size (optional)</Label>
            <div className="mt-1 flex items-center gap-1">
              <Input value={customW} onChange={(e) => setCustomW(e.target.value.replace(/\D/g, ""))} placeholder="1920" className="h-8 w-16 text-xs" aria-label="Custom width" />
              <span className="text-xs text-muted-foreground">×</span>
              <Input value={customH} onChange={(e) => setCustomH(e.target.value.replace(/\D/g, ""))} placeholder="640" className="h-8 w-16 text-xs" aria-label="Custom height" />
            </div>
          </div>
        </OptionsRow>

        {/* optional reference with content preservation */}
        <div className="rounded-lg border border-border/60 bg-background/40 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">Restyle an existing banner (optional)</p>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                Mark a keep-zone and the original pixels inside it — text, logos, faces — are layered back untouched. The
                generator never redraws them.
              </p>
            </div>
            {source && (
              <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Remove reference" onClick={() => { setSource(null); setKeepZone(null); }}>
                <X className="size-3.5" aria-hidden />
              </Button>
            )}
          </div>
          <div className="mt-2">
            <ReferenceBox source={source} onUploaded={setSource} label="Upload the banner to restyle" />
          </div>
          {source && (
            <div className="mt-2">
              {keepZone ? (
                <Collapsible
                  className="rounded-lg border border-border/60 bg-background/40"
                  defaultOpen
                >
                  <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left">
                    <span className="text-xs font-medium">Keep-zone position &amp; size</span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t border-border/60 p-2.5">
                      <SubjectWindow
                        title="Keep-zone — original pixels preserved inside this window"
                        hint="Cover the text/logos/content that must survive the restyle."
                        subject={keepZone}
                        onChange={setKeepZone}
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setKeepZone({ x: 8, y: 30, w: 40, h: 40 })}>
                  Mark keep-zone
                </Button>
              )}
            </div>
          )}
        </div>

        <div>
          <Label htmlFor="laxii-banner-instructions" className="text-xs">
            Custom instructions (optional)
          </Label>
          <Textarea
            id="laxii-banner-instructions"
            value={instructions}
            maxLength={600}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. more negative space on the left, subtle grain, cooler highlights"
            className="mt-1 min-h-[44px] text-xs"
            rows={2}
          />
        </div>

        <JobProgress job={job} />
        <ResultGrid
          job={job}
          sourceUrl={source && keepZone ? source.url : null}
          compareLabel="Banner"
          applyingId={applyingId}
          onApply={setApplyTarget}
          onRegenerate={regenerate}
        />
      </div>

      {/* fixed bottom action bar — always visible, never scrolls away */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-background/70 px-4 py-2.5 backdrop-blur sm:px-5">
        <p className="hidden min-w-0 truncate text-[11px] text-muted-foreground sm:block">
          {currentUrl ? "Your current banner stays until you apply a new one." : "You have no banner yet — generate one above."}
        </p>
        <Button disabled={!canGenerate || submitting || Boolean(job && (job.status === "RUNNING" || job.status === "QUEUED"))} onClick={regenerate} className="ml-auto">
          <Wand2 className="size-4" aria-hidden /> {submitting ? "Starting…" : "Generate banners"}
        </Button>
      </div>

      <AlertDialog open={Boolean(applyTarget)} onOpenChange={(v) => !v && setApplyTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display">Apply this banner?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current banner ({currentUrl ? "already set" : "none"}) will be replaced on your public profile. The
              generated image and any original you uploaded are both kept — nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => applyTarget && void apply(applyTarget)}>Apply banner</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
