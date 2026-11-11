"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import type { AvatarAdjust, CoverAdjust } from "@/lib/types";
import { DEFAULT_AVATAR_ADJUST, DEFAULT_COVER_ADJUST } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Profile image presentation — one rendering model shared by My Folio, the
 * public profile and the adjust dialogs so what you edit is exactly what
 * every visitor sees. The original uploaded file is never modified; only
 * this metadata (fit / zoom / focal position / rotation / backdrop) is
 * persisted on the User record.
 */

// ------------------------------------------------------------------ normalizers

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Client-side normalizer — defensive against stale cached payloads. */
export function normalizeAvatarAdjust(raw?: Partial<AvatarAdjust> | null): AvatarAdjust {
  if (!raw) return { ...DEFAULT_AVATAR_ADJUST };
  return {
    fit: raw.fit === "cover" ? "cover" : "contain",
    zoom: clampNum(raw.zoom, 0.5, 3, 1),
    posX: clampNum(raw.posX, 0, 100, 50),
    posY: clampNum(raw.posY, 0, 100, 50),
    rotate: raw.rotate === 90 || raw.rotate === 180 || raw.rotate === 270 ? raw.rotate : 0,
    bg: typeof raw.bg === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.bg) ? raw.bg : "",
  };
}

export function normalizeCoverAdjust(raw?: Partial<CoverAdjust> | null): CoverAdjust {
  if (!raw) return { ...DEFAULT_COVER_ADJUST };
  return {
    zoom: clampNum(raw.zoom, 1, 3, 1),
    posX: clampNum(raw.posX, 0, 100, 50),
    posY: clampNum(raw.posY, 0, 100, 50),
  };
}

// ------------------------------------------------------------------ natural aspect

/** Module-level cache so re-opened dialogs and re-rendered avatars skip the flash. */
const aspectCache = new Map<string, number>();

/** Load an image just to read its natural aspect ratio (browser-cached, cheap). */
export function useNaturalAspect(src: string | null | undefined): {
  aspect: number;
  loaded: boolean;
  failed: boolean;
} {
  const [state, setState] = useState<{ aspect: number; loaded: boolean; failed: boolean }>(() => {
    const cached = src ? aspectCache.get(src) : undefined;
    return cached ? { aspect: cached, loaded: true, failed: false } : { aspect: 1, loaded: false, failed: false };
  });
  // Reset synchronously during render when the src changes — the React-recommended
  // derived-state pattern (a cache hit avoids any flash for known images).
  const [watchedSrc, setWatchedSrc] = useState<string | null | undefined>(src);
  if (src !== watchedSrc) {
    setWatchedSrc(src);
    const cached = src ? aspectCache.get(src) : undefined;
    setState(cached ? { aspect: cached, loaded: true, failed: false } : { aspect: 1, loaded: false, failed: false });
  }
  useEffect(() => {
    if (!src) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (alive && img.naturalWidth > 0) {
        aspectCache.set(src, img.naturalWidth / img.naturalHeight);
        setState({ aspect: img.naturalWidth / img.naturalHeight, loaded: true, failed: false });
      }
    };
    img.onerror = () => {
      if (alive) setState({ aspect: 1, loaded: false, failed: true });
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return state;
}

// ------------------------------------------------------------------ avatar math

/**
 * Painted box for the circular avatar, in % of the square frame, for the
 * saved adjustment. Rotation swaps the fitting aspect so a rotated image
 * still fits exactly. posX/posY are object-position-style focal percentages
 * mapped onto the available pan range (range = |painted − frame| / 2), so
 * 0–100 always spans the full possible pan at any zoom — the same semantics
 * as CSS object-position.
 */
export function avatarPaintedBox(adjust: AvatarAdjust, aspect: number): {
  w: number;
  h: number;
  ox: number;
  oy: number;
  rangeX: number;
  rangeY: number;
} {
  const a = adjust.rotate % 180 === 90 ? 1 / aspect : aspect;
  let w: number;
  let h: number;
  if (adjust.fit === "cover") {
    w = Math.max(100, 100 * a);
    h = Math.max(100, 100 / a);
  } else {
    w = Math.min(100, 100 * a);
    h = Math.min(100, 100 / a);
  }
  w *= adjust.zoom;
  h *= adjust.zoom;
  // Pan range: keep the frame fully covered (no gaps) and, in contain mode,
  // the whole image inside the circle (no cropping) unless the user zooms in.
  const rangeX = Math.abs(w - 100) / 2;
  const rangeY = Math.abs(h - 100) / 2;
  const ox = ((adjust.posX - 50) / 50) * rangeX;
  const oy = ((adjust.posY - 50) / 50) * rangeY;
  return { w, h, ox, oy, rangeX, rangeY };
}

/** Inline style for the adjusted avatar <img> (center = frame center + offset, rotated). */
export function avatarImageStyle(adjust: AvatarAdjust, aspect: number): CSSProperties {
  const a = normalizeAvatarAdjust(adjust);
  const box = avatarPaintedBox(a, aspect);
  return {
    position: "absolute",
    left: `${50 + box.ox}%`,
    top: `${50 + box.oy}%`,
    width: `${box.w}%`,
    height: `${box.h}%`,
    maxWidth: "none",
    transform: `translate(-50%, -50%) rotate(${a.rotate}deg)`,
  };
}

// ------------------------------------------------------------------ components

/**
 * Complete circular avatar that honors the saved adjustments.
 * Square container → aspect-ratio 1 → border-radius 50% → overflow hidden.
 * With `contain` (default) the whole source image stays visible and the
 * backdrop color letterboxes the rest; with `cover` the circle is filled.
 */
export function AdjustedAvatar({
  src,
  alt,
  adjust,
  className,
  fallback,
}: {
  src: string | null;
  alt: string;
  adjust?: Partial<AvatarAdjust> | null;
  className?: string;
  fallback?: ReactNode;
}) {
  const a = normalizeAvatarAdjust(adjust);
  const { aspect } = useNaturalAspect(src);
  return (
    <span
      className={cn("relative block aspect-square overflow-hidden rounded-full bg-muted", className)}
      style={a.bg ? { backgroundColor: a.bg } : undefined}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="pointer-events-none select-none"
          style={avatarImageStyle(a, aspect)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}

/**
 * Cover banner image honoring the saved focal adjustments.
 * Renders object-fit: cover with object-position: {posX}% {posY}% plus an
 * optional scale(zoom) anchored at the focal point — so any saved value is
 * expressible (e.g. posX 50 + posY 35 ≈ object-position: 50% 35%) and the
 * same percentages adapt naturally across responsive banner heights.
 * The PARENT must clip (add overflow-hidden) since zoom can overpaint.
 */
export function AdjustedCover({
  src,
  alt,
  adjust,
  className,
}: {
  src: string | null;
  alt: string;
  adjust?: Partial<CoverAdjust> | null;
  className?: string;
}) {
  const a = normalizeCoverAdjust(adjust);
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      className={cn("h-full w-full object-cover", className)}
      style={{
        objectPosition: `${a.posX}% ${a.posY}%`,
        transform: a.zoom !== 1 ? `scale(${a.zoom})` : undefined,
        transformOrigin: `${a.posX}% ${a.posY}%`,
      }}
    />
  );
}
