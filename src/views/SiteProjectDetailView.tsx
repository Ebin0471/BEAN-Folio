"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ImageOff } from "lucide-react";

import { api, ApiError } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { setStandaloneSite } from "@/lib/standalone-site";
import { useSeo } from "@/lib/seo";
import { publicSiteHashUrl, publicSiteProjectPath, seoOrigin } from "@/lib/site-url";
import { deriveTheme, themeFontStacks } from "@/lib/site-config";
import type { ResolvedTheme } from "@/lib/site-config";
import { useSession } from "@/lib/session";
import type { ProjectDetailResponse, PublicProfileResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/bean/EmptyState";
import { SiteProjectPage, type SiteRendererProfile } from "@/components/bean/site/SiteRenderer";
import { BANNER_ASPECT_CLASS } from "@/lib/banner";

type Phase = "loading" | "ready" | "site-missing" | "site-unpublished" | "project-missing" | "error";

function SiteProjectSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading project" className="mx-auto max-w-7xl px-4 pt-8 sm:px-6">
      <Skeleton className="h-8 w-64 rounded-lg" />
      <Skeleton className={cn("mt-6 w-full rounded-xl", BANNER_ASPECT_CLASS)} />
      <div className="mt-6 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full max-w-2xl rounded" />
        ))}
      </div>
    </div>
  );
}

/**
 * Honest 404 INSIDE the website's own design system: a standalone website
 * shows its own not-found page for a missing/unavailable project — never the
 * BEAN Folio platform shell, never a redirect. Purely presentational.
 */
function SiteProjectNotFound({ config, backHref }: { config: NonNullable<PublicProfileResponse["site"]["config"]>; backHref: string }) {
  const theme: ResolvedTheme = useMemo(() => deriveTheme(config.theme), [config.theme]);
  const stacks = themeFontStacks(theme);
  return (
    <div
      className="bean-site min-h-full w-full"
      style={{
        background: theme.gradient
          ? `linear-gradient(${theme.gradient.angle}deg, ${theme.gradient.from}, ${theme.gradient.to})`
          : theme.background,
        color: theme.foreground,
        fontFamily: stacks.body,
      }}
    >
      <div className="mx-auto max-w-xl px-5 py-24 text-center sm:px-8">
        <p aria-hidden="true" className="text-6xl font-bold opacity-40" style={{ fontFamily: stacks.heading, color: theme.accent }}>
          404
        </p>
        <h1 className="mt-4 text-xl font-semibold" style={{ fontFamily: stacks.heading }}>
          This project isn't available.
        </h1>
        <p className="mt-2 text-sm opacity-75" style={{ color: theme.muted }}>
          It may have been unpublished, made private, or the address is mistyped.
        </p>
        <a
          href={backHref}
          className="mt-8 inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
          style={{ color: theme.accent }}
        >
          <ArrowLeft className="size-4" aria-hidden /> Back to {config.name}
        </a>
      </div>
    </div>
  );
}

/**
 * SiteProjectDetailView — the standalone website's OWN project detail page at
 * `/site/<username>/projects/<projectId>`.
 *
 * The visitor stays INSIDE the creator's website: the page renders with the
 * published site's design system (SiteProjectPage) and the platform chrome is
 * suppressed — never a redirect into the BEAN Folio platform's `/p/<id>`
 * experience, which remains a fully independent route.
 *
 * Data & rules:
 *  - Site + owner: GET /api/profiles/:username (the SAME visibility ladder the
 *    website homepage uses — PRIVATE/deleted creators resolve to not-found).
 *  - Project: GET /api/projects/:id — the server already enforces the project
 *    visibility ladder (PRIVATE → 404, drafts → 404, private profile → 404)
 *    and returns the full published project. No project data is invented here.
 *  - Ownership cross-check: the URL's username must match the project's owner
 *    — a project from a DIFFERENT creator never renders under another site.
 */
export default function SiteProjectDetailView({ username, projectId }: { username: string; projectId: string }) {
  const { user } = useSession();

  const [siteData, setSiteData] = useState<PublicProfileResponse | null>(null);
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setPhase("loading");
    setErrorMessage(null);
    try {
      const results = await Promise.allSettled([
        api<PublicProfileResponse>(`/api/profiles/${encodeURIComponent(username)}`),
        api<ProjectDetailResponse>(`/api/projects/${encodeURIComponent(projectId)}`),
      ]);
      const siteResult = results[0];
      const projectResult = results[1];

      // The site's own state gates everything (same ladder as the homepage):
      // unknown/private/deleted creator → honest not-found; unpublished site →
      // honest not-published. Both restore the platform shell so the visitor
      // can navigate away.
      const siteErr = siteResult.status === "rejected" ? siteResult.reason : null;
      if (siteErr && !(siteErr instanceof ApiError && siteErr.status === 404)) {
        setErrorMessage(siteErr instanceof Error ? siteErr.message : "Could not load this website");
        setPhase("error");
        return;
      }
      const site = siteResult.status === "fulfilled" ? siteResult.value : null;
      if (!site) {
        setPhase("site-missing");
        return;
      }
      const sitePublished = Boolean(site.site.status === "PUBLISHED" && site.site.config);
      if (!sitePublished) {
        setSiteData(site);
        setPhase("site-unpublished");
        return;
      }
      setSiteData(site);

      const projectErr = projectResult.status === "rejected" ? projectResult.reason : null;
      if (projectErr && !(projectErr instanceof ApiError && projectErr.status === 404)) {
        setErrorMessage(projectErr instanceof Error ? projectErr.message : "Could not load this project");
        setPhase("error");
        return;
      }
      const project = projectResult.status === "fulfilled" ? projectResult.value : null;
      if (!project) {
        setPhase("project-missing");
        return;
      }
      // Ownership cross-check: the project must belong to the site's creator.
      const ownerUsername = (project.project.owner?.username ?? "").trim().toLowerCase();
      if (ownerUsername !== username.trim().toLowerCase()) {
        setPhase("project-missing");
        return;
      }
      setDetail(project);
      setPhase("ready");
    } finally {
      setLoading(false);
    }
  }, [username, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ------------------------------------------------- standalone website shell
  // Same contract as PublishedSiteView: chrome hidden while the route resolves
  // and while the website is live (including its own themed 404 for a missing
  // project); restored for missing/unpublished/error site states.
  useEffect(() => {
    setStandaloneSite("pending");
    return () => setStandaloneSite("no");
  }, [username, projectId]);

  useEffect(() => {
    if (loading) return; // "pending" stays until the route resolves
    setStandaloneSite(phase === "ready" || phase === "project-missing" ? "yes" : "no");
  }, [loading, phase]);

  // ------------------------------------------------------------- SEO
  // The PROJECT page's own metadata, canonicalized to the website's own
  // project address (/site/<username>/projects/<id> — never /p/<id>).
  const backHref = useMemo(() => publicSiteHashUrl(username) ?? "#/", [username]);
  const config = siteData?.site.config ?? null;

  const seoInput = useMemo(() => {
    if (loading) return null; // shell default stays in place while loading
    if (phase === "error") {
      return {
        title: "Project unavailable — BEAN Folio",
        description: "The project could not be loaded.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    if (phase === "site-missing") {
      return {
        title: "Website not found — BEAN Folio",
        description: "This website doesn't exist or isn't published.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    if (phase === "site-unpublished") {
      return {
        title: "Website not published — BEAN Folio",
        description: "This website isn't published right now.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    if (phase === "project-missing" || !detail || !config || !siteData) {
      return {
        title: "Project not found — BEAN Folio",
        description: "This project doesn't exist or isn't public.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    const siteName = config.name || `${siteData.profile.name}'s website`;
    const project = detail.project;
    const description = (project.summary || project.description || `A project by ${siteData.profile.name}.`).slice(0, 300);
    const origin = seoOrigin();
    const jsonLd: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      name: project.title,
      ...(project.summary ? { abstract: project.summary } : {}),
      ...(project.description ? { description: project.description } : {}),
      ...(project.publishedAt ? { datePublished: project.publishedAt } : {}),
      author: {
        "@type": "Person",
        name: siteData.profile.name,
        ...(siteData.profile.username ? { alternateName: `@${siteData.profile.username}` } : {}),
        ...(siteData.profile.headline ? { jobTitle: siteData.profile.headline } : {}),
      },
      ...(origin && project.coverUrl ? { image: `${origin}${project.coverUrl}` } : {}),
    };
    return {
      title: `${project.title} — ${siteName}`,
      description,
      path: publicSiteProjectPath(username, projectId) ?? undefined,
      type: "article" as const,
      image: project.coverUrl,
      jsonLd,
    };
  }, [detail, phase, loading, config, siteData, username, projectId]);
  useSeo(seoInput);

  // ------------------------------------------------------------ render guards

  if (loading) {
    // Standalone shell already hides chrome ("pending") — render the site's
    // own loading skeleton, never the platform feed.
    return <SiteProjectSkeleton />;
  }

  const sitePublished = Boolean(siteData?.site.status === "PUBLISHED" && siteData?.site.config);

  if (phase === "error") {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 sm:px-6">
        <EmptyState
          icon={ImageOff}
          title="This project couldn't load."
          description={errorMessage ?? "A connection problem interrupted the page. Try again."}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  if (phase === "site-missing" || !siteData || !sitePublished || !config) {
    // Honest not-available state (site missing or unpublished). Standalone is
    // "no" here, so the platform shell (header/footer) is back and the visitor
    // can navigate away — identical copy and behavior to the website homepage.
    return (
      <div className="mx-auto max-w-xl px-4 py-20 sm:px-6">
        <EmptyState
          icon={ImageOff}
          title={phase === "site-missing" ? "This website doesn't exist." : "This website isn't published right now."}
          description={
            phase === "site-missing"
              ? "The address may be mistyped, or the creator's profile is private."
              : "The creator has unpublished this website. Check back later."
          }
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
              <Button onClick={() => navigate("/")}>Explore BEAN Folio</Button>
            </div>
          }
        />
      </div>
    );
  }

  if (phase === "project-missing" || !detail) {
    // The WEBSITE is live but the project isn't — a proper 404 rendered in the
    // site's own design system, with the site's own navigation back. Chrome
    // stays suppressed: the visitor is still on the creator's website.
    return <SiteProjectNotFound config={config} backHref={backHref} />;
  }

  // Ready — the website-native project page.
  const siteProfile: SiteRendererProfile = {
    name: siteData.profile.name,
    username: siteData.profile.username,
    headline: siteData.profile.headline,
    location: siteData.profile.location,
    bio: siteData.profile.bio,
    availability: siteData.profile.availability ?? null,
    avatarUrl: siteData.profile.avatarUrl,
    coverUrl: siteData.profile.coverUrl,
    coverPositionY: siteData.profile.coverPositionY,
    professions: siteData.profile.professions,
    skills: siteData.profile.skills,
    websiteUrl: siteData.profile.websiteUrl,
    contactEmail: siteData.profile.contactEmail,
    stats: {
      followers: siteData.profile.stats.followers,
      following: siteData.profile.stats.following,
      projects: siteData.profile.stats.projects,
    },
  };

  return (
    <SiteProjectPage
      config={config}
      profile={siteProfile}
      project={detail.project}
      backHref={backHref}
      watermark={siteData.site.watermark}
    />
  );
}
