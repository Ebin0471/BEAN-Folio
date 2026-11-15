"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CloudUpload,
  CloudOff,
  Copy,
  Eye,
  Images,
  LayoutGrid,
  Layers,
  List,
  Bookmark,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { api, formatCompact, formatDate } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import { categoryLabel } from "@/lib/categories";
import { kindLabel, workProfileForProfessions } from "@/lib/studio-schema";
import type { ProjectCardDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState } from "@/components/bean/EmptyState";
import { MediaThumb } from "@/components/bean/MediaThumb";
import { categoryLabel as legacyCategoryLabel } from "@/components/bean/ProjectCard";
import { SectionHeader, StatCard } from "@/components/bean/SectionHeader";
import CreateProjectFlow from "@/components/bean/CreateProjectFlow";
import StudioAssets from "@/components/bean/StudioAssets";

type Tab = "DRAFT" | "PUBLISHED" | "ARCHIVED";
type Section = "projects" | "assets";
type SortKey = "updated" | "created" | "title";
type ViewMode = "list" | "grid";

/** "All" keeps the list unfiltered; any other value is a profession-slug category. */
const CATEGORY_FILTER_ALL = "*";

/** Persisted Studio view preference (grid vs list) — tiny, best-effort. */
const VIEW_PREF_KEY = "bean:studio-view-mode";

function loadViewPref(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_PREF_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function saveViewPref(mode: ViewMode) {
  try {
    window.localStorage.setItem(VIEW_PREF_KEY, mode);
  } catch {
    /* storage unavailable — preference just won't persist */
  }
}

// ------------------------------------------------------------------ badges

function StatusBadge({ status }: { status: string }) {
  if (status === "PUBLISHED") {
    return (
      <Badge className="rounded-full bg-gold-soft text-primary ring-1 ring-primary/25 border-transparent">
        Published
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="rounded-full">
      Draft
    </Badge>
  );
}

function VisibilityBadge({ visibility }: { visibility: string }) {
  if (visibility === "UNLISTED") {
    return (
      <Badge variant="outline" className="rounded-full text-muted-foreground">
        Unlisted
      </Badge>
    );
  }
  if (visibility === "PRIVATE") {
    return (
      <Badge variant="outline" className="rounded-full text-muted-foreground">
        <MoreHorizontal className="size-3" aria-hidden /> Private
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="rounded-full text-muted-foreground">
      Public
    </Badge>
  );
}

function MetaBadges({ project, rowProfile }: { project: ProjectCardDTO; rowProfile: ReturnType<typeof workProfileForProfessions> }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <StatusBadge status={project.status} />
      <VisibilityBadge visibility={project.visibility} />
      {project.featured && project.status === "PUBLISHED" && (
        <Badge className="rounded-full border-transparent bg-primary/10 text-primary ring-1 ring-primary/30" title="Featured on your public profile">
          <Star className="mr-1 size-3 fill-current" aria-hidden /> Featured
        </Badge>
      )}
      <span className="text-xs text-muted-foreground">{legacyCategoryLabel(project.category)}</span>
      {project.kind && (
        <span className="text-xs text-muted-foreground">· {kindLabel(rowProfile, project.kind)}</span>
      )}
    </div>
  );
}

function ProjectMetaLine({ project }: { project: ProjectCardDTO }) {
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      <span>
        Updated {formatDate(project.status === "PUBLISHED" ? project.publishedAt ?? project.updatedAt : project.updatedAt)}
      </span>
      <span className="inline-flex items-center gap-1">
        <Eye className="size-3" aria-hidden /> {formatCompact(project.counts.views)} views (est.)
      </span>
      <span className="inline-flex items-center gap-1">
        <Bookmark className="size-3" aria-hidden /> {formatCompact(project.counts.saves)} saves
      </span>
    </p>
  );
}

// ------------------------------------------------------------------ actions

interface ProjectActions {
  busy: boolean;
  archivedTab: boolean;
  onPublishToggle: (p: ProjectCardDTO) => void;
  onFeatureToggle: (p: ProjectCardDTO) => void;
  onDuplicate: (p: ProjectCardDTO) => void;
  onArchiveToggle: (p: ProjectCardDTO) => void;
  onRequestDelete: (p: ProjectCardDTO) => void;
}

function PrimaryActions({ project, a }: { project: ProjectCardDTO; a: ProjectActions }) {
  if (a.archivedTab) {
    return (
      <Button variant="outline" size="sm" disabled={a.busy} onClick={() => a.onArchiveToggle(project)}>
        <ArchiveRestore className="size-3.5" aria-hidden /> Restore
      </Button>
    );
  }
  return (
    <>
      <Button variant="outline" size="sm" disabled={a.busy} onClick={() => navigate(`/studio/${project.id}/edit`)}>
        <Pencil className="size-3.5" aria-hidden /> Edit
      </Button>
      <Button variant="ghost" size="sm" disabled={a.busy} onClick={() => navigate(`/p/${project.id}`)}>
        View
      </Button>
      {project.status === "DRAFT" ? (
        <Button variant="outline" size="sm" disabled={a.busy} onClick={() => a.onPublishToggle(project)}>
          <CloudUpload className="size-3.5 text-primary" aria-hidden /> Publish
        </Button>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={a.busy}
            onClick={() => a.onFeatureToggle(project)}
            aria-pressed={project.featured}
            title={project.featured ? "Stop featuring on your public profile" : "Feature on your public profile"}
          >
            <Star
              className={cn("size-3.5", project.featured ? "fill-current text-primary" : "text-muted-foreground")}
              aria-hidden
            />
            {project.featured ? "Unfeature" : "Feature"}
          </Button>
          <Button variant="outline" size="sm" disabled={a.busy} onClick={() => a.onPublishToggle(project)}>
            <CloudOff className="size-3.5" aria-hidden /> Unpublish
          </Button>
        </>
      )}
    </>
  );
}

function ProjectMenu({ project, a }: { project: ProjectCardDTO; a: ProjectActions }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          aria-label={`More actions for ${project.title}`}
          disabled={a.busy}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => navigate(`/studio/${project.id}/edit`)}>
          <Pencil className="size-3.5" aria-hidden /> Edit project
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate(`/p/${project.id}`)}>
          <Eye className="size-3.5" aria-hidden /> Preview project
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => a.onDuplicate(project)} disabled={a.busy}>
          <Copy className="size-3.5" aria-hidden /> Duplicate
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {a.archivedTab ? (
          <DropdownMenuItem onClick={() => a.onArchiveToggle(project)} disabled={a.busy}>
            <ArchiveRestore className="size-3.5" aria-hidden /> Restore from archive
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => a.onArchiveToggle(project)} disabled={a.busy}>
            <Archive className="size-3.5" aria-hidden /> Archive
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => a.onRequestDelete(project)}
          disabled={a.busy}
        >
          <Trash2 className="size-3.5" aria-hidden /> Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ------------------------------------------------------------------ list row

function ProjectRow({ project, rowProfile, a }: { project: ProjectCardDTO; rowProfile: ReturnType<typeof workProfileForProfessions>; a: ProjectActions }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-primary/25 sm:flex-row sm:items-center">
      {/* Thumb */}
      <button
        type="button"
        onClick={() => navigate(`/p/${project.id}`)}
        className="w-full shrink-0 overflow-hidden rounded-lg sm:w-28"
        aria-label={`Open ${project.title}`}
      >
        <MediaThumb
          src={project.coverUrl}
          alt={project.title}
          aspect="aspect-[16/9]"
          className="rounded-lg sm:w-28"
        />
      </button>

      {/* Meta */}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => navigate(`/p/${project.id}`)}
          className="line-clamp-1 text-left font-medium text-foreground transition-colors hover:text-primary"
        >
          {project.title}
        </button>
        <MetaBadges project={project} rowProfile={rowProfile} />
        <ProjectMetaLine project={project} />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
        <PrimaryActions project={project} a={a} />
        <ProjectMenu project={project} a={a} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ grid card

function ProjectCard({ project, rowProfile, a }: { project: ProjectCardDTO; rowProfile: ReturnType<typeof workProfileForProfessions>; a: ProjectActions }) {
  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card transition-colors hover:border-primary/25">
      <button
        type="button"
        onClick={() => navigate(`/p/${project.id}`)}
        className="relative block w-full overflow-hidden"
        aria-label={`Open ${project.title}`}
      >
        <MediaThumb src={project.coverUrl} alt={project.title} aspect="aspect-[16/9]" className="w-full" />
        <span className="absolute left-2 top-2 flex gap-1">
          {project.featured && project.status === "PUBLISHED" && (
            <Badge className="rounded-full border-transparent bg-background/85 text-primary ring-1 ring-primary/30 backdrop-blur">
              <Star className="mr-1 size-3 fill-current" aria-hidden /> Featured
            </Badge>
          )}
        </span>
      </button>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <button
          type="button"
          onClick={() => navigate(`/p/${project.id}`)}
          className="line-clamp-1 text-left font-medium text-foreground transition-colors hover:text-primary"
        >
          {project.title}
        </button>
        <MetaBadges project={project} rowProfile={rowProfile} />
        <p className="text-xs text-muted-foreground">
          Updated {formatDate(project.updatedAt)} · {formatCompact(project.counts.views)} views (est.)
        </p>
        <div className="mt-auto flex items-center gap-1.5 pt-2">
          <PrimaryActions project={project} a={a} />
          <div className="ml-auto">
            <ProjectMenu project={project} a={a} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ skeletons

function RowsSkeleton({ mode }: { mode: ViewMode }) {
  if (mode === "grid") {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading projects">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-xl border border-border/60 bg-card">
            <Skeleton className="aspect-[16/9] w-full rounded-none" />
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading projects">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-xl border border-border/60 bg-card p-4">
          <Skeleton className="h-[63px] w-28 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <div className="hidden gap-2 sm:flex">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ view

export default function StudioView() {
  const { user } = useSession();
  const [section, setSection] = useState<Section>("projects");
  const [tab, setTab] = useState<Tab>("DRAFT");
  const [projects, setProjects] = useState<ProjectCardDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectCardDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // Organize by category ("All" = unfiltered). Resets naturally per fetch.
  const [categoryFilter, setCategoryFilter] = useState<string>(CATEGORY_FILTER_ALL);
  // Universal project management: free-text search, sort order, grid/list view.
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  useEffect(() => setViewMode(loadViewPref()), []);

  const switchViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    saveViewPref(mode);
  }, []);

  // The Studio adapts to the signed-in creator's professions — same view,
  // same navigation, profession-aware kinds and copy (universal fallback).
  const workProfile = workProfileForProfessions(user?.professions ?? []);
  const hasProfession = (user?.professions?.length ?? 0) > 0;
  const professionLine = hasProfession
    ? user!.professions.map((p) => categoryLabel(p)).slice(0, 3).join(" · ")
    : null;

  const load = useCallback(async (which: Tab, sortBy: SortKey) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (which !== "ARCHIVED") params.set("status", which);
      params.set("archived", which === "ARCHIVED" ? "true" : "false");
      params.set("sort", sortBy);
      const res = await api<{ projects: ProjectCardDTO[] }>(`/api/projects?${params.toString()}`);
      setProjects(res.projects);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab, sort);
  }, [tab, sort, load]);

  async function togglePublish(p: ProjectCardDTO) {
    const publishing = p.status === "DRAFT";
    setBusyId(p.id);
    try {
      await api<{ project: ProjectCardDTO }>(`/api/projects/${p.id}/${publishing ? "publish" : "unpublish"}`, {
        method: "POST",
      });
      toast.success(publishing ? `"${p.title}" is now live` : `"${p.title}" is back in drafts`);
      await load(tab, sort);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleFeature(p: ProjectCardDTO) {
    const featuring = !p.featured;
    setBusyId(p.id);
    try {
      await api<{ project: ProjectCardDTO }>(`/api/projects/${p.id}/${featuring ? "feature" : "unfeature"}`, {
        method: "POST",
      });
      toast.success(
        featuring
          ? `"${p.title}" now leads your public profile`
          : `"${p.title}" is no longer featured`
      );
      await load(tab, sort);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function duplicate(p: ProjectCardDTO) {
    setDuplicatingId(p.id);
    try {
      const res = await api<{ project: ProjectCardDTO }>(`/api/projects/${p.id}/duplicate`, { method: "POST" });
      toast.success(`Duplicate created — "${res.project.title}" is a private draft`);
      setTab("DRAFT");
      await load("DRAFT", sort);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not duplicate project");
    } finally {
      setDuplicatingId(null);
    }
  }

  async function toggleArchive(p: ProjectCardDTO) {
    const archiving = tab !== "ARCHIVED";
    setBusyId(p.id);
    try {
      await api<{ project: ProjectCardDTO }>(`/api/projects/${p.id}/${archiving ? "archive" : "unarchive"}`, {
        method: "POST",
      });
      toast.success(archiving ? `"${p.title}" moved to your archive` : `"${p.title}" restored`);
      await load(tab, sort);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/projects/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`"${deleteTarget.title}" deleted`);
      setDeleteTarget(null);
      await load(tab, sort);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete project");
    } finally {
      setDeleting(false);
    }
  }

  // Category organization: the distinct categories present in the loaded tab,
  // labeled through the live category map (profession slug → label).
  const categoryOptions = useMemo(() => {
    const slugs = new Set<string>();
    for (const p of projects ?? []) if (p.category) slugs.add(p.category);
    return [...slugs].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
  }, [projects]);

  const visibleProjects = useMemo(() => {
    let list = projects ?? [];
    if (categoryFilter !== CATEGORY_FILTER_ALL) list = list.filter((p) => p.category === categoryFilter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((p) => p.title.toLowerCase().includes(q));
    return list;
  }, [projects, categoryFilter, query]);

  const busyFor = (id: string) => busyId === id || duplicatingId === id;

  const actionsFor = useCallback(
    (a: Pick<ProjectActions, "onPublishToggle" | "onFeatureToggle" | "onDuplicate" | "onArchiveToggle" | "onRequestDelete">): ProjectActions => ({
      busy: false,
      archivedTab: tab === "ARCHIVED",
      ...a,
    }),
    [tab]
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <SectionHeader
        title={user?.name ? `Welcome back, ${user.name}` : "Create Studio"}
        description={
          professionLine
            ? `Your private workspace — adapted for ${professionLine}.`
            : "Your private workspace — drafts, publishing and project management."
        }
        action={
          <Button onClick={() => setCreateOpen(true)} data-testid="studio-new-project">
            <Plus className="size-4" aria-hidden /> New project
          </Button>
        }
      />

      {/* Studio section rail — one Studio, every workflow. Portfolio Builder,
          BEAN Intelligence and Insights live at their existing destinations. */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-full border border-border/60 bg-card p-1" role="tablist" aria-label="Studio sections">
          {(
            [
              { key: "projects", label: "My Projects", icon: Layers },
              { key: "assets", label: "Assets", icon: Images },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={section === key}
              onClick={() => setSection(key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition-colors",
                section === key
                  ? "bg-primary/10 font-medium text-primary ring-1 ring-primary/30"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          ))}
        </div>
        <nav aria-label="Studio quick links" className="flex flex-wrap items-center gap-1.5 text-xs">
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground" onClick={() => navigate("/studio/portfolio")}>
            <LayoutGrid className="size-3.5" aria-hidden /> Portfolio Builder
          </Button>
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground" onClick={() => navigate("/insights")}>
            <Eye className="size-3.5" aria-hidden /> Insights
          </Button>
        </nav>
      </div>

      {section === "assets" ? (
        <div className="mt-6">
          <StudioAssets />
        </div>
      ) : (
        <>
          {/* Overview strip — real counts from the loaded workspace data. */}
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Drafts" value={tab === "DRAFT" ? (projects?.length ?? 0) : "—"} icon={Pencil} />
            <StatCard label="Published" value={tab === "PUBLISHED" ? (projects?.length ?? 0) : "—"} icon={CloudUpload} />
            <StatCard label="Featured" value={(projects ?? []).filter((p) => p.featured).length} icon={Star} />
            <StatCard
              label="Views (est.)"
              value={formatCompact((projects ?? []).reduce((acc, p) => acc + p.counts.views, 0))}
              icon={Eye}
            />
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <TabsList aria-label="Filter projects by status">
                <TabsTrigger value="DRAFT">Drafts</TabsTrigger>
                <TabsTrigger value="PUBLISHED">Published</TabsTrigger>
                <TabsTrigger value="ARCHIVED">Archive</TabsTrigger>
              </TabsList>
              <div className="flex flex-wrap items-center gap-2">
                {/* Search (client-side over the loaded page) */}
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search projects…"
                    aria-label="Search projects by title"
                    className="h-9 w-full min-w-0 rounded-full pl-8 text-xs sm:w-52"
                  />
                </div>
                {/* Sort */}
                <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                  <SelectTrigger className="h-9 w-full rounded-full text-xs sm:w-44" aria-label="Sort projects">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="updated">Recently updated</SelectItem>
                    <SelectItem value="created">Recently created</SelectItem>
                    <SelectItem value="title">Title A–Z</SelectItem>
                  </SelectContent>
                </Select>
                {/* Category */}
                {categoryOptions.length > 1 && (
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger
                      className="h-9 w-full rounded-full text-xs sm:w-52"
                      aria-label="Filter projects by category"
                    >
                      <SelectValue placeholder="All categories" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={CATEGORY_FILTER_ALL}>All categories</SelectItem>
                      {categoryOptions.map((slug) => (
                        <SelectItem key={slug} value={slug}>
                          {categoryLabel(slug)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {/* Grid / list toggle */}
                <div className="inline-flex overflow-hidden rounded-full border border-border/60" role="group" aria-label="View mode">
                  <button
                    type="button"
                    aria-label="List view"
                    aria-pressed={viewMode === "list"}
                    onClick={() => switchViewMode("list")}
                    className={cn(
                      "grid size-9 place-items-center transition-colors",
                      viewMode === "list" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <List className="size-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label="Grid view"
                    aria-pressed={viewMode === "grid"}
                    onClick={() => switchViewMode("grid")}
                    className={cn(
                      "grid size-9 place-items-center transition-colors",
                      viewMode === "grid" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <LayoutGrid className="size-4" aria-hidden />
                  </button>
                </div>
              </div>
            </div>
          </Tabs>

          <div className="mt-5">
            {loading && <RowsSkeleton mode={viewMode} />}

            {!loading && error && (
              <EmptyState
                icon={RefreshCw}
                title="Something went wrong"
                description={error}
                action={<Button onClick={() => void load(tab, sort)}>Try again</Button>}
              />
            )}

            {!loading && !error && projects !== null && projects.length === 0 && (
              tab === "DRAFT" ? (
                <EmptyState
                  icon={LayoutGrid}
                  title="No drafts yet"
                  description={
                    hasProfession
                      ? `Start your first ${workProfile.projectKinds[0]?.label.toLowerCase() ?? "project"} — the studio adapts to your field from brief to published folio piece.`
                      : "Every great project starts as a rough sketch. Start your first one — the studio guides you from brief to published folio piece."
                  }
                  action={
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus className="size-4" aria-hidden /> New project
                    </Button>
                  }
                />
              ) : tab === "PUBLISHED" ? (
                <EmptyState
                  icon={CloudUpload}
                  title="Nothing published yet"
                  description="Publish a draft to make it visible on Discover and your public profile. You need a title and a cover or at least one media item."
                  action={
                    <Button variant="outline" onClick={() => setTab("DRAFT")}>
                      Go to drafts
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={Archive}
                  title="Your archive is empty"
                  description="Archiving tucks finished or paused work out of sight without deleting anything — restore it any time."
                />
              )
            )}

            {!loading && !error && projects !== null && projects.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {tab === "DRAFT" &&
                    `${projects.length} ${projects.length === 1 ? "draft" : "drafts"} in your studio`}
                  {tab === "PUBLISHED" &&
                    (projects.filter((p) => p.featured).length > 0
                      ? `${projects.filter((p) => p.featured).length} featured — starred work leads your public profile`
                      : "Star a project to feature it at the top of your public profile")}
                  {tab === "ARCHIVED" &&
                    `${projects.length} archived ${projects.length === 1 ? "project" : "projects"} — nothing here is public`}
                </p>
                {visibleProjects.length === 0 ? (
                  <EmptyState
                    icon={Search}
                    title="No matching projects"
                    description={
                      query.trim()
                        ? `Nothing matches “${query.trim()}” in this tab.`
                        : "No projects match this category filter yet."
                    }
                    action={
                      <Button
                        variant="outline"
                        onClick={() => {
                          setQuery("");
                          setCategoryFilter(CATEGORY_FILTER_ALL);
                        }}
                      >
                        Clear filters
                      </Button>
                    }
                  />
                ) : viewMode === "grid" ? (
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {visibleProjects.map((p) => (
                      <ProjectCard
                        key={p.id}
                        project={p}
                        rowProfile={workProfile}
                        a={{
                          ...actionsFor({
                            onPublishToggle: (proj) => void togglePublish(proj),
                            onFeatureToggle: (proj) => void toggleFeature(proj),
                            onDuplicate: (proj) => void duplicate(proj),
                            onArchiveToggle: (proj) => void toggleArchive(proj),
                            onRequestDelete: setDeleteTarget,
                          }),
                          busy: busyFor(p.id),
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {visibleProjects.map((p) => (
                      <ProjectRow
                        key={p.id}
                        project={p}
                        rowProfile={workProfile}
                        a={{
                          ...actionsFor({
                            onPublishToggle: (proj) => void togglePublish(proj),
                            onFeatureToggle: (proj) => void toggleFeature(proj),
                            onDuplicate: (proj) => void duplicate(proj),
                            onArchiveToggle: (proj) => void toggleArchive(proj),
                            onRequestDelete: setDeleteTarget,
                          }),
                          busy: busyFor(p.id),
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the project, its media links and its stats. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? "Deleting…" : "Delete project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Profession-aware creation flow — opened by the SAME "New project" action */}
      <CreateProjectFlow open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
