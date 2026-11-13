"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ImageOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/bean/EmptyState";
import { SiteRenderer, type SiteRendererProfile } from "@/components/bean/site/SiteRenderer";
import { api, ApiError } from "@/lib/client";
import { setStandaloneSite } from "@/lib/standalone-site";
import { useSeo } from "@/lib/seo";
import type { PublicProfileResponse } from "@/lib/types";
import type { SiteConfig } from "@/lib/site-config";

/**
 * SiteGiftzSiteView — the PUBLIC page of a PUBLISHED GIFTZ generated site at
 * `/site/<username>/g/<siteId>`.
 *
 * GIFTZ product separation: this page renders the GiftzSite's OWN immutable
 * publishedConfig snapshot — never the portfolio SiteDesign snapshot, and the
 * portfolio's publish state is irrelevant here. Profile, projects and
 * collections come from the standard public profile endpoint (the same
 * visibility filters the portfolio site renders through), so a PRIVATE
 * profile keeps its generated sites unreachable to visitors.
 */
export default function SiteGiftzSiteView({ username, siteId }: { username: string; siteId: string }) {
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteData, setSiteData] = useState<{ id: string; title: string; config: SiteConfig } | null>(null);
  const [profileData, setProfileData] = useState<PublicProfileResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await api<{
        site: { id: string; title: string; config: SiteConfig };
        owner: { username: string | null; name: string };
      }>(`/api/giftz/sites/${encodeURIComponent(siteId)}/public`);
      setSiteData(res.site);
      // The public profile payload carries profile, projects and collections
      // — the exact public data the portfolio site renders through.
      if (res.owner.username) {
        setProfileData(await api<PublicProfileResponse>(`/api/profiles/${encodeURIComponent(res.owner.username)}`));
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(e instanceof Error ? e.message : "Could not load this website");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Standalone website shell: platform chrome hidden while this generated
  // site resolves, and only while it actually renders.
  useEffect(() => {
    setStandaloneSite("pending");
    return () => setStandaloneSite("no");
  }, [siteId]);

  const renders = Boolean(siteData && profileData);
  useEffect(() => {
    if (loading) return;
    setStandaloneSite(renders ? "yes" : "no");
  }, [loading, renders]);

  const seoInput = useMemo(() => {
    if (loading) return null;
    if (notFound || error || !siteData) {
      return {
        title: "Website not found — BEAN Folio",
        description: "This website doesn't exist or isn't published.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    const config = siteData.config;
    const siteName = config.name || siteData.title || "A generated website";
    return {
      title: `${siteName} — made with BEAN Folio`,
      description: config.tagline || `A website generated with BEAN Folio · GIFTZ.`,
      noindex: false,
      jsonLd: null,
    };
  }, [loading, notFound, error, siteData]);
  useSeo(seoInput);

  if (loading) {
    // Standalone shell already hides chrome ("pending") — a minimal local
    // loading skeleton, never the platform feed.
    return (
      <div className="min-h-dvh animate-pulse bg-background" aria-busy="true">
        <div className="mx-auto max-w-5xl space-y-6 px-5 py-16 sm:px-8">
          <div className="h-10 w-2/3 rounded bg-muted" />
          <div className="h-4 w-1/3 rounded bg-muted" />
          <div className="h-64 w-full rounded bg-muted" />
        </div>
      </div>
    );
  }

  if (notFound || error || !siteData || !profileData) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 sm:px-6">
        <EmptyState
          icon={ImageOff}
          title={notFound ? "This website doesn't exist." : "This website isn't published right now."}
          description={
            notFound
              ? "The address may be mistyped, or the creator's profile is private."
              : error ?? "The creator has unpublished this website. Check back later."
          }
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
              <Button onClick={() => (window.location.hash = "#/")}>Explore BEAN Folio</Button>
            </div>
          }
        />
      </div>
    );
  }

  const { profile, projects, collections } = profileData;
  const siteProfile: SiteRendererProfile = {
    name: profile.name,
    username: profile.username,
    headline: profile.headline,
    location: profile.location,
    bio: profile.bio,
    availability: profile.availability ?? null,
    avatarUrl: profile.avatarUrl,
    coverUrl: profile.coverUrl,
    coverPositionY: profile.coverPositionY,
    professions: profile.professions,
    skills: profile.skills,
    websiteUrl: profile.websiteUrl,
    contactEmail: profile.contactEmail,
    stats: {
      followers: profile.stats.followers,
      following: profile.stats.following,
      projects: profile.stats.projects,
    },
  };

  return (
    <SiteRenderer
      config={siteData.config}
      profile={siteProfile}
      projects={projects}
      collections={collections}
    />
  );
}
