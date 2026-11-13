"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Expand, Loader2, Maximize2, Play, Volume2, VolumeX } from "lucide-react";

import { LazyMount } from "@/components/bean/LazyMount";
import { FEED_VIDEO, prefersReducedMotion, useFeedVideo } from "@/lib/feed-video";
import type { PublicPostMedia } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Inline feed video player with Instagram-style behavior:
 *  - mounts lazily (LazyMount) so a feed page never loads every video at once
 *  - autoplay starts MUTED when the video becomes the dominant visible video
 *    (IntersectionObserver ratio >= PLAY_AT) and pauses when it scrolls away
 *  - exactly ONE video plays at any time: playback is claimed through the
 *    feed-video store, which pauses the previous active element first
 *  - tap on the video surface pauses/resumes; action buttons live OUTSIDE
 *    this surface (and every control stops propagation) so touching
 *    like/comment/share/mute can never toggle playback accidentally
 *  - mute/unmute is an explicit control; sound is never forced
 *  - autoplay refused by the browser (or a reduced-motion preference) shows
 *    a clear manual play control instead of fighting the policy
 *  - loading indicator, playback progress, error state with retry, native
 *    fullscreen, poster frames and lazy sources are handled here
 */
export function FeedVideoPlayer({
  media,
  aspect = "aspect-video",
  rounded = "rounded-xl",
  onExpand,
  className,
}: {
  media: PublicPostMedia;
  aspect?: string;
  rounded?: string;
  /** Optional escape hatch to the existing full player dialog. */
  onExpand?: () => void;
  className?: string;
}) {
  // The store is keyed by COMPONENT INSTANCE (not media id): the same reel
  // can render in the reels grid AND the posts feed simultaneously — two live
  // instances sharing one key would let the off-screen twin's release cancel
  // the visible one's claim. Per-instance keys keep the one-active-video
  // guarantee while letting each card coordinate independently.
  const id = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const reducedMotionRef = useRef<boolean>(false);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const muted = useFeedVideo((s) => s.muted);
  const claim = useFeedVideo((s) => s.claim);
  const release = useFeedVideo((s) => s.release);
  const userToggle = useFeedVideo((s) => s.userToggle);
  const userPlay = useFeedVideo((s) => s.userPlay);
  const setMuted = useFeedVideo((s) => s.setMuted);
  const unregister = useFeedVideo((s) => s.unregister);

  useEffect(() => {
    reducedMotionRef.current = prefersReducedMotion();
  }, []);

  // Video element callback ref: when the element mounts AFTER the store
  // already claimed this video (LazyMount flipped while the wrapper stayed
  // dominant on screen), start playback immediately — otherwise the claim
  // would sit on a null element forever.
  const attachVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      videoElRef.current = el;
      if (el && useFeedVideo.getState().activeId === id && el.paused) {
        claim(id, el, { reducedMotion: reducedMotionRef.current });
      }
    },
    [id, claim]
  );

  // Visibility observation: the OBSERVED wrapper ALWAYS exists (the
  // aspect-ratio box, placeholder included) so the IntersectionObserver
  // attaches at mount regardless of LazyMount state. Dominant visibility
  // claims playback through the store (pausing the previous active video
  // first); dropping below the stop threshold releases it. Unmount releases
  // + unregisters so a destroyed element can never ghost-block the next.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const ratio = entries[0]?.intersectionRatio ?? 0;
        const video = videoElRef.current;
        if (ratio >= FEED_VIDEO.PLAY_AT) {
          claim(id, video, { reducedMotion: reducedMotionRef.current });
        } else if (ratio < FEED_VIDEO.STOP_AT) {
          release(id, video);
        }
      },
      { threshold: [0, FEED_VIDEO.STOP_AT, FEED_VIDEO.PLAY_AT, 1] }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      release(id, videoElRef.current);
      unregister(id);
    };
  }, [id, claim, release, unregister]);

  const syncPlaying = useCallback(() => setPlaying(!videoElRef.current?.paused), []);

  const toggleTap = useCallback(() => {
    userToggle(id, videoElRef.current, { reducedMotion: reducedMotionRef.current });
    syncPlaying();
  }, [id, userToggle, syncPlaying]);

  const manualPlay = useCallback(() => {
    userPlay(id, videoElRef.current);
    syncPlaying();
  }, [id, userPlay, syncPlaying]);

  function onTimeUpdate() {
    const v = videoElRef.current;
    if (v && Number.isFinite(v.duration) && v.duration > 0) {
      setProgress(Math.min(100, (v.currentTime / v.duration) * 100));
    }
  }

  return (
    <div ref={wrapRef} className={cn("group relative overflow-hidden bg-black/40", rounded, aspect, className)}>
      <LazyMount placeholderClassName="h-full w-full animate-pulse bg-secondary/50">
        <div className="relative h-full w-full">
          <video
            key={retryKey}
            ref={attachVideo}
            src={media.url}
            poster={media.posterUrl ?? undefined}
            muted={muted}
            loop
            playsInline
            preload={media.posterUrl ? "none" : "metadata"}
            aria-label={media.altText || "Video"}
            className="h-full w-full cursor-pointer object-cover"
            onClick={toggleTap}
            onPlay={syncPlaying}
            onPause={syncPlaying}
            onWaiting={() => setWaiting(true)}
            onPlaying={() => setWaiting(false)}
            onCanPlay={() => setWaiting(false)}
            onTimeUpdate={onTimeUpdate}
            onError={() => {
              setFailed(true);
              setWaiting(false);
            }}
          />

          {/* Loading indicator */}
          {waiting && !failed ? (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
              <Loader2 className="size-8 animate-spin text-white/80" />
            </span>
          ) : null}

          {/* Manual play / resume control — shown whenever the video is not
              playing (autoplay refused, user paused, or not yet started). */}
          {!playing && !failed && !waiting ? (
            <button
              type="button"
              onClick={manualPlay}
              aria-label="Play video"
              className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors hover:bg-black/30"
            >
              <span className="flex size-14 items-center justify-center rounded-full bg-primary/90 text-primary-foreground shadow-lg transition-transform hover:scale-105">
                <Play className="ml-0.5 size-6" aria-hidden />
              </span>
            </button>
          ) : null}

          {/* Playback progress (thin indicator mirroring the media). */}
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/20 transition-opacity",
              playing ? "opacity-100" : "opacity-0"
            )}
          >
            <span className="block h-full bg-primary" style={{ width: `${progress}%` }} />
          </span>

          {/* Error state with retry. */}
          {failed ? (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 px-4 text-center">
              <AlertTriangle className="size-6 text-white/80" aria-hidden />
              <span className="text-xs text-white/80">Video unavailable</span>
              <button
                type="button"
                onClick={() => {
                  setFailed(false);
                  setProgress(0);
                  setRetryKey((k) => k + 1);
                }}
                className="rounded-md border border-white/30 px-2.5 py-1 text-xs text-white hover:bg-white/10"
              >
                Try again
              </button>
            </span>
          ) : null}

          {/* Corner controls — each stops propagation so control taps never
              toggle playback. Fullscreen on the wrapper element. */}
          <span className="absolute right-2 top-2 flex items-center gap-1.5 opacity-90 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMuted(!muted);
                if (videoElRef.current) videoElRef.current.muted = !muted;
              }}
              aria-label={muted ? "Unmute video" : "Mute video"}
              aria-pressed={!muted}
              className="flex size-8 items-center justify-center rounded-full bg-black/55 text-white shadow hover:bg-black/75"
            >
              {muted ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const el = wrapRef.current;
                if (el && el.requestFullscreen) el.requestFullscreen().catch(() => undefined);
              }}
              aria-label="Fullscreen video"
              className="flex size-8 items-center justify-center rounded-full bg-black/55 text-white shadow hover:bg-black/75"
            >
              <Maximize2 className="size-4" aria-hidden />
            </button>
            {onExpand ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onExpand();
                }}
                aria-label="Open video player"
                className="flex size-8 items-center justify-center rounded-full bg-black/55 text-white shadow hover:bg-black/75"
              >
                <Expand className="size-4" aria-hidden />
              </button>
            ) : null}
          </span>

          <span className="sr-only" role="status">
            {playing ? "Video playing, muted" : "Video paused"}
          </span>
        </div>
      </LazyMount>
    </div>
  );
}
