"use client";

import Link from "next/link";
import { MapPin } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FollowButton } from "@/components/bean/FollowButton";
import { categoryLabel } from "@/components/bean/ProjectCard";
import type { PublicPerson } from "@/lib/types";
import { cn } from "@/lib/utils";

export function PersonCard({ person, className }: { person: PublicPerson; className?: string }) {
  const initials = person.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <article className={cn("flex items-start gap-3 rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-primary/25", className)}>
      <Avatar className="size-11 shrink-0 ring-1 ring-border">
        <AvatarImage src={person.avatarUrl ?? undefined} alt={`${person.name}'s avatar`} />
        <AvatarFallback className="text-sm">{initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <Link href={`#/u/${person.username}`} className="truncate font-medium text-foreground transition-colors hover:text-primary">
            {person.name}
          </Link>
          <FollowButton person={person} />
        </div>
        {person.headline && <p className="truncate text-sm text-muted-foreground">{person.headline}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {person.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3" aria-hidden /> {person.location}
            </span>
          )}
          {person.professions.slice(0, 2).map((p) => (
            <span key={p} className="rounded-full bg-secondary px-2 py-0.5">
              {categoryLabel(p)}
            </span>
          ))}
          <span>
            {person.stats.followers} {person.stats.followers === 1 ? "follower" : "followers"} · {person.stats.projects}{" "}
            {person.stats.projects === 1 ? "project" : "projects"}
          </span>
        </div>
      </div>
    </article>
  );
}
