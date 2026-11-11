"use client";

/**
 * LAXII Banner Studio panel — preset picker, real-canvas preview with
 * text-safe-area guides, and validated export (PNG / JPEG / WebP).
 *
 * The preview renders the selected version inside a true-ratio canvas with
 * the preset's safe-area rectangle overlaid, so users see exactly what will
 * remain visible on the target platform (e.g. YouTube's central safe zone).
 */

import { useState } from "react";
import { Check, Download, Loader2, Ruler } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { laxiiApi, type LaxiiBannerPreset, type LaxiiVersion } from "@/lib/laxii-client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function LaxiiBannerPanel({
  version,
  preset,
  canvasWidth,
  canvasHeight,
  presets,
  onOpenPreview,
  approvalRequired,
  approved,
}: {
  version: LaxiiVersion;
  preset: LaxiiBannerPreset | null;
  canvasWidth: number;
  canvasHeight: number;
  presets: LaxiiBannerPreset[];
  /** Opens the click-to-open full-screen image preview for this version. */
  onOpenPreview?: () => void;
  /** Phase 3: brief-produced banners require the user's approval before export. */
  approvalRequired?: boolean;
  approved?: boolean;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState<"png" | "jpeg" | "webp">("png");
  const [exporting, setExporting] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [result, setResult] = useState<{ url: string; width: number; height: number; mime: string } | null>(null);

  async function runExport() {
    setExporting(true);
    try {
      const res = await laxiiApi.exportBanner(version.id, format);
      setResult(res.export);
      toast.success(`Exported at exactly ${res.export.width}×${res.export.height} ${res.export.mime.split("/")[1].toUpperCase()}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const activePreset =
    preset ?? presets.find((p) => p.width === canvasWidth && p.height === canvasHeight) ?? null;
  const safe = activePreset?.safeArea ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => setExportOpen(true)}
          className="gap-1.5"
          disabled={Boolean(approvalRequired && !approved)}
          data-testid="laxii-banner-export"
        >
          <Download className="size-3.5" aria-hidden /> Export banner
        </Button>
        {approvalRequired && !approved ? (
          <span className="text-xs text-muted-foreground">Approve the result in the thread to unlock export.</span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowGuides((v) => !v)}
          className={cn("gap-1.5 border-white/15 bg-white/[0.04]", showGuides && "border-primary/40 text-primary")}
        >
          <Ruler className="size-3.5" aria-hidden /> {showGuides ? "Hide" : "Show"} safe area
        </Button>
        <span className="text-xs text-muted-foreground">
          Canvas {canvasWidth}×{canvasHeight}
          {activePreset ? ` · ${activePreset.label}` : ""}
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-3">
        <div
          className="relative mx-auto"
          style={{
            aspectRatio: `${canvasWidth} / ${canvasHeight}`,
            maxWidth: "100%",
            // Width derives from a viewport-height budget so the whole panel
            // (preview + composer below) always fits inside the studio without
            // pushing the composer off-screen. The ratio stays true, so the
            // safe-area overlay remains pixel-faithful to the real canvas.
            width: `min(880px, ${canvasWidth}px, calc(min(42dvh, 420px) * ${canvasWidth / canvasHeight}))`,
          }}
          data-testid="laxii-banner-canvas"
        >
          {onOpenPreview ? (
            <button
              type="button"
              className="absolute inset-0 cursor-zoom-in"
              aria-label="Open banner in the full-screen image preview"
              onClick={onOpenPreview}
            >
              <img
                src={version.url}
                alt={`Banner preview${version.prompt ? `: ${version.prompt.slice(0, 60)}` : ""}`}
                // object-contain: the FULL composition is always visible — the
                // preview never lies by cropping the underlying image (the canvas
                // ratio and the stored asset ratio match for every new banner).
                className="h-full w-full rounded-lg bg-black/40 object-contain"
              />
            </button>
          ) : (
            <img
              src={version.url}
              alt={`Banner preview${version.prompt ? `: ${version.prompt.slice(0, 60)}` : ""}`}
              // object-contain: the FULL composition is always visible — the
              // preview never lies by cropping the underlying image (the canvas
              // ratio and the stored asset ratio match for every new banner).
              className="absolute inset-0 h-full w-full rounded-lg bg-black/40 object-contain"
            />
          )}
          {showGuides && safe ? (
            <div
              className="pointer-events-none absolute rounded-md border-2 border-dashed border-primary/80"
              style={{
                left: `${(safe.x / canvasWidth) * 100}%`,
                top: `${(safe.y / canvasHeight) * 100}%`,
                width: `${(safe.width / canvasWidth) * 100}%`,
                height: `${(safe.height / canvasHeight) * 100}%`,
              }}
              aria-label="Text-safe area guide"
            >
              <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                Text-safe area
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {activePreset ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{activePreset.description}</p>
      ) : null}

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Export banner</DialogTitle>
            <DialogDescription>
              Re-encoded to exactly {canvasWidth}×{canvasHeight} and verified before download.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={format} onValueChange={(v) => setFormat(v as typeof format)}>
              <SelectTrigger aria-label="Export format" className="border-white/10 bg-white/[0.04]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png">PNG — lossless, transparency preserved</SelectItem>
                <SelectItem value="jpeg">JPEG — smallest photos</SelectItem>
                <SelectItem value="webp">WebP — modern, efficient</SelectItem>
              </SelectContent>
            </Select>
            {result ? (
              <div className="rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm" data-testid="laxii-banner-export-result">
                <p className="flex items-center gap-2 font-medium text-primary">
                  <Check className="size-4" aria-hidden /> Verified {result.width}×{result.height}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {result.mime} ·{" "}
                  <a href={result.url} download className="underline hover:text-primary">
                    Download exported file
                  </a>
                </p>
              </div>
            ) : null}
            <Button onClick={runExport} disabled={exporting} className="w-full" data-testid="laxii-banner-export-run">
              {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {exporting ? "Exporting…" : `Export ${format.toUpperCase()}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
