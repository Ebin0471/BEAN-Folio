"use client";

/**
 * CODE GIFTZ capability switcher — the unified workspace entry point.
 *
 * Code Giftz is one agent with two related capabilities:
 *  - "Engineering" — the repository workspace (#/giftz)
 *  - "Website studio" — the visual website coding studio (#/giftz/website)
 *
 * Rendered in both capabilities' headers so the two are always understandable
 * and one click apart (consolidation: the standalone Customize Website menu
 * entry was removed; this switcher is the way between them).
 */

import { TerminalSquare } from "lucide-react";

import { navigate, useHashRoute } from "@/lib/hash-router";
import { cn } from "@/lib/utils";

const CAPABILITIES = [
  {
    key: "engineering",
    label: "Engineering",
    route: "/giftz",
    hint: "Repositories, plans, approval-gated execution",
  },
  {
    key: "website",
    label: "Website studio",
    route: "/giftz/website",
    hint: "Chat-driven visual website coding",
  },
] as const;

export function GiftzCapabilitySwitcher({ className }: { className?: string }) {
  const { segments } = useHashRoute();
  const activeKey = segments[0] === "giftz" && segments[1] === "website" ? "website" : "engineering";

  return (
    <div
      role="tablist"
      aria-label="Code Giftz capabilities"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/60 p-0.5",
        className
      )}
    >
      {CAPABILITIES.map((cap) => {
        const active = cap.key === activeKey;
        return (
          <button
            key={cap.key}
            type="button"
            role="tab"
            aria-selected={active}
            title={cap.hint}
            onClick={() => {
              if (!active) navigate(cap.route);
            }}
            className={cn(
              "inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors sm:text-[13px]",
              active
                ? "bg-gold-soft text-primary shadow-sm"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <TerminalSquare className="size-3.5" aria-hidden />
            {cap.label}
          </button>
        );
      })}
    </div>
  );
}
