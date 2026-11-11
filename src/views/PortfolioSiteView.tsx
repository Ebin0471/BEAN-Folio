"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Compass, Eye, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/bean/EmptyState";
import { api } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import type { SiteResponse } from "@/lib/portfolio-schema";
import { homePage, pageBySlug } from "@/lib/portfolio-schema";
import { PortfolioRenderer } from "@/components/bean/portfolio/PortfolioRenderer";
import { useDocumentMeta } from "@/components/bean/portfolio/kit";

/**
 * Public portfolio site — #/site/<slug> (home) and #/site/<slug>/<page> (sub-pages).
 * Serves ONLY the published snapshot for the public (the API 404s otherwise; owners
 * get a draft-preview banner while editing, and can preview unpublished pages).
 * Adds client SEO: document title, meta description + Open Graph, robots (drafts
 * noindex) and truthful JSON-LD Person data.
 */
type SiteStatus = "loading" | "notfound" | "error" | "ok";
interface FetchState {
  slug: string;
  status: SiteStatus;
  data: SiteResponse | null;
  message: string;
}

export default function PortfolioSiteView({
  slug,
  bare = false,
  preferDraft = false,
  pageSlug,
}: {
  slug: string;
  bare?: boolean;
  preferDraft?: boolean;
  pageSlug?: string;
}) {
  // All setState calls happen inside async callbacks; "which slug are we showing"
  // is derived so a slug change mid-flight falls back to loading without a
  // synchronous setState in the effect body.
  const [fetch, setFetch] = useState<FetchState>({ slug, status: "loading", data: null, message: "" });
  const view = fetch.slug === slug ? fetch : ({ slug, status: "loading", data: null, message: "" } as FetchState);
  const { status, data, message } = view;

  useEffect(() => {
    let alive = true;
    api<SiteResponse>(`/api/site/${encodeURIComponent(slug)}${preferDraft ? "?draft=1" : ""}`)
      .then((res) => {
        if (!alive) return;
        setFetch({ slug, status: "ok", data: res, message: "" });
      })
      .catch((e: Error & { status?: number }) => {
        if (!alive) return;
        if (e.status === 404) setFetch({ slug, status: "notfound", data: null, message: "" });
        else setFetch({ slug, status: "error", data: null, message: e.message });
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  // Resolve the active page AFTER data arrives (derived, no sync setState).
  const site = data && status === "ok" ? data : null;
  const activePage = site ? (pageSlug ? pageBySlug(site.config, pageSlug) : homePage(site.config)) : null;
  const pageMissing = Boolean(site && pageSlug && !activePage);

  useDocumentMeta(
    site && activePage
      ? activePage.seoTitle || (activePage.isHome ? `${activePage.hero.name || site.owner.name} — Portfolio` : `${activePage.name} — ${site.owner.name}`)
      : "Portfolio",
    site && activePage
      ? activePage.seoDescription || activePage.hero.intro || site.owner.headline || `Portfolio of ${site.owner.name} on BEAN Folio`
      : undefined,
    site ? !site.isPublished : false
  );

  // Open Graph tags for link previews (home page identity).
  useEffect(() => {
    if (!site || !activePage) return;
    const set = (property: string, content: string) => {
      let el = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute("property", property);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
    };
    const title = document.title;
    const desc = activePage.seoDescription || activePage.hero.intro || site.owner.headline || `Portfolio of ${site.owner.name}`;
    set("og:title", title);
    set("og:description", desc);
    set("og:type", "profile");
    set("og:url", window.location.href);
    if (site.owner.avatarUrl) set("og:image", `${window.location.origin}${site.owner.avatarUrl}`);
    return () => {
      ["og:title", "og:description", "og:type", "og:url", "og:image"].forEach((p) =>
        document.head.querySelector(`meta[property="${p}"]`)?.remove()
      );
    };
  }, [site, activePage]);

  // Truthful structured data — only fields the owner actually published (home page only).
  useEffect(() => {
    if (!site || !site.isPublished) return;
    if (!activePage?.isHome) return;
    const hero = activePage.hero;
    const sameAs = site.pages
      .filter((p) => p.isHome)
      .flatMap(() => {
        const home = homePage(site.config);
        return home.sections
          .filter((s) => s.type === "contact")
          .flatMap((s) => ((s.data?.links as { url: string }[] | undefined) ?? []).map((l) => l.url));
      })
      .filter(Boolean);
    const ld = {
      "@context": "https://schema.org",
      "@type": "ProfilePage",
      mainEntity: {
        "@type": "Person",
        name: hero.name || site.owner.name,
        ...(hero.title ? { jobTitle: hero.title } : {}),
        ...(hero.intro ? { description: hero.intro } : {}),
        ...(site.owner.avatarUrl ? { image: site.owner.avatarUrl } : {}),
        ...(sameAs.length ? { sameAs } : {}),
        url: typeof window !== "undefined" ? window.location.href : undefined,
      },
    };
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.id = "pf-jsonld";
    script.text = JSON.stringify(ld);
    document.head.appendChild(script);
    return () => {
      document.getElementById("pf-jsonld")?.remove();
    };
  }, [site, activePage]);

  if (status === "loading") {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading portfolio" />
      </div>
    );
  }

  if (status === "notfound") {
    return (
      <div className="mx-auto max-w-xl px-4 py-20">
        <EmptyState
          icon={Lock}
          title="Portfolio not available"
          description="This portfolio doesn't exist or isn't published. If it's yours, publish it from the Portfolio Studio."
          action={<Button onClick={() => navigate("/")}>Back to Discover</Button>}
        />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="mx-auto max-w-xl px-4 py-20">
        <EmptyState
          icon={Compass}
          title="Something went wrong"
          description={message || "The portfolio could not be loaded. Check your connection and try again."}
          action={<Button variant="outline" onClick={() => window.location.reload()}>Retry</Button>}
        />
      </div>
    );
  }

  // A 404 page for nonexistent (or publicly unlisted) sub-page routes.
  if (!site) return null;
  if (pageMissing) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20">
        <EmptyState
          icon={Compass}
          title="Page not found"
          description={`This portfolio has no page at “/${pageSlug}”. It may have been renamed, unpublished, or never existed.`}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => navigate(`#/site/${site.slug}`)}>
                Visit home page
              </Button>
              {site.isSelf && (
                <Button onClick={() => navigate("/studio/portfolio")}>Open Studio</Button>
              )}
            </div>
          }
        />
      </div>
    );
  }
  if (!activePage) return null;

  return (
    <div>
      {!site.isPublished && site.isSelf && !bare && (
        <div className="border-b bg-gold-soft px-4 py-2.5 text-center text-sm text-primary">
          <span className="inline-flex items-center gap-2">
            <Eye className="size-4" aria-hidden />
            {preferDraft ? "Draft preview — this is what your site looks like right now. Publish to make it live." : "Draft preview — only you can see this. Publish it in the Studio to go live."}
          </span>
        </div>
      )}
      {site.isPublished && site.isSelf && (
        <div className="border-b border-border/60 bg-card px-4 py-2 text-center text-xs text-muted-foreground">
          You are viewing your live portfolio.{" "}
          <Link href="#/studio/portfolio" className="underline hover:text-foreground">
            Edit in Studio
          </Link>
        </div>
      )}
      <PortfolioRenderer
        config={site.config}
        page={activePage}
        pages={site.pages}
        owner={site.owner}
        projects={site.projects}
        slug={site.slug}
        interactive
        pageBase={`#/site/${site.slug}`}
      />
    </div>
  );
}
