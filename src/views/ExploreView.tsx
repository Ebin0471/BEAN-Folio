"use client";

import { useEffect, useMemo, useState } from "react";
import { CloudOff, RefreshCw, Search, SearchX } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { ProjectCard, PROJECT_CATEGORIES, categoryLabel } from "@/components/bean/ProjectCard";
import { EmptyState } from "@/components/bean/EmptyState";
import { CardsSkeleton } from "@/components/bean/Spinner";
import { api } from "@/lib/client";
import type { Paginated, ProfessionDTO, ProjectCardDTO } from "@/lib/types";

type Sort = "recent" | "saved";

interface FeedState<T> {
  items: T[];
  nextCursor: string | null;
  loadingMore: boolean;
  error: string | null;
  /** Filter-key of the last completed fetch. Loading is derived: loadedKey !== currentKey. */
  loadedKey: string;
}

const initialFeed = <T,>(): FeedState<T> => ({
  items: [],
  nextCursor: null,
  loadingMore: false,
  error: null,
  loadedKey: "",
});

function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export default function ExploreView() {
  const [q, setQ] = useState("");
  const [skill, setSkill] = useState("");
  const [category, setCategory] = useState("all"); // "all" → omit param
  const [sort, setSort] = useState<Sort>("recent");

  const dq = useDebounced(q, 300);
  const dSkill = useDebounced(skill, 300);

  const [projects, setProjects] = useState<FeedState<ProjectCardDTO>>(initialFeed);

  // Live taxonomy (self-seeds on first GET); static map is the offline fallback.
  const [professionOptions, setProfessionOptions] = useState<{ slug: string; label: string }[]>(() =>
    Object.entries(PROJECT_CATEGORIES).map(([slug, label]) => ({ slug, label }))
  );
  useEffect(() => {
    let alive = true;
    api<{ professions: ProfessionDTO[] }>("/api/professions")
      .then((r) => alive && setProfessionOptions(r.professions.map((p) => ({ slug: p.slug, label: p.label }))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const projectsKey = useMemo(
    () => [dq.trim(), dSkill.trim(), category === "all" ? "" : category, sort].join("|"),
    [dq, dSkill, category, sort]
  );

  // ------------------------------------------------------ projects fetch
  // Loading is derived (loadedKey !== projectsKey): no synchronous setState here.
  const projectsLoading = projects.loadedKey !== projectsKey;
  useEffect(() => {
    if (projects.loadedKey === projectsKey) return;
    let alive = true;
    const params = new URLSearchParams();
    if (dq.trim()) params.set("q", dq.trim());
    if (category !== "all") params.set("category", category);
    if (dSkill.trim()) params.set("skill", dSkill.trim());
    if (sort !== "recent") params.set("sort", sort);
    api<Paginated<ProjectCardDTO>>(`/api/search/projects?${params.toString()}`)
      .then((r) => {
        if (!alive) return;
        setProjects({ items: r.items, nextCursor: r.nextCursor, loadingMore: false, error: null, loadedKey: projectsKey });
      })
      .catch((err) => {
        if (!alive) return;
        setProjects((s) => ({
          ...s,
          loadingMore: false,
          error: err instanceof Error ? err.message : "Search failed.",
          loadedKey: projectsKey,
        }));
      });
    return () => {
      alive = false;
    };
  }, [projectsKey, projects.loadedKey, dq, dSkill, category, sort]);

  // ------------------------------------------------------------ load more
  async function loadMoreProjects() {
    const cursor = projects.nextCursor;
    if (!cursor || projectsLoading || projects.loadingMore) return;
    const key = projectsKey;
    setProjects((s) => ({ ...s, loadingMore: true }));
    try {
      const params = new URLSearchParams();
      if (dq.trim()) params.set("q", dq.trim());
      if (category !== "all") params.set("category", category);
      if (dSkill.trim()) params.set("skill", dSkill.trim());
      if (sort !== "recent") params.set("sort", sort);
      params.set("cursor", cursor);
      const r = await api<Paginated<ProjectCardDTO>>(`/api/search/projects?${params.toString()}`);
      setProjects((s) =>
        s.loadedKey === key
          ? { ...s, items: [...s.items, ...r.items], nextCursor: r.nextCursor, loadingMore: false }
          : s // filters changed mid-flight — drop the stale page
      );
    } catch (err) {
      setProjects((s) => (s.loadedKey === key ? { ...s, loadingMore: false } : s));
      toast.error(err instanceof Error ? err.message : "Could not load more projects.");
    }
  }

  function clearFilters() {
    setQ("");
    setSkill("");
    setCategory("all");
    setSort("recent");
  }

  function retryProjects() {
    setProjects((s) => ({ ...s, loadedKey: "" }));
  }

  const trimmedQ = q.trim();
  const filterSelectClass = "h-11 w-full sm:w-48";

  return (
    <section className="py-8 md:py-10">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <header className="mb-6">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Explore</h1>
          <p className="mt-1 text-sm text-muted-foreground">Search published work across every craft on BEAN Folio.</p>
        </header>

        {/* shared search bar */}
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects, skills…"
            aria-label="Search projects"
            className="h-11 pl-9"
          />
        </div>

        <Tabs defaultValue="projects" className="mt-5">
          <TabsList>
            <TabsTrigger value="projects">Projects</TabsTrigger>
          </TabsList>

          {/* ------------------------------------------------- projects */}
          <TabsContent value="projects" className="mt-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="explore-category" className="text-xs text-muted-foreground">
                  Category
                </Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger id="explore-category" size="sm" className={filterSelectClass}>
                    <SelectValue placeholder="All categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {professionOptions.map((p) => (
                      <SelectItem key={p.slug} value={p.slug}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="explore-skill-projects" className="text-xs text-muted-foreground">
                  Skill
                </Label>
                <Input
                  id="explore-skill-projects"
                  value={skill}
                  onChange={(e) => setSkill(e.target.value)}
                  placeholder="e.g. Blender, color grading"
                  className={filterSelectClass}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="explore-sort" className="text-xs text-muted-foreground">
                  Sort
                </Label>
                <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                  <SelectTrigger id="explore-sort" size="sm" className={filterSelectClass}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recent">Most recent</SelectItem>
                    <SelectItem value="saved">Most saved</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-5" aria-busy={projectsLoading || projects.loadingMore}>
              {projectsLoading ? (
                <CardsSkeleton count={8} />
              ) : projects.error ? (
                <EmptyState
                  icon={CloudOff}
                  title="Search is unavailable"
                  description={projects.error}
                  action={
                    <Button variant="outline" onClick={retryProjects}>
                      <RefreshCw className="size-4" aria-hidden /> Try again
                    </Button>
                  }
                />
              ) : projects.items.length === 0 ? (
                <EmptyState
                  icon={SearchX}
                  title={trimmedQ ? `No results for '${trimmedQ}'` : "No projects match these filters"}
                  description="Try different keywords, or widen the category and skill filters."
                  action={
                    <Button variant="outline" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <>
                  <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
                    Showing {projects.items.length} {projects.items.length === 1 ? "project" : "projects"}
                  </p>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {projects.items.map((p) => (
                      <ProjectCard key={p.id} project={p} />
                    ))}
                  </div>
                  {projects.nextCursor && (
                    <div className="mt-8 flex justify-center">
                      <Button variant="outline" onClick={() => void loadMoreProjects()} disabled={projects.loadingMore} className="h-11 min-w-44">
                        {projects.loadingMore ? "Loading…" : "Load more"}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <p className="mt-10 text-xs text-muted-foreground">
          Categories follow the BEAN Folio craft list — from {categoryLabel("film-video")} to {categoryLabel("writing")}.
        </p>
      </div>
    </section>
  );
}
