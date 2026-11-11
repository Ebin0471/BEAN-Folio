"use client";

import Link from "next/link";
import { Bookmark, Eye, Star } from "lucide-react";
import { MediaThumb } from "@/components/bean/MediaThumb";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { formatCompact } from "@/lib/client";
import type { ProjectCardDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Offline label map mirroring the canonical Profession taxonomy
 * (src/app/api/professions/route.ts — the Profession table is the live source
 * of truth; live taxonomy responses replace this map wherever a fetch is made).
 * Lives in lib/categories so server code (the website exporter) can reuse it —
 * this module is "use client", and its exports become client references in
 * server bundles.
 */
import { CATEGORY_LABELS, categoryLabel } from "@/lib/categories";

export { categoryLabel };

export function categoryFromLabel(
  label: string,
  options?: { slug: string; label: string }[]
): string {
  // Live taxonomy first (Profession table), static map as fallback.
  const live = options?.find((o) => o.label === label);
  if (live) return live.slug;
  const entry = Object.entries(CATEGORY_LABELS).find(([, v]) => v === label);
  return entry?.[0] ?? "other";
}

export const PROJECT_CATEGORIES = CATEGORY_LABELS;

export function ProjectCard({
  project,
  reason,
  className,
}: {
  project: ProjectCardDTO;
  reason?: string;
  className?: string;
}) {
  const initials = project.owner.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <article className={cn("group relative overflow-hidden rounded-xl border border-border/60 bg-card transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[0_8px_30px_rgba(0,0,0,0.35)]", className)}>
      {/* Stretched-link overlay: whole card is clickable without nesting anchors.
          Sits ON TOP of static content; interactive children (owner link) sit above it. */}
      <Link href={`#/p/${project.id}`} className="absolute inset-0 z-20" aria-label={`${project.title} — view project`} />
      <div className="relative">
        <div className="relative">
          <MediaThumb src={project.coverUrl} kind={project.coverKind ?? undefined} alt={project.title} aspect="aspect-[4/3]" />
          {reason && (
            <span className="absolute left-3 top-3 rounded-full bg-background/85 px-2.5 py-1 text-[11px] font-medium text-primary ring-1 ring-primary/25 backdrop-blur-sm">
              {reason}
            </span>
          )}
          {project.visibility === "UNLISTED" && (
            <span className="absolute right-3 top-3 rounded-full bg-background/85 px-2.5 py-1 text-[11px] text-muted-foreground ring-1 ring-border backdrop-blur-sm">
              Unlisted
            </span>
          )}
          {project.featured && project.status !== "DRAFT" && (
            <span
              className="absolute right-3 bottom-3 inline-flex items-center gap-1 rounded-full bg-gold-soft px-2.5 py-1 text-[11px] font-medium text-primary ring-1 ring-primary/25 backdrop-blur-sm"
              title="Featured by the creator"
            >
              <Star className="size-3 fill-current" aria-hidden /> Featured
            </span>
          )}
          {project.status === "DRAFT" && (
            <span className="absolute right-3 top-3 rounded-full bg-gold-soft px-2.5 py-1 text-[11px] font-medium text-primary ring-1 ring-primary/25 backdrop-blur-sm">
              Draft
            </span>
          )}
        </div>
        <div className="space-y-2.5 p-4">
          <h3 className="line-clamp-1 font-medium leading-snug text-foreground transition-colors group-hover:text-primary">
            {project.title}
          </h3>
          {project.summary && <p className="line-clamp-2 min-h-[2rem] text-sm text-muted-foreground">{project.summary}</p>}
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary" className="rounded-full text-[11px] font-normal">
              {categoryLabel(project.category)}
            </Badge>
            {project.skills.slice(0, 2).map((s) => (
              <Badge key={s} variant="outline" className="rounded-full text-[11px] font-normal text-muted-foreground">
                {s}
              </Badge>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-border/50 pt-3">
            <Link
              href={`#/u/${project.owner.username}`}
              className="relative z-30 flex min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`${project.owner.name} — view profile`}
            >
              <Avatar className="size-6">
                <AvatarImage src={project.owner.avatarUrl ?? undefined} alt="" />
                <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
              </Avatar>
              <span className="truncate">{project.owner.name}</span>
            </Link>
            <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1" title="Views (estimated)">
                <Eye className="size-3.5" aria-hidden /> {formatCompact(project.counts.views)}
              </span>
              <span className="inline-flex items-center gap-1" title="Saves">
                <Bookmark className="size-3.5" aria-hidden /> {formatCompact(project.counts.saves)}
              </span>
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}
