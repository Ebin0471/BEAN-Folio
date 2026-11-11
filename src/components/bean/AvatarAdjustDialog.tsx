"use client";

import { useRef, useState } from "react";
import { Loader2, Minus, Plus, RotateCcw, RotateCw } from "lucide-react";

import type { AvatarAdjust } from "@/lib/types";
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
import { avatarImageStyle, avatarPaintedBox, useNaturalAspect } from "@/components/bean/profile-image";

const BG_SWATCHES: { value: string; label: string }[] = [
  { value: "", label: "Theme default" },
  { value: "#F7F5EF", label: "Porcelain" },
  { value: "#17191D", label: "Graphite" },
  { value: "#090A0C", label: "Ink" },
  { value: "#E8BC51", label: "Champagne" },
  { value: "#FFFFFF", label: "White" },
];

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Live circular editor for the profile avatar. Drag (pointer/touch), zoom,
 * rotate, switch contain/fill and pick a backdrop — Cancel discards, Save
 * persists the metadata (the uploaded file itself is never altered).
 *
 * Mounted only while open (parent conditionally renders it), so the draft
 * state always starts from the last saved adjustment.
 */
export function AvatarAdjustDialog({
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
  initial: AvatarAdjust;
  saving: boolean;
  error: string | null;
  onSave: (adjust: AvatarAdjust) => void;
}) {
  const [draft, setDraft] = useState<AvatarAdjust>(initial);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; posX: number; posY: number } | null>(
    null
  );
  const { aspect, loaded, failed } = useNaturalAspect(src);

  function panBy(dxPct: number, dyPct: number, start?: { posX: number; posY: number }) {
    setDraft((d) => {
      const box = avatarPaintedBox(d, aspect);
      const base = start ?? d;
      const ox = ((base.posX - 50) / 50) * box.rangeX + dxPct;
      const oy = ((base.posY - 50) / 50) * box.rangeY + dyPct;
      return {
        ...d,
        posX: box.rangeX > 0 ? clamp(50 + (ox / box.rangeX) * 50, 0, 100) : 50,
        posY: box.rangeY > 0 ? clamp(50 + (oy / box.rangeY) * 50, 0, 100) : 50,
      };
    });
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (failed || !frameRef.current) return;
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

  const zoomDisabled = failed || saving;

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Adjust avatar image</DialogTitle>
          <DialogDescription>
            Drag to reposition, zoom, rotate and choose how the image fits the circle. Your uploaded file is never
            altered.
          </DialogDescription>
        </DialogHeader>

        {/* live preview inside the real circular mask */}
        <div className="flex flex-col items-center gap-2">
          <div
            ref={frameRef}
            tabIndex={0}
            role="application"
            aria-label="Avatar preview — drag or use arrow keys to reposition the image"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onKeyDown={onKeyDown}
            className={cn(
              "relative aspect-square w-56 touch-none select-none overflow-hidden rounded-full bg-muted ring-1 ring-border",
              failed ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"
            )}
            style={draft.bg ? { backgroundColor: draft.bg } : undefined}
          >
            {src && !failed && (
              <img
                src={src}
                alt="Avatar preview"
                draggable={false}
                className="pointer-events-none select-none"
                style={avatarImageStyle(draft, aspect)}
              />
            )}
            {!loaded && !failed && (
              <span className="absolute inset-0 grid place-items-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading image" />
              </span>
            )}
            {failed && (
              <span className="absolute inset-0 grid place-items-center px-6 text-center text-xs text-muted-foreground">
                The image couldn&apos;t be loaded. Close this dialog and try re-uploading it.
              </span>
            )}
          </div>
          {!failed && <p className="text-[11px] text-muted-foreground">Drag the image · arrow keys nudge</p>}
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
              disabled={zoomDisabled || draft.zoom <= 0.5}
              onClick={() => setDraft((d) => ({ ...d, zoom: clamp(Math.round((d.zoom - 0.1) * 100) / 100, 0.5, 3) }))}
            >
              <Minus className="size-3.5" aria-hidden />
            </Button>
            <Slider
              value={[draft.zoom]}
              min={0.5}
              max={3}
              step={0.05}
              disabled={zoomDisabled}
              aria-label="Zoom"
              onValueChange={(v) => setDraft((d) => ({ ...d, zoom: v[0] }))}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Zoom in"
              disabled={zoomDisabled || draft.zoom >= 3}
              onClick={() => setDraft((d) => ({ ...d, zoom: clamp(Math.round((d.zoom + 0.1) * 100) / 100, 0.5, 3) }))}
            >
              <Plus className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>

        {/* fit + rotate */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <span className="text-sm font-medium">Fit</span>
            <div className="flex gap-1.5" role="group" aria-label="Image fitting mode">
              <Button
                type="button"
                variant={draft.fit === "contain" ? "default" : "outline"}
                size="sm"
                className="h-8 flex-1 text-xs"
                aria-pressed={draft.fit === "contain"}
                disabled={zoomDisabled}
                onClick={() => setDraft((d) => ({ ...d, fit: "contain" }))}
              >
                Contain
              </Button>
              <Button
                type="button"
                variant={draft.fit === "cover" ? "default" : "outline"}
                size="sm"
                className="h-8 flex-1 text-xs"
                aria-pressed={draft.fit === "cover"}
                disabled={zoomDisabled}
                onClick={() => setDraft((d) => ({ ...d, fit: "cover" }))}
              >
                Fill
              </Button>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {draft.fit === "contain"
                ? "Whole image visible inside the circle."
                : "Image fills the circle and may be cropped."}
            </p>
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">Rotate</span>
            <div className="flex gap-1.5" role="group" aria-label="Rotation">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 flex-1 text-xs"
                aria-label="Rotate left"
                disabled={zoomDisabled}
                onClick={() => setDraft((d) => ({ ...d, rotate: (((d.rotate + 270) % 360) as 0 | 90 | 180 | 270) }))}
              >
                <RotateCcw className="size-3.5" aria-hidden /> Left
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 flex-1 text-xs"
                aria-label="Rotate right"
                disabled={zoomDisabled}
                onClick={() => setDraft((d) => ({ ...d, rotate: (((d.rotate + 90) % 360) as 0 | 90 | 180 | 270) }))}
              >
                <RotateCw className="size-3.5" aria-hidden /> Right
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-full text-xs text-muted-foreground"
              disabled={zoomDisabled}
              onClick={() => setDraft((d) => ({ ...d, zoom: 1, posX: 50, posY: 50, rotate: 0 }))}
            >
              <RotateCcw className="size-3" aria-hidden /> Reset position
            </Button>
          </div>
        </div>

        {/* backdrop color for contained / transparent images */}
        <div className="space-y-2">
          <span className="text-sm font-medium">Backdrop color</span>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Backdrop color">
            {BG_SWATCHES.map((s) => (
              <button
                key={s.value || "default"}
                type="button"
                aria-label={s.label}
                aria-pressed={draft.bg === s.value}
                title={s.label}
                disabled={zoomDisabled}
                onClick={() => setDraft((d) => ({ ...d, bg: s.value }))}
                className={cn(
                  "size-7 rounded-full border border-border transition-transform hover:scale-110",
                  draft.bg === s.value && "ring-2 ring-primary ring-offset-2 ring-offset-background"
                )}
                style={
                  s.value
                    ? { backgroundColor: s.value }
                    : {
                        background:
                          "linear-gradient(135deg, transparent 40%, rgba(232,188,81,0.5) 41%, rgba(232,188,81,0.5) 59%, transparent 60%)",
                      }
                }
              />
            ))}
            <label className="ml-1 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="color"
                aria-label="Custom backdrop color"
                value={draft.bg || "#17191d"}
                disabled={zoomDisabled}
                onChange={(e) => setDraft((d) => ({ ...d, bg: e.target.value.toUpperCase() }))}
                className="size-7 cursor-pointer rounded-full border border-border bg-transparent p-0.5"
              />
              Custom
            </label>
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
          <Button onClick={() => onSave(draft)} disabled={saving || failed}>
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
