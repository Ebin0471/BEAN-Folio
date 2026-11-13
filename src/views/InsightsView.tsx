"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3, Bookmark, Eye, Info, ServerCrash, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader, StatCard } from "@/components/bean/SectionHeader";

import { api, ApiError, formatCompact } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import type { InsightsOverview, InsightsPosts, InsightsProjects, ProjectCardDTO } from "@/lib/types";

const GOLD = "#e8bc51";

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/** "2026-02-13" → "02-13" (MM-DD) */
function dayLabel(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(5) : day;
}

// ------------------------------------------------------------------ chart

function ViewsChart({ series }: { series: { day: string; views: number }[] }) {
  const data = useMemo(
    () => series.map((p) => ({ label: dayLabel(p.day), views: p.views })),
    [series]
  );

  return (
    <div className="h-[260px] w-full" role="img" aria-label="Project views over the last 14 days">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 12, left: -14, bottom: 0 }}>
          <defs>
            <linearGradient id="bean-views-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={GOLD} stopOpacity={0.32} />
              <stop offset="100%" stopColor={GOLD} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(247,245,239,0.08)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "#A5A6A8", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            minTickGap={18}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: "#A5A6A8", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={40}
          />
          <ChartTooltip
            cursor={{ stroke: "rgba(232,188,81,0.35)", strokeWidth: 1 }}
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--foreground)",
            }}
            itemStyle={{ color: GOLD }}
            labelStyle={{ color: "var(--foreground)", marginBottom: 2 }}
            formatter={(value) => [`${value} view${Number(value) === 1 ? "" : "s"}`, "Views"]}
          />
          <Area
            type="monotone"
            dataKey="views"
            name="Views"
            stroke={GOLD}
            strokeWidth={2}
            fill="url(#bean-views-fill)"
            dot={false}
            activeDot={{ r: 3.5, fill: GOLD, stroke: "var(--background)" }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ------------------------------------------------------------------ rows

function TopProjectsList({ items }: { items: InsightsOverview["topProjects"] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No published projects yet — publishing is the first step to collecting views.</p>;
  }
  return (
    <ol className="divide-y divide-border/50">
      {items.map((p, i) => (
        <li key={p.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
          <span className="w-5 shrink-0 font-display text-sm text-muted-foreground/70">{i + 1}</span>
          <a
            href={`#/p/${p.id}`}
            className="min-w-0 flex-1 truncate text-sm font-medium text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
          >
            {p.title}
          </a>
          <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1" title="Views (estimated)">
              <Eye className="size-3.5" aria-hidden /> {formatCompact(p.views)}
            </span>
            <span className="inline-flex items-center gap-1" title="Saves">
              <Bookmark className="size-3.5" aria-hidden /> {formatCompact(p.saves)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function AnalyticsRow({
  title,
  projectId,
  visibility,
  views,
  saves,
  views14d,
}: {
  title: string;
  projectId: string;
  visibility: string | undefined;
  views: number;
  saves: number;
  views14d: number;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 border-b border-border/40 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,2fr)_90px_64px_64px_80px]">
      <a
        href={`#/p/${projectId}`}
        className="col-span-1 min-w-0 truncate text-sm font-medium text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
      >
        {title}
      </a>
      <div className="col-start-1 sm:col-start-2">
        {visibility ? <VisibilityBadge visibility={visibility} /> : <span className="text-xs text-muted-foreground">—</span>}
      </div>
      <span className="col-span-1 inline-flex items-center gap-1 text-xs text-muted-foreground sm:col-span-1 sm:col-start-3" title="Total views (estimated)">
        <Eye className="size-3.5" aria-hidden /> {formatCompact(views)}
      </span>
      <span className="hidden items-center justify-end gap-1 text-xs text-muted-foreground sm:flex sm:col-start-4" title="Saves">
        <Bookmark className="size-3.5" aria-hidden /> {formatCompact(saves)}
      </span>
      <span className="hidden justify-end text-xs text-muted-foreground sm:flex sm:col-start-5" title="Views in the last 14 days">
        {formatCompact(views14d)} <span className="ml-1 opacity-70">14d</span>
      </span>
    </div>
  );
}

function VisibilityBadge({ visibility }: { visibility: string }) {
  if (visibility === "PUBLIC") {
    return <Badge variant="outline" className="rounded-full text-[11px] font-normal text-muted-foreground">Public</Badge>;
  }
  if (visibility === "UNLISTED") {
    return <Badge variant="secondary" className="rounded-full text-[11px] font-normal">Unlisted</Badge>;
  }
  if (visibility === "PRIVATE") {
    return <Badge variant="secondary" className="rounded-full text-[11px] font-normal">Private</Badge>;
  }
  return <Badge variant="outline" className="rounded-full text-[11px] font-normal text-muted-foreground">{visibility}</Badge>;
}

// ------------------------------------------------------------------ view

export default function InsightsView() {
  const [overview, setOverview] = useState<InsightsOverview | null>(null);
  const [analytics, setAnalytics] = useState<InsightsProjects["projects"] | null>(null);
  const [ownProjects, setOwnProjects] = useState<ProjectCardDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, an, own] = await Promise.all([
        api<InsightsOverview>("/api/me/insights/overview"),
        api<InsightsProjects>("/api/me/insights/projects"),
        api<{ projects: ProjectCardDTO[] }>("/api/projects"),
      ]);
      setOverview(ov);
      setAnalytics(an.projects);
      setOwnProjects(own.projects);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const visibilityById = useMemo(() => {
    const map: Record<string, string> = {};
    (ownProjects ?? []).forEach((p) => {
      map[p.id] = p.visibility;
    });
    return map;
  }, [ownProjects]);

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Skeleton className="h-10 w-56" />
        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="mt-6 h-80 w-full rounded-xl" />
        <Skeleton className="mt-6 h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <EmptyState
          icon={ServerCrash}
          title="Couldn't load your insights"
          description={error ?? "Insights are unavailable right now."}
          action={<Button onClick={() => void loadAll()}>Try again</Button>}
        />
      </div>
    );
  }

  const noProjects = (ownProjects ?? []).length === 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <SectionHeader
        title="Insights"
        description="How people are finding and engaging with your work."
        action={
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="gap-1.5 rounded-full font-normal">
                  <Info className="size-3.5" aria-hidden />
                  Estimated data
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-64">
                Views are deduplicated per viewer per day. Counts are estimates.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        }
        className="mb-6"
      />

      {noProjects ? (
        <EmptyState
          icon={BarChart3}
          title="Publish a project to start collecting insights"
          description="Insights appear once your work is live — views, saves and follower activity are counted here, honestly and without inflation."
          action={<Button onClick={() => navigate("/studio/new")}>Create a project</Button>}
        />
      ) : (
        <div className="space-y-6">
          {/* Totals */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Profile views" value={formatCompact(overview.totals.profileViews)} icon={Users} hint="Estimated" />
            <StatCard label="Project views" value={formatCompact(overview.totals.projectViews)} icon={Eye} hint="Estimated" />
            <StatCard label="Saves" value={formatCompact(overview.totals.saves)} icon={Bookmark} hint="Estimated" />
            <StatCard label="Followers" value={formatCompact(overview.totals.followers)} icon={Users} hint="Live count" />
          </div>

          {/* 14-day series */}
          <Card>
            <CardContent className="p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-semibold text-foreground">Views — last 14 days</h2>
                <Badge variant="outline" className="rounded-full text-[11px] font-normal text-muted-foreground">
                  Deduplicated per viewer per day
                </Badge>
              </div>
              <ViewsChart series={overview.series14d} />
            </CardContent>
          </Card>

          {/* Top projects */}
          <Card>
            <CardContent className="p-6">
              <h2 className="font-display text-lg font-semibold text-foreground">Top projects</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Your five most-viewed published projects.</p>
              <div className="mt-4">
                <TopProjectsList items={overview.topProjects} />
              </div>
            </CardContent>
          </Card>

          {/* Project analytics */}
          <Card>
            <CardContent className="p-6">
              <h2 className="font-display text-lg font-semibold text-foreground">Project analytics</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Per-project totals and the last 14 days.</p>
              <div className="mt-4 max-h-96 overflow-y-auto pr-1">
                <div className="hidden border-b border-border/60 pb-2 sm:grid sm:grid-cols-[minmax(0,2fr)_90px_64px_64px_80px]">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Project</span>
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Visibility</span>
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Views</span>
                  <span className="text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Saves</span>
                  <span className="text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">14d</span>
                </div>
                {(analytics ?? []).length === 0 ? (
                  <p className="py-6 text-sm text-muted-foreground">No published projects to analyze yet.</p>
                ) : (
                  (analytics ?? []).map((p) => (
                    <AnalyticsRow
                      key={p.id}
                      title={p.title}
                      projectId={p.id}
                      visibility={visibilityById[p.id]}
                      views={p.views}
                      saves={p.saves}
                      views14d={p.views14d}
                    />
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Post analytics (social feed — private to the owner) */}
          <PostsInsightsCard />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ post analytics

/**
 * Private analytics for the signed-in creator's social posts — impressions
 * (feed placements), actual views, engagement events, video plays, follower
 * growth and top posts. Every number comes from recorded events; the
 * engagement-rate formula is fixed server-side ((likes+comments+shares+saves)
 * / impressions) and documented in the UI.
 */
function PostsInsightsCard() {
  const [range, setRange] = useState<"7" | "28" | "90">("28");
  const [data, setData] = useState<InsightsPosts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<InsightsPosts>(`/api/me/insights/posts?range=${range}`)
      .then((r) => setData(r))
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-semibold text-foreground">Post analytics</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Your social posts — impressions (feed placements), actual views and engagement.
            </p>
          </div>
          <div className="flex gap-1" role="group" aria-label="Date range">
            {(["7", "28", "90"] as const).map((r) => (
              <Button
                key={r}
                variant={range === r ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => setRange(r)}
                aria-pressed={range === r}
              >
                {r}d
              </Button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
        ) : error ? (
          <p className="py-4 text-sm text-muted-foreground">{error}</p>
        ) : data ? (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="Impressions" value={formatCompact(data.totals.impressions)} icon={Eye} hint="Feed placements" />
              <StatCard label="Actual views" value={formatCompact(data.totals.views)} icon={Users} hint="Deduped per viewer per day" />
              <StatCard
                label="Engagement rate"
                value={`${Math.round(data.totals.engagementRate * 1000) / 10}%`}
                icon={BarChart3}
                hint="(likes + comments + shares + saves) ÷ impressions"
              />
              <StatCard label="Followers gained" value={formatCompact(data.followerGrowth.gained)} icon={Users} hint="In range" />
            </div>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="Likes" value={formatCompact(data.totals.likes)} icon={BarChart3} />
              <StatCard label="Comments" value={formatCompact(data.totals.comments)} icon={BarChart3} />
              <StatCard label="Shares" value={formatCompact(data.totals.shares)} icon={BarChart3} />
              <StatCard label="Video plays" value={formatCompact(data.totals.videoPlays)} icon={Eye} />
            </div>

            {data.topPosts.length > 0 ? (
              <div>
                <h3 className="text-sm font-semibold text-foreground">Top posts by engagement</h3>
                <ul className="mt-2 space-y-2">
                  {data.topPosts.map((p) => (
                    <li key={p.id}>
                      <a
                        href={`#/post/${p.id}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2 text-sm transition-colors hover:border-primary/40"
                      >
                        <span className="min-w-0 truncate text-foreground/90">{p.body || `(${p.mediaKind.toLowerCase()} post)`}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{p.engagement} engagements</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No post engagement in this range yet — share a post to start collecting real metrics.</p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
