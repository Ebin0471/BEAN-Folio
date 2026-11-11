"use client";

import { createContext, useContext, useMemo } from "react";
import type { PageConfig, PortfolioConfig, SiteOwner, SitePageMeta, SiteProjectCard, SectionType, WidgetType } from "@/lib/portfolio-schema";
import { sanitizePortfolioCss } from "@/lib/portfolio-css";
import { buildPfTheme, ASPECT_CLASS } from "./theme";
import { PfContext } from "./kit";
import type { PfRenderCtx } from "./sections";
import {
  PfHero,
  CurrentSection,
  StatsSection,
  ServicesSection,
  FeaturedSection,
  GallerySection,
  AboutSection,
  SkillsSection,
  ExperienceSection,
  TestimonialsSection,
  WritingSection,
  ResumeSection,
  ContactSection,
  FooterSection,
} from "./sections";
import { WidgetBlock } from "./widgets";

/**
 * PortfolioRenderer — renders ONE page of a portfolio (public site, public
 * sub-page or studio preview) from a PortfolioConfig. Everything is scoped
 * under [data-pf] with the owner's own theme tokens, so it can never restyle
 * the BEAN Folio application shell around it.
 */

type FlowItem =
  | { kind: "section"; id: string; type: SectionType; title: string; data: Record<string, unknown> }
  | { kind: "widget"; id: string; type: WidgetType; title: string; description: string; span: "full" | "half"; data: Record<string, unknown> };

function buildFlow(page: PageConfig): FlowItem[] {
  const flow: FlowItem[] = page.sections
    .filter((s) => s.visible)
    .map((s) => ({ kind: "section" as const, id: s.id, type: s.type, title: s.title, data: s.data }));

  const visibleWidgets = page.widgets.filter((w) => w.visible);
  for (const w of visibleWidgets) {
    const item: FlowItem = {
      kind: "widget",
      id: w.id,
      type: w.type,
      title: w.title,
      description: w.description,
      span: w.span,
      data: w.data,
    };
    if (w.after) {
      const idx = flow.findIndex((f) => f.id === w.after);
      if (idx >= 0) {
        flow.splice(idx + 1, 0, item);
        continue;
      }
    }
    // default: widgets land before the contact/footer tail
    const tailIdx = flow.findIndex((f) => f.kind === "section" && (f.type === "contact" || f.type === "footer"));
    if (tailIdx >= 0) flow.splice(tailIdx, 0, item);
    else flow.push(item);
  }
  return flow;
}

const PfRenderCtxContext = createContext<PfRenderCtx | null>(null);
export function usePfRenderCtx(): PfRenderCtx {
  const ctx = useContext(PfRenderCtxContext);
  if (!ctx) throw new Error("PfRenderCtx missing");
  return ctx;
}

export function PortfolioRenderer({
  config,
  page,
  pages,
  owner,
  projects,
  slug,
  interactive = true,
  pageBase,
}: {
  config: PortfolioConfig;
  /** The page to render. */
  page: PageConfig;
  /** All pages this viewer may see — drives the site navigation. */
  pages: SitePageMeta[];
  owner: SiteOwner;
  projects: SiteProjectCard[];
  slug: string;
  interactive?: boolean;
  /** Base for internal page links: "#/site/<slug>" (public) or "#/embed/…/<slug>" (preview). */
  pageBase?: string;
}) {
  const theme = useMemo(() => buildPfTheme(config), [config]);
  const flow = useMemo(() => buildFlow(page), [page]);
  const aspectClass = ASPECT_CLASS[config.layout.cardAspect] ?? ASPECT_CLASS.landscape;
  const base = pageBase ?? `#/site/${slug}`;

  const renderCtx: PfRenderCtx = useMemo(
    () => ({
      owner,
      projects,
      hero: {
        name: page.hero.name || owner.name,
        title: page.hero.title,
        intro: page.hero.intro,
        location: page.hero.location,
        availability: page.hero.availability,
        avatarMediaId: page.hero.avatarMediaId,
        coverMediaId: page.hero.coverMediaId,
        metrics: page.hero.metrics,
        currentProjectId: page.hero.currentProjectId,
        showCursorGlow: page.hero.showCursorGlow,
        primaryCtaLabel: page.hero.primaryCtaLabel,
        secondaryCtaLabel: page.hero.secondaryCtaLabel,
      },
    }),
    [page.hero, owner, projects]
  );

  const pfCtx = useMemo(
    () => ({
      motionEnabled: config.motion.enabled,
      entrance: config.motion.entrance,
      interactive,
      caseBase: `#/site/${slug}/work`,
      aspectClass,
      pageBase: base,
      pages: pages.filter((p) => p.inNav),
      activePageSlug: page.slug,
      isHome: page.isHome,
    }),
    [config.motion, interactive, slug, aspectClass, base, pages, page.slug, page.isHome]
  );

  const css = config.advanced.customCssEnabled ? sanitizePortfolioCss(config.advanced.customCss) : "";

  // In-page anchors must NOT write to location.hash — the app's hash router
  // would parse "#pf-sec-…" as a route and blow the site away. All pf-internal
  // navigation scrolls programmatically instead.
  const pfGo = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const navLabel = (type: string) =>
    ({ featured: "Work", gallery: "Work", about: "About", experience: "Experience", contact: "Contact" })[type] ?? type;

  // ---- navigation model: PAGES win when there is more than one visible page;
  // otherwise fall back to in-page section anchors (single-page sites).
  const navPages = pages.filter((p) => p.inNav && (p.isHome || p.isPublished));
  const anchorTargets = flow
    .filter((f): f is Extract<FlowItem, { kind: "section" }> =>
      f.kind === "section" && ["featured", "gallery", "about", "experience", "contact"].includes(f.type)
    )
    .filter((f, i, arr) => arr.findIndex((x) => navLabel(x.type) === navLabel(f.type)) === i)
    .slice(0, 4);
  const usePageNav = navPages.length > 1;
  const pageHref = (p: { slug: string; isHome: boolean }) => (p.isHome ? base : `${base}/${p.slug}`);

  const renderSection = (item: Extract<FlowItem, { kind: "section" }>) => {
    const node = (() => {
      switch (item.type) {
        case "current": return <CurrentSection ctx={renderCtx} data={item.data} title={item.title} />;
        case "stats": return <StatsSection data={item.data} title={item.title} />;
        case "services": return <ServicesSection data={item.data} title={item.title} />;
        case "featured": return <FeaturedSection ctx={renderCtx} data={item.data} title={item.title} />;
        case "gallery": return <GallerySection ctx={renderCtx} data={item.data} title={item.title} layout={config.layout} />;
        case "about": return <AboutSection data={item.data} title={item.title} owner={owner} />;
        case "skills": return <SkillsSection data={item.data} title={item.title} />;
        case "experience": return <ExperienceSection data={item.data} title={item.title} />;
        case "testimonials": return <TestimonialsSection data={item.data} title={item.title} />;
        case "writing": return <WritingSection data={item.data} title={item.title} />;
        case "resume": return <ResumeSection data={item.data} title={item.title} />;
        case "contact": return <ContactSection ctx={renderCtx} data={item.data} title={item.title} />;
        case "footer": return <FooterSection ctx={renderCtx} data={item.data} />;
        default: return null;
      }
    })();
    // data-pf-id lets the studio map a preview click back to the edited node.
    return (
      <div key={item.id} data-pf-id={item.id} data-pf-kind="section">
        {node}
      </div>
    );
  };

  // group consecutive half-span widgets into a 2-col grid
  const rows: FlowItem[][] = [];
  for (const item of flow) {
    if (item.kind === "widget" && item.span === "half") {
      const last = rows[rows.length - 1];
      if (last && last.length === 1 && last[0].kind === "widget" && last[0].span === "half") last.push(item);
      else rows.push([item]);
    } else {
      rows.push([item]);
    }
  }

  const body = (
    <>
      {rows.map((row, i) =>
        row.length === 2 ? (
          <div
            key={`w-${row[0].id}`}
            className="mx-auto grid w-full gap-4 px-5 sm:grid-cols-2 sm:gap-6 sm:px-8"
            style={{ maxWidth: "var(--pf-maxw)", paddingTop: "calc(var(--pf-secy) * 0.45)" }}
          >
            {row.map((it) => (
              <div key={it.id} data-pf-id={it.id} data-pf-kind="widget">
                <WidgetBlock w={it as never} ctx={renderCtx} />
              </div>
            ))}
          </div>
        ) : (
          <FragmentedRow key={row[0].id} item={row[0]} renderSection={renderSection} ctx={renderCtx} />
        )
      )}
    </>
  );

  const navLinks = usePageNav
    ? navPages.map((p) => (
        <a
          key={p.id}
          href={pageHref(p)}
          aria-current={p.slug === page.slug ? "page" : undefined}
          className="hidden text-[0.82em] transition-colors hover:opacity-70 sm:block"
          style={{ color: p.slug === page.slug ? "var(--pf-accent)" : "var(--pf-muted)" }}
        >
          {p.name}
        </a>
      ))
    : anchorTargets.map((t) => (
        <a key={t.id} href={`#pf-sec-${t.type}`} onClick={(e) => pfGo(e, `pf-sec-${t.type}`)} className="hidden text-[0.82em] transition-colors hover:opacity-70 sm:block" style={{ color: "var(--pf-muted)" }}>
          {navLabel(t.type)}
        </a>
      ));

  const sidebarNav = usePageNav
    ? navPages.map((p) => (
        <a
          key={p.id}
          href={pageHref(p)}
          aria-current={p.slug === page.slug ? "page" : undefined}
          className="px-6 py-2 text-[0.85em] transition-colors hover:opacity-70"
          style={{ color: p.slug === page.slug ? "var(--pf-accent)" : "var(--pf-muted)" }}
        >
          {p.name}
        </a>
      ))
    : anchorTargets.map((t) => (
        <a
          key={t.id}
          href={`#pf-sec-${t.type}`}
          onClick={(e) => pfGo(e, `pf-sec-${t.type}`)}
          className="px-6 py-2 text-[0.85em] transition-colors hover:opacity-70"
          style={{ color: "var(--pf-muted)" }}
        >
          {navLabel(t.type)}
        </a>
      ));

  const nav = config.layout.nav === "sidebar" ? (
    <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col gap-1 border-r py-8 md:flex" style={{ borderColor: "var(--pf-border)" }}>
      <div className="px-6">
        <a href={base} className="text-[1.05em] font-semibold" style={{ fontFamily: "var(--pf-font-display)" }}>{renderCtx.hero.name}</a>
        {renderCtx.hero.title && <p className="mt-1 text-[0.75em]" style={{ color: "var(--pf-muted)" }}>{renderCtx.hero.title}</p>}
      </div>
      <nav aria-label="Portfolio pages" className="mt-6 flex flex-col">
        {sidebarNav}
        {!navPages.some((p) => p.name === "Contact") && !usePageNav && (
          <a href="#pf-sec-contact" onClick={(e) => pfGo(e, "pf-sec-contact")} className="px-6 py-2 text-[0.85em] font-medium" style={{ color: "var(--pf-accent)" }}>
            Contact
          </a>
        )}
        {interactive && (
          <a href={`#/${owner.username ? `u/${owner.username}` : ""}`} className="mt-4 px-6 text-[0.72em]" style={{ color: "var(--pf-muted)" }}>
            ← Back to BEAN Folio
          </a>
        )}
      </nav>
    </aside>
  ) : null;

  return (
    <PfContext.Provider value={pfCtx}>
      <PfRenderCtxContext.Provider value={renderCtx}>
        <div
          data-pf
          style={theme.vars}
          className="min-h-full w-full antialiased"
          // custom CSS is sanitized + scoped to [data-pf] (see lib/portfolio-css.ts)
          {...(css ? { ["data-pf-css" as string]: "1" } : {})}
        >
          {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
          <a
            href="#pf-main"
            onClick={(e) => {
              e.preventDefault();
              const main = document.getElementById("pf-main");
              if (main) {
                main.scrollIntoView({ behavior: "smooth" });
                main.focus({ preventScroll: true });
              }
            }}
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:px-3 focus:py-2 focus:text-sm"
            style={{ background: "var(--pf-accent)", color: "var(--pf-bg)" }}
          >
            Skip to content
          </a>
          <div className={config.layout.nav === "sidebar" ? "mx-auto flex w-full max-w-[1600px]" : ""}>
            {nav}
            <div className="min-w-0 flex-1">
              {config.layout.nav === "top" && (
                <nav
                  aria-label="Portfolio navigation"
                  className="sticky top-0 z-40 border-b"
                  style={{ borderColor: "var(--pf-border)", background: "var(--pf-glass)", backdropFilter: "blur(12px)" }}
                >
                  <div className="mx-auto flex h-14 w-full items-center justify-between px-5 sm:px-8" style={{ maxWidth: "var(--pf-maxw)" }}>
                    <a href={base} onClick={page.isHome ? (e) => pfGo(e, "top") : undefined} className="truncate text-[0.95em] font-semibold" style={{ fontFamily: "var(--pf-font-display)" }}>
                      {renderCtx.hero.name}
                    </a>
                    <div className="flex items-center gap-5">
                      {navLinks}
                      {!usePageNav && !anchorTargets.some((t) => t.type === "contact") && (
                        <a href="#pf-sec-contact" onClick={(e) => pfGo(e, "pf-sec-contact")} className="text-[0.82em] font-semibold" style={{ color: "var(--pf-accent)" }}>
                          Contact
                        </a>
                      )}
                    </div>
                  </div>
                </nav>
              )}
              <div id="top" />
              {/* The hero belongs to the home page; sub-pages start with their content. */}
              {page.isHome && <div data-pf-id="hero" data-pf-kind="hero"><PfHero ctx={renderCtx} layout={config.layout.heroLayout} /></div>}
              <main id="pf-main" tabIndex={-1}>{body}</main>
            </div>
          </div>
        </div>
      </PfRenderCtxContext.Provider>
    </PfContext.Provider>
  );
}

function FragmentedRow({
  item,
  renderSection,
  ctx,
}: {
  item: FlowItem;
  renderSection: (i: Extract<FlowItem, { kind: "section" }>) => React.ReactNode;
  ctx: PfRenderCtx;
}) {
  if (item.kind === "section") return <>{renderSection(item)}</>;
  return (
    <div data-pf-id={item.id} data-pf-kind="widget">
      <WidgetBlock w={item as never} ctx={ctx} />
    </div>
  );
}
