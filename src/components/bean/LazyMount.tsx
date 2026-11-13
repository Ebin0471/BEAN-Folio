"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Renders children only once the wrapper scrolls near the viewport
 * (IntersectionObserver, one-way latching). Used by the Discover feeds so a
 * page of media posts never mounts every <video>/<img> element at once —
 * off-screen cards stay lightweight placeholders until approached.
 */
export function LazyMount({
  children,
  placeholderClassName,
  rootMargin = "300px",
  minHeight = 0,
  ariaLabel,
}: {
  children: ReactNode;
  placeholderClassName?: string;
  rootMargin?: string;
  minHeight?: number;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Ancient engines without IntersectionObserver degrade to eager loading —
  // decided at init (environment is static), never via setState-in-effect.
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, rootMargin]);

  return (
    <div ref={ref} style={minHeight ? { minHeight } : undefined} aria-label={ariaLabel}>
      {visible ? (
        children
      ) : (
        <div className={placeholderClassName ?? "h-full w-full animate-pulse rounded-lg bg-secondary/50"} aria-hidden />
      )}
    </div>
  );
}
