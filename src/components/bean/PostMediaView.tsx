"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LazyMount } from "@/components/bean/LazyMount";
import { FeedVideoPlayer } from "@/components/bean/FeedVideoPlayer";
import type { PublicPostMedia } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Renders a post's media with real playback:
 *  - VIDEO: inline Instagram-style muted autoplay (one active feed video at
 *    a time, pause on scroll-away, tap to pause/resume, explicit mute/full
 *    screen controls) with an escape hatch to the full player dialog.
 *  - IMAGE x1: full-bleed image with the creator's alt text.
 *  - IMAGE xN: a scroll-snap carousel with dots (no extra dependencies).
 * Media files load from the existing /api/media/[id]/raw streaming route
 * (HTTP Range supported) and are mounted lazily so a feed page never loads
 * every video at once.
 */

export function PostMediaView({
  media,
  className,
  rounded = "rounded-xl",
}: {
  media: PublicPostMedia[];
  className?: string;
  rounded?: string;
}) {
  const [open, setOpen] = useState(false);
  if (media.length === 0) return null;

  const first = media[0];

  if (first.kind === "VIDEO") {
    return (
      <>
        <FeedVideoPlayer media={first} aspect="aspect-video" rounded={rounded} onExpand={() => setOpen(true)} />
        <VideoPlayerDialog media={first} open={open} onOpenChange={setOpen} />
      </>
    );
  }

  if (media.length === 1) {
    return (
      <LazyMount placeholderClassName="aspect-[4/3] w-full animate-pulse rounded-xl bg-secondary/50">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={first.url}
          alt={first.altText || "Post image"}
          loading="lazy"
          className={cn("max-h-[560px] w-full object-cover", rounded)}
        />
      </LazyMount>
    );
  }

  return <ImageCarousel media={media} rounded={rounded} />;
}

export function VideoPlayerDialog({
  media,
  open,
  onOpenChange,
  children,
}: {
  media: PublicPostMedia;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  // Reset the element when the dialog closes so playback + audio stop
  // entirely. The bump happens in the open-change HANDLER (not an effect) —
  // a closed dialog already unmounts the <video>; the key guarantees the
  // next open never reuses a stale runtime element.
  const [runtimeKey, setRuntimeKey] = useState(0);
  const [failed, setFailed] = useState(false);
  function handleOpenChange(v: boolean) {
    if (!v) {
      setRuntimeKey((k) => k + 1);
      setFailed(false);
    }
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg border-border/60 bg-background p-3 sm:max-w-xl">
        <DialogTitle className="sr-only">Video player</DialogTitle>
        <div className="overflow-hidden rounded-lg bg-black">
          {open && !failed ? (
            /* Autoplay with sound rides on the explicit open gesture; if the
               browser refuses, the native controls (visible by default) are
               the honest fallback — the player never retries loud autoplay
               behind the user's back. */
            <video
              key={runtimeKey}
              src={media.url}
              poster={media.posterUrl ?? undefined}
              controls
              autoPlay
              playsInline
              preload="metadata"
              className="max-h-[70vh] w-full"
              aria-label={media.altText || "Video"}
              onError={() => setFailed(true)}
            />
          ) : null}
          {failed ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-white/80">
              <span>Video could not be loaded</span>
              <button
                type="button"
                onClick={() => setFailed(false)}
                className="rounded-md border border-white/30 px-2.5 py-1 text-xs text-white hover:bg-white/10"
              >
                Try again
              </button>
            </div>
          ) : null}
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function ImageCarousel({ media, rounded }: { media: PublicPostMedia[]; rounded: string }) {
  const [index, setIndex] = useState(0);

  function go(delta: number) {
    setIndex((i) => Math.min(media.length - 1, Math.max(0, i + delta)));
  }

  return (
    <div className={cn("relative overflow-hidden", rounded)}>
      <LazyMount placeholderClassName="aspect-[4/3] w-full animate-pulse bg-secondary/50">
        <div className="relative">
          <div className="flex snap-x snap-mandatory overflow-x-auto scrollbar-none" aria-label="Post images">
            {media.map((m, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={m.id}
                src={m.url}
                alt={m.altText || `Post image ${i + 1} of ${media.length}`}
                loading="lazy"
                className="aspect-[4/3] w-full shrink-0 snap-center object-cover"
                onLoad={(e) => {
                  if (i === index) return;
                  // Scrolling may land on a different slide than the buttons set.
                  const el = e.currentTarget.parentElement;
                  if (el) setIndex(Math.round(el.scrollLeft / el.clientWidth));
                }}
              />
            ))}
          </div>
          {media.length > 1 && (
            <>
              {index > 0 && (
                <button
                  type="button"
                  aria-label="Previous image"
                  onClick={() => go(-1)}
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-1.5 text-foreground shadow hover:bg-background"
                >
                  <ChevronLeft className="size-4" aria-hidden />
                </button>
              )}
              {index < media.length - 1 && (
                <button
                  type="button"
                  aria-label="Next image"
                  onClick={() => go(1)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-1.5 text-foreground shadow hover:bg-background"
                >
                  <ChevronRight className="size-4" aria-hidden />
                </button>
              )}
              <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1.5">
                {media.map((m, i) => (
                  <span
                    key={m.id}
                    className={cn("size-1.5 rounded-full transition-colors", i === index ? "bg-primary" : "bg-background/60")}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </LazyMount>
    </div>
  );
}
