"use client";

import { useState } from "react";
import { Check, ChevronRight, Globe, ListChecks, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { navigate } from "@/lib/hash-router";
import { publicProfileHashUrl, seoOrigin } from "@/lib/site-url";
import { cn } from "@/lib/utils";
import type { ProjectCardDTO } from "@/lib/types";

/**
 * CompletionChecklist — an honest, data-derived guide that helps a creator
 * build a searchable, professional portfolio. Every step is computed from the
 * user's REAL profile/project records — nothing is ever fabricated to make a
 * profile look complete. The card disappears when every step is done or the
 * user dismisses it (per user, persisted locally).
 */

export interface ChecklistProfile {
  id: string;
  username: string | null;
  name: string;
  headline: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  professions: string[];
  skills: string[];
  profileVisibility: string;
}

const BIO_MIN = 80; // "clear, specific" — the threshold is shown to the user
const SKILL_MIN = 3;

function dismissKey(userId: string): string {
  return `bean:checklist:${userId}:dismissed`;
}
function reviewedKey(userId: string): string {
  return `bean:checklist:${userId}:seo-reviewed`;
}

function readLocal(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function CompletionChecklist({
  profile,
  publishedProjects,
}: {
  profile: ChecklistProfile;
  /** The user's PUBLISHED projects (card DTOs) — real records only. */
  publishedProjects: ProjectCardDTO[];
}) {
  const [dismissed, setDismissed] = useState(() => readLocal(dismissKey(profile.id)));
  const [reviewed, setReviewed] = useState(() => readLocal(reviewedKey(profile.id)));

  const hasMeaningfulProject = publishedProjects.some((p) => Boolean(p.category && p.summary?.trim()));
  const bioLen = profile.bio?.trim().length ?? 0;
  const discoverable = profile.profileVisibility === "PUBLIC" && publishedProjects.length >= 1;

  const steps = [
    {
      id: "title-profession",
      label: "Add a professional title and pick your profession",
      done: Boolean(profile.headline?.trim()) && profile.professions.length > 0,
      hint: "Shown next to your name everywhere — it is also what search matches.",
      action: "Edit your profile below",
      onAction: () => scrollToForm(),
    },
    {
      id: "bio",
      label: `Write a clear, specific bio (${bioLen}/${BIO_MIN} characters)`,
      done: bioLen >= BIO_MIN,
      hint: "What you make, who you work with, what you are looking for.",
      action: "Edit your profile below",
      onAction: () => scrollToForm(),
    },
    {
      id: "skills",
      label: `Add relevant skills and specialties (${Math.min(profile.skills.length, SKILL_MIN)}/${SKILL_MIN})`,
      done: profile.skills.length >= SKILL_MIN,
      hint: "Skills power search results and category relevance.",
      action: "Edit your profile below",
      onAction: () => scrollToForm(),
    },
    {
      id: "images",
      label: "Add a profile image and a cover",
      done: Boolean(profile.avatarUrl && profile.coverUrl),
      hint: "Use the photo controls on your profile header above.",
      action: "Open the profile header",
      onAction: () => window.scrollTo({ top: 0, behavior: "smooth" }),
    },
    {
      id: "first-project",
      label: "Publish a project with a title, summary and category",
      done: hasMeaningfulProject,
      hint: "Projects without a summary or category are hard to discover.",
      action: "Create a project",
      onAction: () => navigate("/studio/new"),
    },
    {
      id: "seo-review",
      label: "Review your public profile and the SEO preview",
      done: reviewed,
      hint: "See exactly how your portfolio appears in search results below.",
      action: "Open public profile",
      onAction: () => {
        try {
          window.localStorage.setItem(reviewedKey(profile.id), "1");
        } catch {
          /* storage unavailable */
        }
        setReviewed(true);
        if (profile.username) navigate(`/u/${profile.username}`);
      },
    },
    {
      id: "go-live",
      label:
        profile.profileVisibility === "PUBLIC"
          ? "Make your portfolio discoverable — publish your first project"
          : "Make your portfolio discoverable — set your profile to Public",
      done: discoverable,
      hint:
        profile.profileVisibility === "PUBLIC"
          ? "Your profile is public; it becomes discoverable once a project is published."
          : "Your profile is hidden. Change visibility in Trust & settings.",
      action: profile.profileVisibility === "PUBLIC" ? "Create a project" : "Open settings",
      onAction: () => navigate(profile.profileVisibility === "PUBLIC" ? "/studio/new" : "/settings"),
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  function scrollToForm() {
    document.getElementById("profile-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (dismissed || allDone) return null;

  const seoTitle = `${profile.name}${profile.headline ? ` — ${profile.headline}` : ""} | BEAN Folio`;
  const seoDescription =
    profile.bio?.trim().slice(0, 155) ??
    profile.headline ??
    `Portfolio of ${profile.name} on BEAN Folio.`;
  // Displayed in the SEO preview. With a verified production origin: the
  // permanent canonical URL. Without one: the ROUTE only (`/#/u/name`) — a
  // workspace/sandbox/preview host is never displayed as if it were the
  // permanent public address.
  const displayOrigin = seoOrigin();
  const routeHash = profile.username ? publicProfileHashUrl(profile.username) : null;
  const searchHost = displayOrigin ? new URL(displayOrigin).host : null;
  const seoUrl = profile.username
    ? `${searchHost ?? ""}/${routeHash ?? ""}`.replace(/^\/$/, "/")
    : (displayOrigin ?? "/");

  return (
    <section
      aria-label="Portfolio completion checklist"
      className="mt-6 rounded-xl border border-primary/25 bg-gold-soft/20 p-4 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gold-soft text-primary ring-1 ring-primary/25">
            <ListChecks className="size-4.5" aria-hidden />
          </span>
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
              Build your portfolio — {doneCount} of {steps.length} complete
            </h2>
            <p className="text-xs text-muted-foreground">
              Optional, but every step makes you easier to find. Progress reflects your real profile.
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Hide the completion checklist"
          onClick={() => {
            try {
              window.localStorage.setItem(dismissKey(profile.id), "1");
            } catch {
              /* storage unavailable */
            }
            setDismissed(true);
          }}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <div
        className="mt-4 h-1.5 overflow-hidden rounded-full bg-background/70"
        role="progressbar"
        aria-valuenow={doneCount}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-label="Checklist progress"
      >
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${Math.round((doneCount / steps.length) * 100)}%` }}
        />
      </div>

      <ol className="mt-4 grid gap-2 lg:grid-cols-1 xl:grid-cols-2">
        {steps.map((step) => (
          <li
            key={step.id}
            className={cn(
              "flex items-start gap-3 rounded-lg border p-3 transition-colors",
              step.done ? "border-border/40 bg-background/40" : "border-border/60 bg-background/70"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
                step.done ? "bg-primary text-primary-foreground" : "border border-muted-foreground/40 text-transparent"
              )}
            >
              <Check className="size-3" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("block text-sm font-medium", step.done ? "text-muted-foreground line-through decoration-border" : "text-foreground")}>
                {step.label}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{step.hint}</span>
              {!step.done && (
                <button
                  type="button"
                  onClick={step.onAction}
                  className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:underline"
                >
                  {step.action} <ChevronRight className="size-3" aria-hidden />
                </button>
              )}
            </span>
            <span className="sr-only">{step.done ? "Completed" : "Not done yet"}</span>
          </li>
        ))}
      </ol>

      {/* SEO preview — a faithful rendering of the tags actually emitted for the
          public profile (see PublicProfileView). Real data only. */}
      <div className="mt-5 rounded-lg border border-border/60 bg-background p-4">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Globe className="size-3.5" aria-hidden />{" "}
          Search preview — {profile.username ? `${searchHost ? `${searchHost}/` : ""}${routeHash ?? ""}` : "public profile"}
        </p>
        <p className="mt-2 truncate text-base text-primary">{seoTitle}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{seoUrl}</p>
        <p className="mt-1 line-clamp-2 text-sm text-foreground/80">
          {seoDescription}
          {profile.bio && (profile.bio.trim().length ?? 0) > 155 ? "…" : ""}
        </p>
      </div>
    </section>
  );
}
