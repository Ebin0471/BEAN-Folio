"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { setStandaloneSite } from "@/lib/standalone-site";
import PortfolioSiteView from "@/views/PortfolioSiteView";
import PortfolioCaseStudyView from "@/views/PortfolioCaseStudyView";
import PublishedSiteView from "@/views/PublishedSiteView";

/**
 * PortfolioFirstSiteView — the /site/<slug> route discriminator (M0.5 Stage F).
 *
 * Two INDEPENDENT website products have historically shared the /site/<x>
 * address family:
 *   1. the Portfolio Studio's published portfolio site (Portfolio model,
 *      PortfolioSiteView — reconnected in M0.5), and
 *   2. the Website Studio's published custom website (SiteDesign model,
 *      PublishedSiteView — live before M0.5).
 * A user's portfolio slug DEFAULTS to their username, so both artifacts can
 * plausibly claim the same address. The owner-approved reconnection rule is:
 *
 *   If a portfolio site exists AT THIS ADDRESS (and the viewer may see it),
 *   it IS the address; otherwise the route behaves EXACTLY as before M0.5
 *   (the Website Studio site, or the platform not-found page for unknown
 *   sub-paths).
 *
 * At the M0.5 baseline zero Portfolio rows exist, so this discriminator is a
 * zero-behavior-change wiring fix for every existing user; it only starts
 * differing when an owner actually publishes a portfolio at that address.
 * The probe is a GET /api/site/<slug> — the API 404s BEFORE any insights
 * write, so a fallback probe never pollutes the owner's analytics.
 *
 * Chrome: while resolving, standalone state is "pending" (chrome hidden —
 * same pattern PublishedSiteView uses); on a portfolio hit it stays "yes"
 * (the visitor sees ONLY the creator's site); on a website fallback the
 * PublishedSiteView owns the store from there; on an explicit not-found
 * fallback the platform shell is restored ("no").
 */
export default function PortfolioFirstSiteView({
  slug,
  pageSlug,
  fallback,
}: {
  slug: string;
  pageSlug?: string;
  /** What to render when no portfolio site answers at this address. */
  fallback: "website" | "notfound";
}) {
  // The decision is stored WITH the slug/pageSlug that produced it; a route
  // change derives the loading state without a synchronous setState in the
  // effect body (same pattern as PortfolioSiteView).
  type Decision = { kind: "loading" } | { kind: "portfolio" } | { kind: "website" } | { kind: "notfound" };
  const [resolved, setResolved] = useState<{ slug: string; pageSlug: string | undefined; decision: Decision }>({
    slug,
    pageSlug,
    decision: { kind: "loading" },
  });
  const decision: Decision =
    resolved.slug === slug && resolved.pageSlug === pageSlug ? resolved.decision : { kind: "loading" };

  useEffect(() => {
    let alive = true;
    setStandaloneSite("pending");
    api<unknown>(`/api/site/${encodeURIComponent(slug)}${pageSlug ? `?page=${encodeURIComponent(pageSlug)}` : ""}`)
      .then(() => {
        if (!alive) return;
        setResolved({ slug, pageSlug, decision: { kind: "portfolio" } });
        setStandaloneSite("yes");
      })
      .catch(() => {
        if (!alive) return;
        // 404 (no portfolio here for this viewer) or a network error — both
        // fall back to the pre-M0.5 behavior for this address.
        if (fallback === "website") {
          setResolved({ slug, pageSlug, decision: { kind: "website" } }); // PublishedSiteView owns the store now
        } else {
          setResolved({ slug, pageSlug, decision: { kind: "notfound" } });
          setStandaloneSite("no");
        }
      });
    return () => {
      alive = false;
    };
  }, [slug, pageSlug, fallback]);

  if (decision.kind === "loading") return null;
  if (decision.kind === "portfolio") {
    return <PortfolioSiteView slug={slug} pageSlug={pageSlug} />;
  }
  if (decision.kind === "website") {
    return <PublishedSiteView username={slug} />;
  }
  return <PublishedSiteNotFound />;
}

/**
 * The platform not-found experience for unknown /site/<x>/<page> addresses —
 * matches the pre-M0.5 Router behavior (`case "site"` → NotFound) so the
 * fallback is not a NEW page shape, just the same one rendered here.
 */
function PublishedSiteNotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-20 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        That address doesn&apos;t match anything on BEAN Folio.
      </p>
    </div>
  );
}

/**
 * PortfolioCaseStudyRoute — /site/<slug>/work/<projectId>. The case study is
 * part of the creator's standalone site experience: chrome is suppressed for
 * the whole visit (the component renders inside the owner's own theme and
 * handles its own loading/not-found states).
 */
export function PortfolioCaseStudyRoute({ slug, projectId }: { slug: string; projectId: string }) {
  useEffect(() => {
    setStandaloneSite("yes");
  }, [slug, projectId]);
  return <PortfolioCaseStudyView slug={slug} projectId={projectId} />;
}
