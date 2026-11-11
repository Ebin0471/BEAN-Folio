"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bookmark,
  Eye,
  ExternalLink,
  FileText,
  Flag,
  Github,
  ImageOff,
  Music2,
  Pencil,
  Send,
  Share2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { api, ApiError, formatCompact, formatDate } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSeo } from "@/lib/seo";
import { publicProfilePath, seoOrigin } from "@/lib/site-url";
import {
  familyForProfession,
  kindLabel,
  UNIVERSAL_PROJECT_KINDS,
  workProfileForFamily,
  workProfileForProfessions,
} from "@/lib/studio-schema";
import type { ProjectCardDTO, ProjectDetailResponse, ProjectMediaDTO } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/bean/EmptyState";
import { MediaThumb } from "@/components/bean/MediaThumb";
import { FollowButton } from "@/components/bean/FollowButton";
import { ProjectCard, categoryLabel } from "@/components/bean/ProjectCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

const REPORT_REASONS = ["Spam", "Inappropriate", "Stolen work", "Misinformation", "Other"] as const;

// ------------------------------------------------------------------ skeletons

function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6" aria-busy="true" aria-label="Loading project">
      <Skeleton className="h-6 w-32 rounded-full" />
      <Skeleton className="mt-4 h-10 w-3/4" />
      <div className="mt-4 flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      </div>
      <Skeleton className="mt-8 aspect-video w-full rounded-xl" />
      <div className="mt-8 space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ media pieces

function GalleryItem({
  item,
  onOpen,
}: {
  item: ProjectMediaDTO;
  onOpen: (m: ProjectMediaDTO) => void;
}) {
  if (item.kind === "AUDIO") {
    return (
      <div className="rounded-xl border border-border/60 bg-card p-4 sm:col-span-2">
        <p className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Music2 className="size-4 text-primary" aria-hidden /> Audio
        </p>
        <audio controls src={item.url} className="w-full" preload="metadata" aria-label={item.caption || "Audio track"} />
        {item.caption && <p className="mt-2 text-sm text-muted-foreground">{item.caption}</p>}
      </div>
    );
  }

  if (item.kind === "DOCUMENT") {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-4 rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-primary/30 sm:col-span-2"
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-gold-soft text-primary">
          <FileText className="size-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.caption || "Document (PDF)"}</span>
          <span className="text-xs text-muted-foreground">Opens in a new tab</span>
        </span>
        <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </a>
    );
  }

  // IMAGE + VIDEO open the lightbox (video renders a player inside)
  return (
    <figure className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <button
        type="button"
        className="block w-full cursor-zoom-in text-left"
        onClick={() => onOpen(item)}
        aria-label={item.caption || (item.kind === "VIDEO" ? "Play video" : "View image")}
      >
        <MediaThumb src={item.url} alt={item.caption || "Project media"} kind={item.kind} aspect="aspect-[4/3]" />
      </button>
      {item.caption && (
        <figcaption className="px-4 py-2.5 text-sm text-muted-foreground">{item.caption}</figcaption>
      )}
    </figure>
  );
}

// ------------------------------------------------------------------ view

export default function ProjectDetailView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [saved, setSaved] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [savesCount, setSavesCount] = useState(0);
  const [viewsCount, setViewsCount] = useState(0);

  const [viewer, setViewer] = useState<ProjectMediaDTO | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<string>("");
  const [reportDetails, setReportDetails] = useState("");
  const [reportBusy, setReportBusy] = useState(false);

  // Related work — genuinely related PUBLISHED projects (same category/skills).
  // null = loading; on error the section stays hidden, never fake content.
  const [related, setRelated] = useState<ProjectCardDTO[] | null>(null);

  useEffect(() => {
    if (!data?.project) return;
    let alive = true;
    setRelated(null);
    api<{ items: ProjectCardDTO[] }>(`/api/projects/${projectId}/related`)
      .then((r) => alive && setRelated(r.items))
      .catch(() => alive && setRelated([])); // hidden on error — no placeholder work
    return () => {
      alive = false;
    };
  }, [data?.project, projectId]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    try {
      const res = await api<ProjectDetailResponse>(`/api/projects/${projectId}`);
      setData(res);
      setSaved(res.isSaved);
      setSavesCount(res.project.counts.saves);
      setViewsCount(res.project.counts.views);
      // Anon view tracking — fire and forget, never blocks the page
      void api(`/api/projects/${projectId}/view`, { method: "POST" }).catch(() => undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setLoadError(e instanceof Error ? e.message : "Could not load this project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ------------------------------------------------------------- SEO
  // Real content only: drafts and non-public projects are noindex (owners see
  // the draft preview; visitors already get a 404 from the visibility ladder).
  // CreativeWork structured data is emitted only for PUBLISHED+PUBLIC work.
  const seoInput = useMemo(() => {
    if (loading) return null;
    if (notFound) {
      return {
        title: "Project not found — BEAN Folio",
        description: "This project doesn't exist, is private, or the link is no longer valid.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    if (loadError || !data) {
      return {
        title: "Project unavailable — BEAN Folio",
        description: "The project could not be loaded.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    const p = data.project;
    const isPublic = p.status === "PUBLISHED" && p.visibility === "PUBLIC";
    const title = `${p.title} — ${p.owner.name} | BEAN Folio`;
    const description =
      p.summary?.trim() || p.description?.trim().slice(0, 160) || `A project by ${p.owner.name} on BEAN Folio.`;
    // Metadata URLs use the VERIFIED configured production origin only (see
    // lib/site-url) — never the current preview/workspace host.
    const origin = seoOrigin();
    const jsonLd = isPublic
      ? ({
          "@context": "https://schema.org",
          "@type": "CreativeWork",
          name: p.title,
          ...(p.summary ? { abstract: p.summary } : {}),
          ...(p.description ? { description: p.description } : {}),
          ...(origin && p.coverUrl ? { image: `${origin}${p.coverUrl}` } : {}),
          ...(p.publishedAt ? { datePublished: p.publishedAt } : {}),
          author: {
            "@type": "Person",
            name: p.owner.name,
            // PATH form — served at the path by src/proxy.ts; matches the canonical.
            ...(origin && publicProfilePath(p.owner.username)
              ? { url: `${origin}${publicProfilePath(p.owner.username)}` }
              : {}),
          },
          ...(p.category ? { genre: p.category } : {}),
          ...(p.skills.length > 0 ? { keywords: p.skills.join(", ") } : {}),
          // PATH form — served at the path by src/proxy.ts; matches the canonical.
          ...(origin ? { url: `${origin}/p/${p.id}` } : {}),
        } as Record<string, unknown>)
      : null;
    return {
      title,
      description,
      path: `/p/${projectId}`,
      type: "article" as const,
      image: p.coverUrl,
      noindex: !isPublic,
      jsonLd,
    };
  }, [data, loading, notFound, loadError, projectId]);
  useSeo(seoInput);

  async function toggleSave() {
    if (saveBusy) return;
    setSaveBusy(true);
    try {
      const res = await api<{ saved: boolean }>(`/api/projects/${projectId}/save`, {
        method: saved ? "DELETE" : "POST",
      });
      setSaved(res.saved);
      setSavesCount((n) => Math.max(0, n + (res.saved ? 1 : -1)));
      toast.success(res.saved ? "Saved to your folio" : "Removed from your saved projects");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) toast.error("Sign in to save projects to your folio");
      else toast.error(e instanceof Error ? e.message : "Could not update save");
    } finally {
      setSaveBusy(false);
    }
  }

  async function share() {
    const url = window.location.href;
    const legacyCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let okCopy = false;
      try {
        okCopy = document.execCommand("copy");
      } catch {
        okCopy = false;
      }
      document.body.removeChild(ta);
      return okCopy;
    };
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else if (!legacyCopy()) {
        throw new Error("copy failed");
      }
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy — the link is " + url);
    }
  }

  async function submitReport() {
    if (!reportReason) {
      toast.error("Pick a reason for the report.");
      return;
    }
    setReportBusy(true);
    try {
      await api("/api/reports", {
        method: "POST",
        json: {
          targetType: "PROJECT",
          targetId: projectId,
          reason: reportReason,
          details: reportDetails.trim() || undefined,
        },
      });
      toast.success("Report received — our moderators will review it.");
      setReportOpen(false);
      setReportReason("");
      setReportDetails("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) toast.error("Sign in to report content");
      else toast.error(e instanceof Error ? e.message : "Could not send report");
    } finally {
      setReportBusy(false);
    }
  }

  // ------------------------------------------------------------ render guards

  if (loading) return <DetailSkeleton />;

  if (notFound) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 sm:px-6">
        <EmptyState
          icon={ImageOff}
          title="Project not found"
          description="This project doesn't exist, is private, or the link is no longer valid."
          action={<Button onClick={() => navigate("/")}>Back to Discover</Button>}
        />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 sm:px-6">
        <EmptyState
          icon={X}
          title="Something went wrong"
          description={loadError ?? "Could not load this project."}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
              <Button onClick={() => navigate("/")}>Back to Discover</Button>
            </div>
          }
        />
      </div>
    );
  }

  const { project, owner, isOwner } = data;
  const cover = project.coverUrl ? project.media.find((m) => m.url === project.coverUrl) ?? null : null;
  // Cover kind from the media row when available, else the API-provided
  // coverKind (covers can be set without a surviving media row).
  const coverKind = cover?.kind ?? project.coverKind ?? undefined;
  const gallery = cover ? project.media.filter((m) => m.mediaId !== cover.mediaId) : project.media;

  // Universal Studio presentation schema — the project's own category leads;
  // deliberately viewer-independent (a public page renders the same labels
  // for everyone). Plain computations — no hooks after the early returns.
  const detailProfile = (() => {
    if (project.category) {
      const fam = familyForProfession(project.category);
      if (fam) return workProfileForFamily(fam);
    }
    return workProfileForProfessions([]);
  })();
  const storyLabels = {
    brief: detailProfile.fieldOverrides.brief?.label ?? "The brief",
    process: detailProfile.fieldOverrides.process?.label ?? "Process & iterations",
    challenges: detailProfile.fieldOverrides.challenges?.label ?? "Challenges & decisions",
    outcome: detailProfile.fieldOverrides.outcome?.label ?? "Outcome & results",
  };
  const kindLabelText = (() => {
    const slug = project.kind ?? project.customFields?.kind ?? null;
    if (!slug) return "";
    return (
      kindLabel(detailProfile, slug) ||
      UNIVERSAL_PROJECT_KINDS.find((k) => k.slug === slug)?.label ||
      slug
    );
  })();
  const customFieldRows = (() => {
    const rows: { label: string; value: string }[] = [];
    const fields = project.customFields?.fields ?? {};
    for (const def of detailProfile.suggestedFields) {
      const v = fields[def.key];
      if (v) rows.push({ label: def.label, value: v });
    }
    // Fields from other schemas (profession switched later) still render —
    // stored data is never hidden.
    const known = new Set(detailProfile.suggestedFields.map((d) => d.key));
    for (const [key, v] of Object.entries(fields)) {
      if (!known.has(key) && v) rows.push({ label: key.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), value: v });
    }
    for (const c of project.customFields?.custom ?? []) {
      if (c.value) rows.push({ label: c.label, value: c.value });
    }
    return rows;
  })();

  const story: { title: string; body: string }[] = [];
  if (project.brief) story.push({ title: storyLabels.brief, body: project.brief });
  if (project.process) story.push({ title: storyLabels.process, body: project.process });
  if (project.challenges) story.push({ title: storyLabels.challenges, body: project.challenges });
  if (project.outcome) story.push({ title: storyLabels.outcome, body: project.outcome });
  const initials = owner.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <article className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      {/* ---------------- header */}
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="rounded-full">
            {categoryLabel(project.category)}
          </Badge>
          {kindLabelText && (
            <Badge variant="outline" className="rounded-full text-muted-foreground">
              {kindLabelText}
            </Badge>
          )}
          {project.status === "DRAFT" && (
            <Badge className="rounded-full bg-gold-soft text-primary ring-1 ring-primary/25 border-transparent">
              Draft
            </Badge>
          )}
          {isOwner && project.visibility !== "PUBLIC" && (
            <Badge variant="outline" className="rounded-full text-muted-foreground">
              {project.visibility === "UNLISTED" ? "Unlisted" : "Private"}
            </Badge>
          )}
        </div>

        <h1 className="mt-4 font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          {project.title}
        </h1>

        {isOwner && project.status === "DRAFT" && (
          <p className="mt-3 rounded-lg bg-gold-soft/50 px-3 py-2 text-sm text-primary ring-1 ring-primary/20">
            Draft preview — visitors can't see this yet. Publish it from the editor when it's ready.
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={() => navigate(`/u/${owner.username}`)}
            className="group flex items-center gap-2.5 text-left"
          >
            <Avatar className="size-10 ring-1 ring-border transition group-hover:ring-primary/40">
              <AvatarImage src={owner.avatarUrl ?? undefined} alt={`${owner.name}'s avatar`} />
              <AvatarFallback className="text-sm">{initials}</AvatarFallback>
            </Avatar>
            <span>
              <span className="block text-sm font-medium text-foreground transition-colors group-hover:text-primary">
                {owner.name}
              </span>
              <span className="block text-xs text-muted-foreground">
                {project.publishedAt ? `Published ${formatDate(project.publishedAt)}` : "Unpublished draft"}
                {" · "}
                <span title="View counts are deduplicated and estimated">
                  Estimated {formatCompact(viewsCount)} views · {formatCompact(savesCount)} saves
                </span>
              </span>
            </span>
          </button>
        </div>

        {/* action row */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            variant={saved ? "secondary" : "outline"}
            size="sm"
            onClick={() => void toggleSave()}
            disabled={saveBusy}
            aria-pressed={saved}
            className="gap-1.5"
          >
            <Bookmark className={cn("size-4", saved && "fill-primary text-primary")} aria-hidden />
            {saved ? "Saved" : "Save"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void share()} className="gap-1.5">
            <Share2 className="size-4" aria-hidden /> Share
          </Button>
          {isOwner && (
            <Button variant="outline" size="sm" onClick={() => navigate(`/studio/${project.id}/edit`)} className="gap-1.5">
              <Pencil className="size-4" aria-hidden /> Edit
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => setReportOpen(true)}
          >
            <Flag className="size-3.5" aria-hidden /> Report
          </Button>
        </div>
      </header>

      {/* ---------------- cover — a media-backed cover opens the lightbox
          player (play/pause, seek, volume). Without this a video cover could
          never be played: the gallery excludes the cover item, so the page's
          only player was unreachable. */}
      <div className="mt-8">
        {project.coverUrl ? (
          <button
            type="button"
            className="block w-full cursor-zoom-in text-left"
            onClick={() =>
              setViewer(
                cover ?? { mediaId: "", url: project.coverUrl!, kind: (coverKind ?? "IMAGE") as string, caption: project.title } as ProjectMediaDTO
              )
            }
            aria-label={`${project.title} — ${coverKind === "VIDEO" ? "Play video" : "View cover"}`}
          >
            <MediaThumb
              src={project.coverUrl}
              alt={`${project.title} — cover`}
              kind={coverKind}
              aspect="aspect-video"
              className="rounded-xl border border-border/60"
            />
          </button>
        ) : (
          <MediaThumb
            src={project.coverUrl}
            alt={`${project.title} — cover`}
            kind={coverKind}
            aspect="aspect-video"
            className="rounded-xl border border-border/60"
          />
        )}
      </div>

      {/* ---------------- gallery */}
      {gallery.length > 0 && (
        <section className="mt-6" aria-label="Project media gallery">
          <div className="grid gap-4 sm:grid-cols-2">
            {gallery.map((m) => (
              <GalleryItem key={m.id} item={m} onOpen={setViewer} />
            ))}
          </div>
        </section>
      )}

      {/* ---------------- summary + story */}
      {(project.summary || story.length > 0 || project.description || project.role) && (
        <section className="mt-10 max-w-3xl">
          {project.summary && (
            <p className="font-display text-xl leading-relaxed text-foreground/90">{project.summary}</p>
          )}

          {project.role && (
            <div className="mt-6 rounded-xl border-l-2 border-primary bg-gold-soft/30 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-primary">My role</p>
              <p className="mt-1 text-sm text-foreground/90">{project.role}</p>
            </div>
          )}

          {story.map((s) => (
            <div key={s.title} className="mt-8">
              <h2 className="font-display text-xl font-semibold tracking-tight">{s.title}</h2>
              <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          ))}

          {project.description && (
            <div className="mt-8">
              <h2 className="font-display text-xl font-semibold tracking-tight">About this project</h2>
              <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed text-muted-foreground">
                {project.description}
              </p>
            </div>
          )}
        </section>
      )}

      {/* ---------------- skills / tools / links */}
      {(project.skills.length > 0 || project.tools.length > 0) && (
        <section className="mt-10 max-w-3xl" aria-label="Skills and tools">
          {project.skills.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Skills</span>
              {project.skills.map((s) => (
                <Badge key={s} variant="secondary" className="rounded-full font-normal">
                  {s}
                </Badge>
              ))}
            </div>
          )}
          {project.tools.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Tools</span>
              {project.tools.map((t) => (
                <Badge key={t} variant="outline" className="rounded-full font-normal text-muted-foreground">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </section>
      )}

      {(project.externalUrl || project.repoUrl) && (
        <div className="mt-6 flex flex-wrap gap-2">
          {project.externalUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={project.externalUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" aria-hidden /> {detailProfile.fieldOverrides.externalUrl?.label ?? "Visit project"}
              </a>
            </Button>
          )}
          {project.repoUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={project.repoUrl} target="_blank" rel="noopener noreferrer">
                <Github className="size-4" aria-hidden /> {detailProfile.fieldOverrides.repoUrl?.label ?? "View repository"}
              </a>
            </Button>
          )}
        </div>
      )}

      {/* ---------------- profession-specific structured + custom fields */}
      {customFieldRows.length > 0 && (
        <section className="mt-10 max-w-3xl" aria-label="Profession details">
          <h2 className="font-display text-xl font-semibold tracking-tight">Details</h2>
          <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {customFieldRows.map((row) => (
              <div key={row.label} className="rounded-xl border border-border/60 bg-card px-4 py-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{row.label}</dt>
                <dd className="mt-1 whitespace-pre-wrap text-sm text-foreground/90">{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* ---------------- contributors */}
      {project.contributors.length > 0 && (
        <section className="mt-10 max-w-3xl" aria-label="Contributors">
          <h2 className="font-display text-xl font-semibold tracking-tight">Contributors</h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {project.contributors.map((c) => (
              <li key={c.id} className="rounded-xl border border-border/60 bg-card p-4">
                <p className="font-medium">{c.name}</p>
                {c.role && <p className="text-sm text-primary">{c.role}</p>}
                {c.contribution && <p className="mt-1 text-sm text-muted-foreground">{c.contribution}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------------- owner card */}
      <section className="mt-12 rounded-xl border border-border/60 bg-card p-6" aria-label="About the creator">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar className="size-14 ring-1 ring-border">
            <AvatarImage src={owner.avatarUrl ?? undefined} alt={`${owner.name}'s avatar`} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => navigate(`/u/${owner.username}`)}
                className="font-display text-lg font-semibold transition-colors hover:text-primary"
              >
                {owner.name}
              </button>
              {owner.availability && (
                <span className="rounded-full bg-gold-soft px-2.5 py-0.5 text-xs font-medium text-primary ring-1 ring-primary/25">
                  {owner.availability}
                </span>
              )}
            </div>
            {owner.headline && <p className="mt-0.5 text-sm text-muted-foreground">{owner.headline}</p>}
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Eye className="size-3.5" aria-hidden /> {owner.stats.followers}{" "}
                {owner.stats.followers === 1 ? "follower" : "followers"}
              </span>
              <span>
                {owner.stats.projects} {owner.stats.projects === 1 ? "project" : "projects"}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <FollowButton person={owner} />
            <Button variant="outline" size="sm" onClick={() => navigate(`/u/${owner.username}`)}>
              View profile
            </Button>
          </div>
        </div>
      </section>

      {/* ---------------- related work (real, published, same category/skills) */}
      {related !== null && related.length > 0 && (
        <section className="mt-12" aria-label="Related work">
          <h2 className="font-display text-xl font-semibold tracking-tight">
            {project.category ? `More in ${categoryLabel(project.category)}` : "Related work"}
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {related.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        </section>
      )}

      {/* ---------------- lightbox */}
      <Dialog open={viewer !== null} onOpenChange={(open) => !open && setViewer(null)}>
        <DialogContent className="max-w-3xl p-3 sm:p-4">
          <DialogHeader className="sr-only">
            <DialogTitle>{viewer?.caption || "Project media"}</DialogTitle>
            <DialogDescription>Media viewer</DialogDescription>
          </DialogHeader>
          {viewer?.kind === "VIDEO" ? (
            <video src={viewer.url} controls autoPlay playsInline className="max-h-[75vh] w-full rounded-lg bg-black" />
          ) : viewer ? (
            <img src={viewer.url} alt={viewer.caption || "Project media"} className="max-h-[75vh] w-full rounded-lg object-contain" />
          ) : null}
          {viewer?.caption && <p className="px-1 pb-1 text-sm text-muted-foreground">{viewer.caption}</p>}
        </DialogContent>
      </Dialog>

      {/* ---------------- report dialog */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Report this project</DialogTitle>
            <DialogDescription>
              Reports go to moderators only — the owner is not told who reported.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="report-reason">Reason</Label>
              <Select value={reportReason || undefined} onValueChange={setReportReason}>
                <SelectTrigger id="report-reason" className="w-full">
                  <SelectValue placeholder="Choose a reason" />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="report-details">Details (optional)</Label>
              <Textarea
                id="report-details"
                value={reportDetails}
                maxLength={1000}
                placeholder="Anything that helps moderators understand the issue."
                onChange={(e) => setReportDetails(e.target.value)}
                className="min-h-20"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setReportOpen(false)} disabled={reportBusy}>
                Cancel
              </Button>
              <Button onClick={() => void submitReport()} disabled={reportBusy || !reportReason}>
                <Send className="size-4" aria-hidden /> {reportBusy ? "Sending…" : "Send report"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </article>
  );
}
