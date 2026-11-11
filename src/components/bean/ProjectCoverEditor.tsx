"use client";

import { useRef, useState } from "react";
import { Loader2, Minus, Plus } from "lucide-react";

import type { CoverAdjust } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { normalizeCoverAdjust } from "@/components/bean/profile-image";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export const COVER_DERIVATIVE_WIDTH = 1600;
export const COVER_DERIVATIVE_HEIGHT = 900;

/**
 * Render the same model the live preview shows (object-fit: cover +
 * object-position + focal-anchored zoom) into an optimized 16:9 JPEG blob.
 * The original uploaded image is never modified — the derivative is a new,
 * display-sized file used as the project cover.
 */
export async function cropCoverToBlob(
  src: string,
  adjust: CoverAdjust,
  outW = COVER_DERIVATIVE_WIDTH,
  outH = COVER_DERIVATIVE_HEIGHT
): Promise<Blob> {
  const { zoom, posX, posY } = normalizeCoverAdjust(adjust);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not load the image for cropping"));
    el.src = src;
  });

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported in this browser");

  // object-fit: cover base fit
  const baseScale = Math.max(outW / img.naturalWidth, outH / img.naturalHeight);
  const w = img.naturalWidth * baseScale;
  const h = img.naturalHeight * baseScale;
  // object-position: posX% posY%
  const dx = -(w - outW) * (posX / 100);
  const dy = -(h - outH) * (posY / 100);
  // transform-origin anchor (same point the CSS preview scales around)
  const px = dx + w * (posX / 100);
  const py = dy + h * (posY / 100);

  ctx.fillStyle = "#ffffff"; // flatten transparency predictably
  ctx.fillRect(0, 0, outW, outH);
  ctx.setTransform(zoom, 0, 0, zoom, px * (1 - zoom), py * (1 - zoom));
  ctx.drawImage(img, dx, dy, w, h);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob && blob.size > 0) resolve(blob);
        else reject(new Error("Could not export the cropped cover"));
      },
      "image/jpeg",
      0.92
    );
  });
}

function coverFileName(kind: string): string {
  const ext = kind === "image/png" ? "png" : kind === "image/webp" ? "webp" : "jpg";
  return `project-cover-16x9.${ext}`;
}

/**
 * Project cover editor — 16:9 recommended frame with drag-to-reposition,
 * arrow-key nudging and a zoom slider. Save hands the chosen framing back to
 * the caller, which generates the optimized derivative and uploads it.
 * The dialog mirrors CoverAdjustDialog's interaction model (what you drag is
 * exactly how cards and hero sections will crop the cover).
 */
export function ProjectCoverEditor({
  open,
  onOpenChange,
  src,
  initial,
  saving,
  error,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  src: string;
  initial: CoverAdjust;
  saving: boolean;
  error: string | null;
  onSave: (adjust: CoverAdjust, fileMeta: { name: string; type: string }) => void;
}) {
  const [draft, setDraft] = useState<CoverAdjust>(normalizeCoverAdjust(initial));
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; posX: number; posY: number } | null>(
    null
  );
  const [imgFailed, setImgFailed] = useState(false);

  // Dragging the artwork rightward reveals what is to its left, i.e. the focal
  // point moves left — object-position semantics, inverted sign.
  function panBy(dxPct: number, dyPct: number, start?: { posX: number; posY: number }) {
    setDraft((d) => {
      const base = start ?? d;
      return {
        ...d,
        posX: clamp(base.posX - dxPct, 0, 100),
        posY: clamp(base.posY - dyPct, 0, 100),
      };
    });
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (imgFailed || !frameRef.current) return;
    e.preventDefault();
    frameRef.current.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, posX: draft.posX, posY: draft.posY };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !frameRef.current) return;
    const rect = frameRef.current.getBoundingClientRect();
    panBy(((e.clientX - drag.startX) / rect.width) * 100, ((e.clientY - drag.startY) / rect.height) * 100, drag);
  }

  function onPointerEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = 2;
    if (e.key === "ArrowLeft") { e.preventDefault(); panBy(-step, 0); }
    else if (e.key === "ArrowRight") { e.preventDefault(); panBy(step, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); panBy(0, -step); }
    else if (e.key === "ArrowDown") { e.preventDefault(); panBy(0, step); }
  }

  const disabled = imgFailed || saving;

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">Adjust cover image</DialogTitle>
          <DialogDescription>
            Drag to reposition and zoom to crop — the cover is displayed at 16:9 across cards, grids and the project page.
          </DialogDescription>
        </DialogHeader>

        {/* 16:9 live preview — the exact crop that will be saved */}
        <div className="space-y-1.5">
          <div
            ref={frameRef}
            tabIndex={0}
            role="application"
            aria-label="Cover preview — drag or use arrow keys to reposition the artwork"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onKeyDown={onKeyDown}
            className={cn(
              "relative aspect-video w-full touch-none select-none overflow-hidden rounded-xl bg-muted ring-1 ring-border",
              imgFailed ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"
            )}
          >
            {src && !imgFailed && (
              <img
                src={src}
                alt="Cover preview"
                draggable={false}
                className="pointer-events-none h-full w-full select-none object-cover"
                style={{
                  objectPosition: `${draft.posX}% ${draft.posY}%`,
                  transform: draft.zoom !== 1 ? `scale(${draft.zoom})` : undefined,
                  transformOrigin: `${draft.posX}% ${draft.posY}%`,
                }}
              />
            )}
            {imgFailed && (
              <span className="absolute inset-0 grid place-items-center px-6 text-center text-xs text-muted-foreground">
                The image couldn&apos;t be loaded. Close this dialog and try re-uploading it.
              </span>
            )}
          </div>
          {!imgFailed && <p className="text-[11px] text-muted-foreground">Drag the image · arrow keys nudge</p>}
        </div>

        {/* zoom */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Zoom</span>
            <span className="text-xs tabular-nums text-muted-foreground">{draft.zoom.toFixed(2)}×</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Zoom out"
              disabled={disabled || draft.zoom <= 1}
              onClick={() => setDraft((d) => ({ ...d, zoom: clamp(Math.round((d.zoom - 0.1) * 100) / 100, 1, 3) }))}
            >
              <Minus className="size-3.5" aria-hidden />
            </Button>
            <Slider
              value={[draft.zoom]}
              min={1}
              max={3}
              step={0.05}
              disabled={disabled}
              aria-label="Zoom"
              onValueChange={(v) => setDraft((d) => ({ ...d, zoom: v[0] }))}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Zoom in"
              disabled={disabled || draft.zoom >= 3}
              onClick={() => setDraft((d) => ({ ...d, zoom: clamp(Math.round((d.zoom + 0.1) * 100) / 100, 1, 3) }))}
            >
              <Plus className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>

        {/* focal position shortcuts */}
        <div className="space-y-2">
          <span className="text-sm font-medium">Focal position</span>
          <div className="flex gap-1.5" role="group" aria-label="Focal position">
            {(
              [
                { label: "Top", posY: 18 },
                { label: "Center", posY: 50 },
                { label: "Bottom", posY: 82 },
              ] as const
            ).map((p) => (
              <Button
                key={p.label}
                type="button"
                variant={draft.posY === p.posY ? "default" : "outline"}
                size="sm"
                className="h-8 flex-1 text-xs"
                aria-pressed={draft.posY === p.posY}
                disabled={disabled}
                onClick={() => setDraft((d) => ({ ...d, posY: p.posY }))}
              >
                {p.label}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground"
              disabled={disabled}
              onClick={() => setDraft({ zoom: 1, posX: 50, posY: 50 })}
            >
              Reset
            </Button>
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => onSave(draft, { name: coverFileName("image/jpeg"), type: "image/jpeg" })}
            disabled={saving || imgFailed}
          >
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
