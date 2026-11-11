"use client";

import { useState } from "react";
import { FileText, Film, ImageOff, Play } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Media thumbnail with graceful fallbacks. Used for project covers, gallery
 * items and avatars. Video items show a play affordance; documents a file icon.
 */
export function MediaThumb({
  src,
  alt,
  kind,
  className,
  aspect = "aspect-[4/3]",
  fit = "object-cover",
}: {
  src: string | null | undefined;
  alt: string;
  kind?: string;
  className?: string;
  aspect?: string;
  fit?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className={cn(aspect, "grid w-full place-items-center bg-muted text-muted-foreground", className)}>
        <ImageOff className="size-7 opacity-50" aria-hidden />
        <span className="sr-only">{alt}</span>
      </div>
    );
  }

  if (kind === "VIDEO") {
    return (
      <div className={cn(aspect, "relative w-full overflow-hidden bg-muted", className)}>
        <video
          src={src}
          className={cn("h-full w-full", fit)}
          muted
          playsInline
          preload="metadata"
          onError={() => setFailed(true)}
          aria-label={alt}
        />
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-11 place-items-center rounded-full bg-background/70 text-foreground ring-1 ring-border backdrop-blur-sm">
            <Play className="size-5 translate-x-[1px]" aria-hidden />
          </span>
        </span>
      </div>
    );
  }

  if (kind === "DOCUMENT" || kind === "AUDIO") {
    return (
      <div className={cn(aspect, "grid w-full place-items-center bg-muted text-muted-foreground", className)}>
        {kind === "DOCUMENT" ? <FileText className="size-7 opacity-60" aria-hidden /> : <Film className="size-7 opacity-60" aria-hidden />}
        <span className="sr-only">{alt}</span>
      </div>
    );
  }

  return (
    <div className={cn(aspect, "relative w-full overflow-hidden bg-muted", className)}>
      {/* Plain <img>: sources are same-origin API streams (dynamic auth-aware cache headers), so next/image optimization is not applicable. */}
      <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className={cn("h-full w-full", fit)} />
    </div>
  );
}
