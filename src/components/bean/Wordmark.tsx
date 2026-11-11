"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * BEAN Folio brand lockup — the two ORIGINAL assets, unmodified:
 *  - public/brand/bean-folio-symbol.png   (gold BEAN "B" symbol, 4096x3842 RGBA)
 *  - public/brand/bean-folio-wordmark.png (transparent BEAN FOLIO wordmark, 2170x725 RGBA)
 *
 * Every variant renders the unified logo: symbol on the LEFT + wordmark on
 * the RIGHT, vertically centered with balanced spacing. Both images render
 * at fixed height + auto width with object-fit: contain, so the original
 * aspect ratios, transparency, gold finish and sharpness are preserved —
 * never stretched, cropped or recolored. Sizes: full = h-8 (header, auth
 * hero); compact = h-5 (footer brand row) — the same lockup scaled down.
 *
 * Symbol visibility, symbol="auto" (default): shown wherever the header
 * lockup has room — small viewports (the primary nav is hidden there) and
 * lg+ desktop. Between md and lg the header row is narrower than the nav
 * plus the full lockup (a pre-existing md budget), so the symbol steps
 * aside in that band to keep the navigation unoverlapped while the
 * wordmark keeps its original footprint. Unconstrained placements (the
 * centered auth hero: symbol="always"; the footer: compact) keep the
 * symbol at every width. symbol="never" opts out entirely.
 */
const SYMBOL_SRC = "/brand/bean-folio-symbol.png";
const WORDMARK_SRC = "/brand/bean-folio-wordmark.png";

type SymbolMode = "auto" | "always" | "never";

export function Wordmark({
  className,
  compact = false,
  symbol = "auto",
}: {
  className?: string;
  compact?: boolean;
  symbol?: SymbolMode;
}) {
  const showSymbol = symbol !== "never";
  return (
    <Link
      href="#/"
      aria-label="BEAN Folio — home"
      className={cn("inline-flex min-w-0 items-center", showSymbol && "gap-2.5", className)}
    >
      {showSymbol && (
        <img
          src={SYMBOL_SRC}
          alt=""
          width={4096}
          height={3842}
          className={cn(
            "w-auto shrink-0 object-contain",
            compact ? "h-5" : symbol === "always" ? "h-8" : "h-7 md:hidden lg:block lg:h-8"
          )}
          decoding="async"
        />
      )}
      <img
        src={WORDMARK_SRC}
        alt=""
        width={2170}
        height={725}
        className={cn(
          "w-auto min-w-0 object-contain",
          compact ? "h-5" : symbol === "always" ? "h-8" : "h-7 md:h-8"
        )}
        decoding="async"
      />
    </Link>
  );
}
