"use client";

import { useEffect, useState } from "react";
import {
  Briefcase,
  Image as ImageIcon,
  MapPin,
  MoveVertical,
  Palette,
  SquarePen,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { MediaUploadButton } from "@/components/bean/MediaUploadButton";
import { categoryLabel } from "@/components/bean/ProjectCard";
import { navigate } from "@/lib/hash-router";
import { BANNER_ASPECT_CLASS } from "@/lib/banner";
import type { MediaDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Unified, reusable profile header.
 *
 * One responsive component renders BOTH the owner workspace ("My Folio") and
 * the public profile: identical cover/identity geometry, variant-specific
 * actions and controls. Owner-only controls (upload/adjust/remove) are never
 * rendered in the public variant, so visitors cannot see editing UI.
 *
 * Geometry contract:
 * - Cover: platform-standard banner band — width:100% at the 2048:687 aspect
 *   (≈2.981:1, see lib/banner.ts), object-fit:cover with the persisted focal
 *   point (object-position Y %). Height stays proportional to width at every
 *   breakpoint; uploaded banners are never stretched or distorted.
 * - Avatar: square aspect-ratio-1 container, border-radius 50%, the complete
 *   circle overlaps the cover edge and is never clipped — contain/cover fit
 *   plus persisted zoom/position drive the inner <img> only.
 */

export interface ProfileHeaderData {
  name: string;
  username: string | null;
  headline: string | null;
  location: string | null;
  bio?: string | null;
  professions: string[];
  skills?: string[];
  availability?: string | null;
  experienceLevel?: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  coverPositionY: number;
  avatarFit: string;
  avatarZoom: number;
  avatarPosX: number;
  avatarPosY: number;
}

/** Fields the owner-adjustment dialogs can patch. */
export interface ProfileMediaPatch {
  avatarMediaId?: string | null;
  coverMediaId?: string | null;
  coverPositionY?: number;
  avatarFit?: string;
  avatarZoom?: number;
  avatarPosX?: number;
  avatarPosY?: number;
}

export interface ProfileHeaderActions {
  onCoverUploaded?: (m: MediaDTO) => void;
  onAvatarUploaded?: (m: MediaDTO) => void;
  onPatch?: (patch: ProfileMediaPatch) => Promise<void> | void;
  onRemoveCover?: () => void;
  onRemoveAvatar?: () => void;
}

function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// ------------------------------------------------------------------ avatar img

function AvatarImageInner({ data, className }: { data: ProfileHeaderData; className?: string }) {
  const fit = data.avatarFit === "contain" ? "contain" : "cover";
  return (
    <img
      src={data.avatarUrl ?? undefined}
      alt={`${data.name}'s avatar`}
      className={cn("absolute inset-0 h-full w-full", className)}
      style={{
        objectFit: fit,
        objectPosition: `${data.avatarPosX}% ${data.avatarPosY}%`,
        // Zoom scales the source inside the circle; transform-origin follows
        // the focal point so the visible region stays centered on it.
        transform: `scale(${data.avatarZoom / 100})`,
        transformOrigin: `${data.avatarPosX}% ${data.avatarPosY}%`,
        backgroundColor: "var(--muted)",
      }}
      draggable={false}
    />
  );
}

// ------------------------------------------------------------------ adjust dialogs

function CoverAdjustDialog({
  open,
  onOpenChange,
  positionY,
  onCommit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  positionY: number;
  onCommit: (y: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open && <CoverAdjustForm positionY={positionY} onCommit={onCommit} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** Mounted fresh on each open (Radix unmounts content), so state starts from props. */
function CoverAdjustForm({
  positionY,
  onCommit,
  onClose,
}: {
  positionY: number;
  onCommit: (y: number) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(positionY);

  return (
    <>
        <DialogHeader>
          <DialogTitle className="font-display">Adjust cover framing</DialogTitle>
          <DialogDescription>
            Choose which part of the image stays in view. The setting is saved to your profile.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className={`relative w-full overflow-hidden rounded-lg border border-border/60 bg-muted ${BANNER_ASPECT_CLASS}`} aria-hidden>
            <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-gold-soft via-muted to-card">
              <span className="text-xs text-muted-foreground">Cover preview</span>
            </div>
            <div
              className="absolute inset-x-0 h-6 border-y border-primary/60 bg-primary/10"
              style={{ top: `${value}%`, transform: "translateY(-50%)" }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cover-focal">Focal height — {value}%</Label>
            <Slider
              id="cover-focal"
              value={[value]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => setValue(v[0])}
              aria-label="Cover focal height percentage"
            />
            <p className="text-xs text-muted-foreground">0% = top of the image, 100% = bottom.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onCommit(value);
              onClose();
            }}
          >
            Apply
          </Button>
        </DialogFooter>
    </>
  );
}

function AvatarAdjustDialog({
  open,
  onOpenChange,
  data,
  onCommit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: ProfileHeaderData;
  onCommit: (patch: ProfileMediaPatch) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open && <AvatarAdjustForm data={data} onCommit={onCommit} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** Mounted fresh on each open (Radix unmounts content), so state starts from props. */
function AvatarAdjustForm({
  data,
  onCommit,
  onClose,
}: {
  data: ProfileHeaderData;
  onCommit: (patch: ProfileMediaPatch) => void;
  onClose: () => void;
}) {
  const [fit, setFit] = useState(data.avatarFit === "contain");
  const [zoom, setZoom] = useState(data.avatarZoom);
  const [x, setX] = useState(data.avatarPosX);
  const [y, setY] = useState(data.avatarPosY);

  return (
    <>
        <DialogHeader>
          <DialogTitle className="font-display">Adjust avatar</DialogTitle>
          <DialogDescription>Fit, zoom and focal position — saved with your profile.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <span className="relative block size-20 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
              {data.avatarUrl ? (
                <img
                  src={data.avatarUrl}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 h-full w-full"
                  style={{
                    objectFit: fit ? "contain" : "cover",
                    objectPosition: `${x}% ${y}%`,
                    transform: `scale(${zoom / 100})`,
                    transformOrigin: `${x}% ${y}%`,
                    backgroundColor: "var(--muted)",
                  }}
                  draggable={false}
                />
              ) : (
                <span className="grid h-full w-full place-items-center bg-gold-soft text-primary">?</span>
              )}
            </span>
            <div className="flex items-center gap-2 text-sm">
              <span className={cn(!fit && "font-medium")}>Fill circle</span>
              <Switch checked={fit} onCheckedChange={setFit} aria-label="Contain fit mode" />
              <span className={cn(fit && "font-medium")}>Fit whole image</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="av-zoom">Zoom — {zoom}%</Label>
            <Slider id="av-zoom" value={[zoom]} min={50} max={300} step={5} onValueChange={(v) => setZoom(v[0])} aria-label="Avatar zoom" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="av-x">Horizontal — {x}%</Label>
              <Slider id="av-x" value={[x]} min={0} max={100} step={1} onValueChange={(v) => setX(v[0])} aria-label="Avatar horizontal position" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="av-y">Vertical — {y}%</Label>
              <Slider id="av-y" value={[y]} min={0} max={100} step={1} onValueChange={(v) => setY(v[0])} aria-label="Avatar vertical position" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onCommit({
                avatarFit: fit ? "contain" : "cover",
                avatarZoom: zoom,
                avatarPosX: x,
                avatarPosY: y,
              });
              onClose();
            }}
          >
            Apply
          </Button>
        </DialogFooter>
    </>
  );
}

// ------------------------------------------------------------------ header

export function ProfileHeader({
  variant,
  profile,
  actions,
  ownerControls,
}: {
  variant: "owner" | "public";
  profile: ProfileHeaderData;
  /** Public actions (Follow, Contact…) or owner actions (Customize Website…). */
  actions?: React.ReactNode;
  /** Owner-only upload/adjust/remove handlers; omit entirely for visitors. */
  ownerControls?: ProfileHeaderActions;
}) {
  const [coverOpen, setCoverOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const initials = initialsOf(profile.name);
  const isOwner = variant === "owner";

  const commit = async (patch: ProfileMediaPatch) => {
    if (!ownerControls?.onPatch) return;
    try {
      await ownerControls.onPatch(patch);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the adjustment");
    }
  };

  return (
    <section aria-label={`Profile header for ${profile.name}`}>
      {/* ---------------- cover (rounded top corners; identity sits inside the same card) */}
      <div className="rounded-xl border border-border/60 bg-card">
        <div
          className={`relative w-full bg-muted ${BANNER_ASPECT_CLASS}`}
          style={{ overflow: "hidden", borderRadius: "calc(var(--radius) + 3px) calc(var(--radius) + 3px) 0 0" }}
        >
          {profile.coverUrl ? (
            <img
              src={profile.coverUrl}
              alt={`${profile.name}'s cover image`}
              className="absolute inset-0 h-full w-full"
              style={{ objectFit: "cover", objectPosition: `50% ${profile.coverPositionY}%` }}
              draggable={false}
            />
          ) : (
            // Clean dark brand placeholder — no fake imagery.
            <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-muted via-card to-background">
              <div className="flex items-center gap-2 text-muted-foreground">
                <ImageIcon className="size-4" aria-hidden />
                <span className="text-xs tracking-wide">No cover yet</span>
              </div>
            </div>
          )}
          {/* bottom scrim keeps the identity edge readable without hiding controls */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/25 to-transparent" aria-hidden />

          {isOwner && ownerControls && (
            <div className="absolute right-3 top-3 flex flex-wrap items-center justify-end gap-2">
              <MediaUploadButton
                kind="IMAGE"
                label="Change cover"
                onUploaded={(m) => ownerControls.onCoverUploaded?.(m)}
                variant="outline"
                size="sm"
                className="h-8 bg-background/80 text-xs backdrop-blur-sm"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 bg-background/80 text-xs backdrop-blur-sm"
                    disabled={!profile.coverUrl}
                  >
                    <MoveVertical className="size-3.5" aria-hidden /> Adjust
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setCoverOpen(true)}>
                    <MoveVertical className="size-4" aria-hidden /> Adjust focal point
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => ownerControls.onRemoveCover?.()}
                  >
                    <Trash2 className="size-4" aria-hidden /> Remove cover
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {/* ---------------- identity row */}
        <div className="px-4 pb-5 sm:px-6 sm:pb-6">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            <div className="flex min-w-0 items-start gap-4 sm:gap-5">
              {/* avatar — square container, aspect 1, full circle, never clipped;
                  half the circle overlaps the cover edge (mobile 80px, desktop 112px) */}
              <span className="-mt-10 relative block size-20 shrink-0 sm:-mt-14 sm:size-28">
                <span className="absolute inset-0 block overflow-hidden rounded-full bg-card ring-2 ring-background">
                  {profile.avatarUrl ? (
                    <AvatarImageInner data={profile} />
                  ) : (
                    <span className="absolute inset-0 grid place-items-center bg-gold-soft font-display text-xl text-primary sm:text-2xl">
                      {initials}
                    </span>
                  )}
                </span>
              </span>

              <div className="min-w-0 pt-1 sm:pt-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{profile.name}</h1>
                  {profile.availability && (
                    <span className="rounded-full bg-gold-soft px-2.5 py-0.5 text-xs font-medium text-primary ring-1 ring-primary/25">
                      {profile.availability}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {profile.username ? `@${profile.username}` : "No username yet"}
                </p>
                {profile.headline && <p className="mt-1 text-sm text-foreground/90">{profile.headline}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                  {profile.location && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="size-3.5" aria-hidden /> {profile.location}
                    </span>
                  )}
                  {profile.experienceLevel && (
                    <span className="inline-flex items-center gap-1">
                      <Briefcase className="size-3.5" aria-hidden /> {profile.experienceLevel}
                    </span>
                  )}
                  {profile.professions.map((p) => (
                    <Badge key={p} variant="secondary" className="rounded-full font-normal">
                      {categoryLabel(p)}
                    </Badge>
                  ))}
                </div>
                {profile.skills && profile.skills.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {profile.skills.slice(0, 10).map((s) => (
                      <span
                        key={s}
                        className="rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* actions — right-aligned on desktop, wrap to their own row on mobile */}
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:max-w-full sm:justify-end sm:pt-11">
              {isOwner ? (
                <>
                  <Button onClick={() => navigate("/website")}>
                    <Palette className="size-4" aria-hidden /> Customize Website
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!profile.username}
                    onClick={() => profile.username && navigate(`/u/${profile.username}`)}
                  >
                    <UserRound className="size-4" aria-hidden /> Public Profile
                  </Button>
                  <Button variant="ghost" onClick={() => navigate("/studio")}>
                    <SquarePen className="size-4" aria-hidden /> Studio
                  </Button>
                </>
              ) : (
                actions
              )}
            </div>
          </div>

          {/* avatar micro-controls (owner only) */}
          {isOwner && ownerControls && (
            <div className="mt-2 flex flex-wrap items-center gap-2 pl-24 sm:pl-[132px]">
              <MediaUploadButton
                kind="IMAGE"
                label={profile.avatarUrl ? "Replace avatar" : "Upload avatar"}
                onUploaded={(m) => ownerControls.onAvatarUploaded?.(m)}
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                disabled={!profile.avatarUrl}
                onClick={() => setAvatarOpen(true)}
              >
                Adjust
              </Button>
              {profile.avatarUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => ownerControls.onRemoveAvatar?.()}
                >
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* dialogs (owner only) */}
      {isOwner && ownerControls && (
        <>
          <CoverAdjustDialog
            open={coverOpen}
            onOpenChange={setCoverOpen}
            positionY={profile.coverPositionY}
            onCommit={(y) => void commit({ coverPositionY: y })}
          />
          <AvatarAdjustDialog open={avatarOpen} onOpenChange={setAvatarOpen} data={profile} onCommit={(p) => void commit(p)} />
        </>
      )}
    </section>
  );
}
