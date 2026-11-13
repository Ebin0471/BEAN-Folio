"use client";

import { create } from "zustand";

/**
 * Feed video coordinator — guarantees that at most ONE feed video plays at
 * any moment across the whole app surface (Discover reels grid, creator
 * posts feed, post detail). Every inline player registers here; playback is
 * always requested THROUGH the store, never directly on the element, so two
 * independently-mounted videos can never both be playing.
 *
 * Rules encoded here (the product contract for Part B):
 *  - autoplay is ALWAYS muted (store-wide `muted` flag starts true; unmuting
 *    is an explicit user action on the active video)
 *  - a video becomes active when its IntersectionObserver reports dominant
 *    visibility (the player component owns the ratio threshold) AND autoplay
 *    is permitted (no reduced-motion preference, tab visible, not blocked by
 *    the browser, user has not explicitly paused this video)
 *  - claiming playback pauses the previous active element first: switching
 *    videos is atomic — never two playing
 *  - releasing (scrolled away) pauses the element
 *  - a hidden browser tab pauses the active element (visibilitychange)
 *  - an explicit user pause pins that video off until it leaves the screen
 *    (leaving clears the pin so scrolling back resumes normally)
 */

type FeedVideoState = {
  activeId: string | null;
  muted: boolean;
  /** autoplay permission snapshot for debuggability; computed per claim */
  autoplayBlocked: Set<string>;
  userPaused: Set<string>;
};

type FeedVideoActions = {
  /**
   * Request playback for `id`. Pauses any current active element first and
   * only then starts the new one. Returns false when the request must not
   * autoplay (reduced motion, hidden tab, user-paused) — the caller shows a
   * manual play control instead.
   */
  claim: (id: string, el: HTMLVideoElement | null, opts: { reducedMotion: boolean }) => boolean;
  /** Video left the viewport: stop it and free the active slot if owned. */
  release: (id: string, el: HTMLVideoElement | null) => void;
  /** Tap behavior: pause/resume this video, recording explicit user intent. */
  userToggle: (id: string, el: HTMLVideoElement | null, opts: { reducedMotion: boolean }) => void;
  /** Manual play (after autoplay was blocked or a user pause). */
  userPlay: (id: string, el: HTMLVideoElement | null) => void;
  /** Global mute toggle (only meaningful on the active video). */
  setMuted: (muted: boolean) => void;
  /** Record that the browser refused autoplay for this video. */
  markBlocked: (id: string) => void;
  /** Tab hidden / dialog opened: stop whatever is playing. */
  pauseActive: () => void;
  /** Unmount bookkeeping so a released slot can never ghost-block others. */
  unregister: (id: string) => void;
};

/** Element registry — activeId alone cannot pause a released element. */
const elements = new Map<string, HTMLVideoElement | null>();

function safePause(el: HTMLVideoElement | null | undefined) {
  try {
    el?.pause();
  } catch {
    /* element may be detached — nothing to do */
  }
}

function autoplayPermitted(reducedMotion: boolean): boolean {
  if (reducedMotion) return false;
  if (typeof document !== "undefined" && document.hidden) return false;
  return true;
}

export const useFeedVideo = create<FeedVideoState & FeedVideoActions>((set, get) => ({
  activeId: null,
  muted: true,
  autoplayBlocked: new Set<string>(),
  userPaused: new Set<string>(),

  claim: (id, el, opts) => {
    elements.set(id, el);
    if (!autoplayPermitted(opts.reducedMotion) || get().userPaused.has(id)) {
      safePause(el);
      return false;
    }
    const prev = get().activeId;
    if (prev && prev !== id) {
      // Atomic switch: the previous video stops BEFORE the next one starts.
      safePause(elements.get(prev));
    }
    set((s) => ({
      activeId: id,
      autoplayBlocked: (() => {
        if (!s.autoplayBlocked.has(id)) return s.autoplayBlocked;
        const next = new Set(s.autoplayBlocked);
        next.delete(id);
        return next;
      })(),
    }));
    if (el) {
      el.muted = get().muted;
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          // Autoplay refused (typically unmuted or policy): honest fallback.
          get().markBlocked(id);
        });
      }
    }
    return true;
  },

  release: (id, el) => {
    safePause(el ?? elements.get(id));
    // Leaving the screen clears an explicit user pause: scrolling back
    // resumes normal autoplay behavior (the pin only survives while the
    // video stays dominant on screen).
    set((s) => {
      if (!s.userPaused.has(id)) {
        return { activeId: s.activeId === id ? null : s.activeId };
      }
      const userPaused = new Set(s.userPaused);
      userPaused.delete(id);
      return { activeId: s.activeId === id ? null : s.activeId, userPaused };
    });
  },

  userToggle: (id, el, opts) => {
    elements.set(id, el);
    const v = el;
    if (!v) return;
    if (v.paused) {
      set((s) => {
        const userPaused = new Set(s.userPaused);
        userPaused.delete(id);
        return { userPaused };
      });
      get().claim(id, el, opts);
    } else {
      set((s) => {
        const userPaused = new Set(s.userPaused);
        userPaused.add(id);
        return { userPaused, activeId: s.activeId === id ? null : s.activeId };
      });
      safePause(v);
    }
  },

  userPlay: (id, el) => {
    elements.set(id, el);
    if (!el) return;
    set((s) => {
      const userPaused = new Set(s.userPaused);
      userPaused.delete(id);
      const autoplayBlocked = new Set(s.autoplayBlocked);
      autoplayBlocked.delete(id);
      return { userPaused, autoplayBlocked, activeId: id };
    });
    el.muted = get().muted;
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => get().markBlocked(id));
  },

  setMuted: (muted) => {
    set({ muted });
    // Apply immediately to whichever element is playing right now.
    const el = get().activeId ? elements.get(get().activeId!) : null;
    if (el) el.muted = muted;
  },

  markBlocked: (id) =>
    set((s) => {
      const autoplayBlocked = new Set(s.autoplayBlocked);
      autoplayBlocked.add(id);
      return { autoplayBlocked, activeId: s.activeId === id ? null : s.activeId };
    }),

  pauseActive: () => {
    const id = get().activeId;
    if (!id) return;
    safePause(elements.get(id));
    set({ activeId: null });
  },

  unregister: (id) => {
    elements.delete(id);
    set((s) => {
      const userPaused = new Set(s.userPaused);
      userPaused.delete(id);
      const autoplayBlocked = new Set(s.autoplayBlocked);
      autoplayBlocked.delete(id);
      return { activeId: s.activeId === id ? null : s.activeId, userPaused, autoplayBlocked };
    });
  },
}));

/** Reduced-motion preference, read once per component (static environment). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Dominant-visibility thresholds shared by every inline feed player. */
export const FEED_VIDEO = {
  /** Intersection ratio above which a video may claim playback. */
  PLAY_AT: 0.6,
  /** Ratio below which a playing video is released (hysteresis band). */
  STOP_AT: 0.35,
} as const;

if (typeof document !== "undefined") {
  // Pause on tab hide — background tabs must never keep media running.
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) useFeedVideo.getState().pauseActive();
    },
    { passive: true }
  );
}
