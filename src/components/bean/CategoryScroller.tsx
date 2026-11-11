"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * CategoryScroller — a single horizontal row of filter chips that never
 * widens the page and never gets cut off:
 *  - native touch swipe + trackpad horizontal scrolling (overflow-x-auto);
 *  - mouse-wheel / vertical trackpad scrolls are translated into the row
 *    (only while the row can still scroll in that direction — the page
 *    never gets trapped);
 *  - keyboard: the row is focusable; ←/→/Home/End scroll and move focus
 *    between chips (focus auto-scrolls the chip into view);
 *  - desktop edge controls with fade masks appear only while scrollable;
 *  - the scrollbar is hidden because three other discoverable affordances
 *    exist (controls, wheel, keyboard) and the active chip is always
 *    scrolled into view.
 */
export function CategoryScroller({
  options,
  activeLabel,
  onSelect,
  ariaLabel = "Filter by category",
}: {
  /** Chip labels in display order (e.g. ["All", "Photography", …]). */
  options: string[];
  activeLabel: string;
  onSelect: (label: string) => void;
  ariaLabel?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const scrollableRef = useRef(false);

  const updateArrows = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const scrollable = el.scrollWidth > el.clientWidth + 1;
    scrollableRef.current = scrollable;
    setCanLeft(scrollable && el.scrollLeft > 1);
    setCanRight(scrollable && el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  // Recompute arrow visibility on scroll, resize, and content changes.
  // The first measurement is deferred to a frame (layout must exist first,
  // and state must not be set synchronously inside the effect body).
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(updateArrows);
    const onScroll = () => updateArrows();
    const onResize = () => updateArrows();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
    };
  }, [updateArrows]);

  // Mouse-wheel / trackpad vertical deltas drive the horizontal row.
  // Native non-passive listener (React's synthetic onWheel is passive).
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // horizontal trackpad swipe is native
      if (!scrollableRef.current) return;
      const max = el.scrollWidth - el.clientWidth;
      const goingRight = e.deltaY > 0;
      // At the edge in the scroll direction → let the PAGE scroll instead.
      if ((goingRight && el.scrollLeft >= max - 1) || (!goingRight && el.scrollLeft <= 1)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keyboard navigation: scroll AND move focus between the chips.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = rowRef.current;
    if (!el) return;
    const chips = Array.from(el.querySelectorAll<HTMLButtonElement>("button[data-chip]"));
    if (chips.length === 0) return;
    const current = chips.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (i: number) => {
      const target = chips[Math.max(0, Math.min(chips.length - 1, i))];
      target?.focus();
      target?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    };
    if (e.key === "ArrowRight") {
      e.preventDefault();
      el.scrollBy({ left: 96, behavior: "smooth" });
      focusAt(current + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      el.scrollBy({ left: -96, behavior: "smooth" });
      focusAt(current - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      el.scrollTo({ left: 0, behavior: "smooth" });
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
      focusAt(chips.length - 1);
    }
  };

  // Keep the selected chip visible when the selection changes (or after the
  // live taxonomy loads).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeLabel, options.length]);

  const scrollByAmount = (dir: -1 | 1) => {
    const el = rowRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(200, el.clientWidth * 0.7), behavior: "smooth" });
  };

  return (
    <div className="relative min-w-0">
      {/* left fade + control — rendered only while scrollable in that direction */}
      {canLeft && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 z-10 hidden w-14 bg-gradient-to-r from-background via-background/85 to-transparent md:block"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label="Scroll categories left"
            onClick={() => scrollByAmount(-1)}
            className="absolute left-1 top-1/2 z-20 hidden size-8 -translate-y-1/2 place-items-center rounded-full border border-border/70 bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:border-primary/40 hover:text-foreground md:grid"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
        </>
      )}

      <div
        ref={rowRef}
        role="group"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={cn(
          "flex min-w-0 gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-lg"
        )}
      >
        {options.map((label) => {
          const active = label === activeLabel;
          return (
            <button
              key={label}
              type="button"
              data-chip
              ref={active ? activeRef : undefined}
              aria-pressed={active}
              onClick={() => onSelect(label)}
              className={cn(
                "inline-flex h-11 shrink-0 items-center rounded-full border px-4 text-sm transition-colors",
                active
                  ? "border-primary/60 bg-gold-soft font-medium text-primary"
                  : "border-border/70 bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground"
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* right fade + control */}
      {canRight && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 z-10 hidden w-14 bg-gradient-to-l from-background via-background/85 to-transparent md:block"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label="Scroll categories right"
            onClick={() => scrollByAmount(1)}
            className="absolute right-1 top-1/2 z-20 hidden size-8 -translate-y-1/2 place-items-center rounded-full border border-border/70 bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:border-primary/40 hover:text-foreground md:grid"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
