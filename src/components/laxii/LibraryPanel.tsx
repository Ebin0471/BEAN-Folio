"use client";

import { Download, Heart, Images, RefreshCw, SquareStack } from "lucide-react";

import { BANNER_ASPECT_CLASS } from "@/lib/banner";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/bean/Spinner";
import { MediaThumb } from "@/components/bean/MediaThumb";

import { mediaUrl, type LibraryAsset } from "./types";

/**
 * My images / My banners / Favourites grid (§Phase 6 sidebar targets).
 * Provenance-tagged LAXII outputs, served owner-only; download, favourite
 * toggling and "use this image" (continue the conversation from it).
 */
export function LibraryPanel({
  view,
  assets,
  loading,
  onToggleFavourite,
  onUse,
  onRefresh,
}: {
  view: "images" | "banners" | "favourites";
  assets: LibraryAsset[];
  loading: boolean;
  onToggleFavourite: (assetId: string, favourite: boolean) => void;
  onUse: (assetId: string) => void;
  onRefresh: () => void;
}) {
  if (loading) {
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner className="size-6 text-primary" />
      </div>
    );
  }

  if (!assets.length) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        <div>
          {view === "favourites" ? (
            <Heart className="mx-auto size-8 text-muted-foreground/50" aria-hidden />
          ) : view === "banners" ? (
            <SquareStack className="mx-auto size-8 text-muted-foreground/50" aria-hidden />
          ) : (
            <Images className="mx-auto size-8 text-muted-foreground/50" aria-hidden />
          )}
          <p className="mt-3 text-sm text-muted-foreground">
            {view === "favourites"
              ? "Nothing saved yet — hover a generated image and press the heart to keep it here."
              : view === "banners"
                ? "No banners yet — create one from the composer's Banner mode."
                : "No images yet — start a new creation and your generations will appear here."}
          </p>
          <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={onRefresh}>
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-5 laxii-scroll">
      <div className="mx-auto flex max-w-4xl items-center justify-between pb-3">
        <p className="text-xs text-muted-foreground">
          {assets.length} {assets.length === 1 ? "image" : "images"} — private to your account
        </p>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={onRefresh}>
          <RefreshCw className="size-3.5" aria-hidden /> Refresh
        </Button>
      </div>
      <ul className="mx-auto grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {assets.map((a) => (
          <li key={a.id} className="group relative overflow-hidden rounded-xl border border-border/60 bg-card/60">
            <button type="button" className="block w-full" onClick={() => onUse(a.id)} aria-label={`Use ${a.filename}`}>
              <MediaThumb
                src={mediaUrl(a.id)}
                alt={a.filename}
                kind="IMAGE"
                aspect={a.laxiiKind === "BANNER" ? BANNER_ASPECT_CLASS : "aspect-square"}
                className="w-full"
              />
            </button>
            <span className="absolute left-2 top-2 rounded-full bg-background/80 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
              {a.laxiiKind?.replace("_", " ") ?? "image"}
            </span>
            <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-background/80 px-2 py-1.5 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <span className="truncate text-[10px] text-muted-foreground">
                {a.width}×{a.height}
              </span>
              <span className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => onToggleFavourite(a.id, !a.favourite)}
                  aria-label={a.favourite ? "Remove from favourites" : "Add to favourites"}
                  className={`grid size-6 place-items-center rounded-md hover:bg-accent ${a.favourite ? "text-primary" : "text-muted-foreground"}`}
                >
                  <Heart className={`size-3.5 ${a.favourite ? "fill-current" : ""}`} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      const res = await fetch(mediaUrl(a.id), { credentials: "include" });
                      if (!res.ok) return;
                      const blob = await res.blob();
                      const el = document.createElement("a");
                      el.href = URL.createObjectURL(blob);
                      el.download = a.filename;
                      el.click();
                      URL.revokeObjectURL(el.href);
                    })();
                  }}
                  aria-label={`Download ${a.filename}`}
                  className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent"
                >
                  <Download className="size-3.5" aria-hidden />
                </button>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
