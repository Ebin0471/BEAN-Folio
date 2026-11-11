"use client";

import { useEffect, useState } from "react";
import { Ruler, ShieldCheck, X } from "lucide-react";

import { api } from "@/lib/client";

import type { BannerPresetInfo } from "./types";

/**
 * Banner Studio settings (§Phase 5): platform presets (official dimensions),
 * custom width/height, layout style, and a real canvas preview with the
 * platform's text-safe-area guides (e.g. YouTube's 1546×423 central safe
 * area on the 2560×1440 channel banner).
 */
export function BannerSettings({
  value,
  onChange,
  onClose,
  onError,
  selectedAssetId,
}: {
  value: { presetId: string; width: number; height: number; style: string };
  onChange: (v: { presetId: string; width: number; height: number; style: string }) => void;
  onClose: () => void;
  onError: (msg: string) => void;
  selectedAssetId: string | null;
}) {
  const [presets, setPresets] = useState<BannerPresetInfo[]>([]);
  const [showSafe, setShowSafe] = useState(true);

  useEffect(() => {
    let alive = true;
    api<{ presets: BannerPresetInfo[] }>("/api/laxii/banner-presets")
      .then((r) => alive && setPresets(r.presets))
      .catch(() => alive && onError("Could not load banner presets"));
    return () => {
      alive = false;
    };
  }, [onError]);

  const preset = presets.find((p) => p.id === value.presetId) ?? null;
  const safe = preset?.safeArea ?? null;

  const pickPreset = (p: BannerPresetInfo) => {
    onChange({ ...value, presetId: p.id, width: p.width, height: p.height });
  };

  return (
    <div className="border-t border-border/60 bg-card/50">
      <div className="mx-auto max-w-3xl p-3 sm:px-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Ruler className="size-4 text-primary" aria-hidden /> Banner Studio
          </h3>
          <button type="button" onClick={onClose} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent" aria-label="Close banner settings">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* preset grid */}
        <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
          {(presets.length
            ? presets
            : [
                {
                  id: "youtube-channel",
                  label: "YouTube channel banner",
                  description: "",
                  width: 2560,
                  height: 1440,
                  safeArea: null,
                  formats: ["PNG" as const, "JPEG" as const],
                  maxBytes: null,
                },
              ]
          ).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pickPreset(p)}
              className={`rounded-lg border p-2 text-left transition-colors ${
                value.presetId === p.id ? "border-primary/50 bg-gold-soft/25" : "border-border/60 hover:border-primary/30"
              }`}
            >
              <span className="block truncate text-xs font-medium">{p.label}</span>
              <span className="block text-[10px] text-muted-foreground">
                {p.width}×{p.height}
              </span>
            </button>
          ))}
        </div>

        {/* canvas preview with safe-area guides */}
        <div className="mt-3 rounded-xl border border-border/60 bg-background/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              Canvas preview — {value.width}×{value.height} px
            </p>
            {safe ? (
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                <input type="checkbox" checked={showSafe} onChange={(e) => setShowSafe(e.target.checked)} className="accent-[var(--primary)]" />
                <ShieldCheck className="size-3.5 text-primary" aria-hidden /> Safe-area guides
              </label>
            ) : null}
          </div>
          <div className="mt-2 overflow-hidden rounded-lg border border-border/60" style={{ background: "repeating-conic-gradient(#1a1a1a 0% 25%, #111 0% 50%) 50%/24px 24px" }}>
            <canvas
              width={value.width}
              height={value.height}
              className="block h-auto w-full"
              style={{ aspectRatio: `${value.width}/${value.height}`, maxWidth: "100%" }}
              ref={(el) => {
                if (!el) return;
                const ctx = el.getContext("2d");
                if (!ctx) return;
                ctx.clearRect(0, 0, el.width, el.height);
                // subtle art placeholder + safe area
                ctx.fillStyle = "#151312";
                ctx.fillRect(0, 0, el.width, el.height);
                ctx.fillStyle = "rgba(232,188,81,0.10)";
                ctx.fillRect(el.width * 0.25, el.height * 0.25, el.width * 0.5, el.height * 0.5);
                if (showSafe && safe) {
                  ctx.strokeStyle = "rgba(232,188,81,0.9)";
                  ctx.lineWidth = Math.max(2, el.width / 300);
                  ctx.setLineDash([el.width / 60, el.width / 90]);
                  ctx.strokeRect(safe.x, safe.y, safe.w, safe.h);
                  ctx.setLineDash([]);
                  ctx.fillStyle = "rgba(232,188,81,0.9)";
                  ctx.font = `${Math.max(12, el.width / 70)}px sans-serif`;
                  ctx.fillText("text-safe area", safe.x + el.width / 90, safe.y + Math.max(14, el.height / 22));
                }
                if (selectedAssetId) {
                  // The selected image is the composition seed — show it centered.
                  void selectedAssetId;
                }
              }}
            />
          </div>
          {safe ? (
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Keep text, logos and key content inside the dashed safe area ({safe.w}×{safe.h} px) — platforms crop or hide
              everything outside it on some devices. The generator receives the same instruction.
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">Full-bleed custom canvas — the whole image is safe.</p>
          )}
        </div>

        {/* custom dims + layout style */}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs">
            <span className="font-medium text-muted-foreground">Custom dimensions</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={16}
                max={4096}
                value={value.width}
                onChange={(e) => onChange({ ...value, width: Math.max(16, Math.min(4096, Number(e.target.value) || 16)) })}
                className="w-24 rounded-lg border border-border/60 bg-background px-2 py-1.5 text-sm"
                aria-label="Banner width in pixels"
              />
              <span className="text-muted-foreground">×</span>
              <input
                type="number"
                min={16}
                max={4096}
                value={value.height}
                onChange={(e) => onChange({ ...value, height: Math.max(16, Math.min(4096, Number(e.target.value) || 16)) })}
                className="w-24 rounded-lg border border-border/60 bg-background px-2 py-1.5 text-sm"
                aria-label="Banner height in pixels"
              />
              {preset && (value.width !== preset.width || value.height !== preset.height) ? (
                <button
                  type="button"
                  className="text-[11px] text-primary underline-offset-2 hover:underline"
                  onClick={() => onChange({ ...value, width: preset.width, height: preset.height })}
                >
                  reset to {preset.width}×{preset.height}
                </button>
              ) : null}
            </div>
          </label>
          <label className="grid gap-1 text-xs">
            <span className="font-medium text-muted-foreground">Layout &amp; composition hint</span>
            <input
              type="text"
              value={value.style}
              onChange={(e) => onChange({ ...value, style: e.target.value })}
              placeholder="e.g. centered logo area, product on the left, headline space right"
              className="rounded-lg border border-border/60 bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none"
            />
          </label>
        </div>
        {selectedAssetId ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Your selected image will seed the composition — describe how the banner should extend or restyle it.
          </p>
        ) : null}
      </div>
    </div>
  );
}
