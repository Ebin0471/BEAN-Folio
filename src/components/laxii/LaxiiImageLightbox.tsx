"use client";

/**
 * LAXII image lightbox — click-to-open full-resolution preview.
 *
 * One overlay serves every image surface in the studio: message variants,
 * the selected-image bar, uploaded reference thumbnails, the sidebar gallery
 * and the banner canvas. Requirements implemented here:
 *  - Centered image on a dark backdrop, original aspect ratio, always fully
 *    visible (object-contain — never cropped or stretched).
 *  - Zoom in/out + fit-to-screen (buttons, keyboard +/−/0, double-click).
 *    Zoomed images pan by dragging.
 *  - Close via the close button, Escape, or clicking the backdrop.
 *  - Previous/next navigation across the open image set (buttons +
 *    ArrowLeft/ArrowRight) — variations, gallery results, references.
 *  - Loading spinner while the full-resolution file decodes and an honest
 *    error state with retry when it fails.
 *  - Actions: download original, dimensions, favourite, use-this-version,
 *    Edit with LAXII, Generate variations, Continue editing, Remove
 *    background (capability-gated by the caller) and Open conversation.
 *    Action buttons never bubble into the backdrop-close handler.
 *
 * Structure: the parent owns the chrome (top bar, navigation, actions,
 * keyboard Escape/arrows, scroll lock, focus) and renders one
 * <LightboxStage key={index:url}> — the stage owns zoom/pan/load state, so
 * navigating to another image remounts it and resets the viewport without
 * any effect-driven state syncing.
 *
 * Deliberately NOT a Radix Dialog: zoom/pan/drag needs direct control of the
 * stage element, and the overlay must sit above the studio's own dialogs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Heart,
  Loader2,
  Maximize2,
  MessageSquare,
  Pencil,
  RefreshCw,
  TriangleAlert,
  ZoomIn,
  ZoomOut,
  Eraser,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface LightboxItem {
  /** Stable key for the item within its set. */
  key: string;
  /** Full-resolution URL — the same asset URL thumbnails already use. */
  url: string;
  prompt?: string | null;
  width?: number | null;
  height?: number | null;
  /** e.g. "Generate", "Variations" — shown next to the dimensions. */
  operationLabel?: string | null;
  isFavourite?: boolean;
  isSelected?: boolean;
  /** All actions are optional — surfaces without them simply omit the buttons. */
  onSelect?: () => void;
  onFavourite?: () => void;
  onEdit?: () => void;
  onVariations?: () => void;
  onContinue?: () => void;
  onRemoveBackground?: () => void;
  onOpenConversation?: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.4;

// ------------------------------------------------------------------ stage

/**
 * The zoom/pan/load surface for ONE image. Remounted (via key) whenever the
 * shown image changes, so all state starts fresh without effects.
 */
function LightboxStage({ item, onClose }: { item: LightboxItem; onClose: () => void }) {
  const [scale, setScale] = useState(MIN_SCALE);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const clampOffset = useCallback((next: { x: number; y: number }, activeScale: number) => {
    const stage = stageRef.current;
    const content = contentRef.current;
    if (!stage || !content) return next;
    const rect = stage.getBoundingClientRect();
    const cw = content.offsetWidth * activeScale;
    const ch = content.offsetHeight * activeScale;
    const maxX = Math.max(0, (cw - rect.width) / 2);
    const maxY = Math.max(0, (ch - rect.height) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, []);

  const resetView = useCallback(() => {
    setScale(MIN_SCALE);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      setScale((s) => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor));
        if (next === MIN_SCALE) setOffset({ x: 0, y: 0 });
        else setOffset((o) => clampOffset(o, next));
        return next;
      });
    },
    [clampOffset]
  );

  // Zoom keyboard shortcuts (+/−/0). Escape and the arrow keys belong to the
  // parent chrome; this listener lives only while the stage is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomBy(1 / ZOOM_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        resetView();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomBy, resetView]);

  // ---- drag-to-pan when zoomed
  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= MIN_SCALE) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset(clampOffset({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) }, scale));
  };
  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  // Double-click toggles between fit and a comfortable zoom.
  const onDoubleClick = () => {
    if (scale === MIN_SCALE) {
      setScale(2.5);
      setOffset({ x: 0, y: 0 });
    } else {
      resetView();
    }
  };

  // Backdrop click closes — only when the click lands on the backdrop itself,
  // never on the image or the floating controls.
  const onBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const shownDims =
    item.width != null && item.height != null
      ? { w: item.width, h: item.height }
      : natural
        ? { w: natural.w, h: natural.h }
        : null;

  return (
    <div
      ref={stageRef}
      className="relative min-h-0 flex-1 overflow-hidden"
      onClick={onBackdropClick}
      data-testid="laxii-lightbox-stage"
    >
      <div ref={contentRef} className="absolute inset-0 grid place-items-center p-4 sm:p-8" onClick={onBackdropClick}>
        <div
          className="relative"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transition: dragging ? "none" : "transform 160ms ease-out",
            cursor: scale > MIN_SCALE ? (dragging ? "grabbing" : "grab") : "zoom-in",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={onDoubleClick}
          onClick={(e) => e.stopPropagation()}
        >
          {!loaded && !loadError ? (
            <div className="absolute inset-0 grid place-items-center" aria-hidden>
              <Loader2 className="size-8 animate-spin text-white/70" />
            </div>
          ) : null}
          {loadError ? (
            <div
              className="flex w-[min(90vw,26rem)] flex-col items-center gap-3 rounded-2xl border border-white/15 bg-white/[0.06] p-6 text-center"
              data-testid="laxii-lightbox-error"
            >
              <TriangleAlert className="size-6 text-destructive" aria-hidden />
              <p className="text-sm font-medium text-white">The full-resolution image failed to load.</p>
              <p className="text-xs text-white/60">The asset may have been removed or the connection dropped.</p>
              <Button
                variant="outline"
                size="sm"
                className="border-white/20 bg-white/10 text-white hover:bg-white/20"
                onClick={() => {
                  setLoadError(false);
                  setLoaded(false);
                  setReloadTick((t) => t + 1);
                }}
              >
                Retry
              </Button>
            </div>
          ) : (
            <img
              key={`${item.key}#${reloadTick}`}
              src={item.url}
              alt={item.prompt ?? "Generated image"}
              className={cn(
                "max-h-[min(70dvh,900px)] max-w-full rounded-lg object-contain shadow-2xl transition-opacity",
                loaded ? "opacity-100" : "opacity-0"
              )}
              draggable={false}
              onLoad={(e) => {
                setLoaded(true);
                setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
              }}
              onError={() => setLoadError(true)}
            />
          )}
        </div>
      </div>

      {/* Dimensions chip — the real pixel size (DB metadata when present,
          otherwise the freshly decoded natural size). */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10">
        <span
          className="rounded-md bg-black/70 px-2 py-1 text-[11px] text-white/90 backdrop-blur"
          data-testid="laxii-lightbox-dimensions"
        >
          {shownDims ? `${shownDims.w} × ${shownDims.h} px` : "Reading dimensions…"}
        </span>
      </div>

      {/* Floating zoom controls — always reachable, 44px touch targets. */}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-11 rounded-full bg-black/60 text-white/90 backdrop-blur hover:bg-black/80 hover:text-white"
          aria-label="Zoom in"
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          <ZoomIn className="size-5" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 rounded-full bg-black/60 text-white/90 backdrop-blur hover:bg-black/80 hover:text-white"
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          <ZoomOut className="size-5" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 rounded-full bg-black/60 text-white/90 backdrop-blur hover:bg-black/80 hover:text-white"
          aria-label="Fit to screen"
          onClick={resetView}
        >
          <Maximize2 className="size-5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ overlay

export function LaxiiImageLightbox({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  items: LightboxItem[];
  /** null = closed. */
  index: number | null;
  onIndexChange: (next: number) => void;
  onClose: () => void;
}) {
  const open = index !== null && items.length > 0 && index >= 0 && index < items.length;
  const item = open ? items[index] : null;

  // Body scroll lock + Escape / arrow-key navigation.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" && index < items.length - 1) {
        e.preventDefault();
        onIndexChange(index + 1);
      } else if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        onIndexChange(index - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, index, items.length, onClose, onIndexChange]);

  // Move focus to the close button while open; restore it on close.
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      closeRef.current?.focus({ preventScroll: true });
      return () => {
        restoreFocusRef.current?.focus?.();
      };
    }
    return undefined;
  }, [open]);

  // Gentle warm-up of the neighbours so prev/next feels instant.
  useEffect(() => {
    if (!open) return;
    for (const i of [index + 1, index - 1]) {
      if (i >= 0 && i < items.length) {
        const im = new Image();
        im.src = items[i].url;
      }
    }
  }, [open, index, items]);

  if (!open || !item) return null;

  const multi = items.length > 1;

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-black/90 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={item.prompt ? `Image preview: ${item.prompt.slice(0, 80)}` : "Image preview"}
      data-testid="laxii-lightbox"
    >
      {/* Top bar — prompt/title, operation + position, close */}
      <div className="flex shrink-0 items-start gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{item.prompt || "Image preview"}</p>
          <p className="mt-0.5 text-xs text-white/60">
            {item.operationLabel ? `${item.operationLabel} · ` : ""}
            {multi ? `${index + 1} / ${items.length}` : ""}
          </p>
        </div>
        <Button
          ref={closeRef}
          variant="ghost"
          size="icon"
          className="size-10 shrink-0 text-white/80 hover:bg-white/10 hover:text-white"
          aria-label="Close preview"
          onClick={onClose}
          data-testid="laxii-lightbox-close"
        >
          <X className="size-5" aria-hidden />
        </Button>
      </div>

      {/* Stage — remounts per image, so zoom/pan always start at fit-to-screen. */}
      <LightboxStage key={`${index}:${item.url}`} item={item} onClose={onClose} />

      {/* Prev / next — overlaid on the stage edges, 44px touch targets. */}
      {multi ? (
        <>
          <button
            type="button"
            aria-label="Previous image"
            disabled={index === 0}
            onClick={() => onIndexChange(index - 1)}
            className={cn(
              "absolute left-2 top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white backdrop-blur transition-opacity hover:bg-black/80",
              index === 0 ? "pointer-events-none opacity-0" : "opacity-90"
            )}
            data-testid="laxii-lightbox-prev"
          >
            <ChevronLeft className="size-6" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next image"
            disabled={index === items.length - 1}
            onClick={() => onIndexChange(index + 1)}
            className={cn(
              "absolute right-2 top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white backdrop-blur transition-opacity hover:bg-black/80",
              index === items.length - 1 ? "pointer-events-none opacity-0" : "opacity-90"
            )}
            data-testid="laxii-lightbox-next"
          >
            <ChevronRight className="size-6" aria-hidden />
          </button>
        </>
      ) : null}

      {/* Actions bar — stopPropagation keeps clicks here from closing the
          lightbox; every action is an explicit callback provided by the
          caller (capability-gated server-side). */}
      <div
        className="shrink-0 border-t border-white/10 bg-black/60 px-4 py-3 sm:px-6"
        onClick={(e) => e.stopPropagation()}
        data-testid="laxii-lightbox-actions"
      >
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-1.5">
          <Button variant="outline" size="sm" asChild className="h-9 border-white/20 bg-white/10 text-white hover:bg-white/20">
            <a href={item.url} download target="_blank" rel="noreferrer" aria-label="Download original image">
              <Download className="size-4" aria-hidden /> Download
            </a>
          </Button>
          {item.onSelect ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 border-white/20 bg-white/10 text-white hover:bg-white/20"
              onClick={item.onSelect}
              disabled={item.isSelected}
              aria-label={item.isSelected ? "This version is selected" : "Use this version"}
            >
              {item.isSelected ? "Selected" : "Use this version"}
            </Button>
          ) : null}
          {item.onFavourite ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 border-white/20 bg-white/10 text-white hover:bg-white/20"
              onClick={item.onFavourite}
              aria-label={item.isFavourite ? "Remove from favourites" : "Add to favourites"}
            >
              <Heart className={cn("size-4", item.isFavourite && "fill-primary text-primary")} aria-hidden />
              {item.isFavourite ? "Saved" : "Save"}
            </Button>
          ) : null}
          {item.onEdit ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 border-white/20 bg-white/10 text-white hover:bg-white/20"
              onClick={item.onEdit}
            >
              <Pencil className="size-4" aria-hidden /> Edit with LAXII
            </Button>
          ) : null}
          {item.onVariations ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 border-white/20 bg-white/10 text-white hover:bg-white/20"
              onClick={item.onVariations}
            >
              <RefreshCw className="size-4" aria-hidden /> Variations
            </Button>
          ) : null}
          {item.onRemoveBackground ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 border-white/20 bg-white/10 text-white hover:bg-white/20"
              onClick={item.onRemoveBackground}
            >
              <Eraser className="size-4" aria-hidden /> Remove background
            </Button>
          ) : null}
          {item.onContinue ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 border-white/20 bg-white/10 text-white hover:bg-white/20"
              onClick={item.onContinue}
            >
              <Pencil className="size-4" aria-hidden /> Continue editing
            </Button>
          ) : null}
          {item.onOpenConversation ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 border-white/20 bg-white/10 text-white hover:bg-white/20"
              onClick={item.onOpenConversation}
            >
              <MessageSquare className="size-4" aria-hidden /> Open conversation
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
