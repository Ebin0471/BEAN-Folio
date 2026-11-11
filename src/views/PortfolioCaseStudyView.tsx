"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Compass, ExternalLink, Github, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/bean/EmptyState";
import { api } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import type { ProjectDetailResponse } from "@/lib/types";
import { homePage } from "@/lib/portfolio-schema";
import type { SiteResponse } from "@/lib/portfolio-schema";
import { buildPfTheme } from "@/components/bean/portfolio/theme";
import { useDocumentMeta } from "@/components/bean/portfolio/kit";
import { formatCompact, formatDate } from "@/lib/client";

type SiteResponseShim = SiteResponse;

type CaseStatus = "loading" | "notfound" | "ok";
interface CaseFetchState {
  key: string;
  status: CaseStatus;
  site: SiteResponseShim | null;
  detail: ProjectDetailResponse | null;
}

/** Editorial story block, hoisted so it isn't recreated during render. */
function CaseSection({ eyebrow, title, children }: { eyebrow?: string; title?: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full px-5 sm:px-8" style={{ maxWidth: "calc(var(--pf-maxw) * 0.82)" }}>
      {eyebrow && (
        <p className="mb-2 text-[0.72em] font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--pf-accent)" }}>
          {eyebrow}
        </p>
      )}
      {title && (
        <h2 className="mb-4 text-[1.5em] font-semibold tracking-tight sm:text-[1.8em]" style={{ fontFamily: "var(--pf-font-display)" }}>
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

/**
 * Portfolio case study — #/site/<slug>/work/<projectId>.
 * Editorial project page rendered INSIDE the owner's portfolio theme. The
 * project itself is loaded through the existing visibility-enforcing endpoint
 * (drafts/private → 404; unlisted visible by direct link).
 */
export default function PortfolioCaseStudyView({ slug, projectId }: { slug: string; projectId: string }) {
  const fetchKey = `${slug}|${projectId}`;
  const [fetch, setFetch] = useState<CaseFetchState>({ key: fetchKey, status: "loading", site: null, detail: null });
  const view = fetch.key === fetchKey ? fetch : ({ key: fetchKey, status: "loading", site: null, detail: null } as CaseFetchState);
  const { site, detail } = view;
  const status = view.status === "ok" && (!view.site || !view.detail) ? "notfound" : view.status;

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<SiteResponseShim>(`/api/site/${encodeURIComponent(slug)}`).catch(() => null),
      api<ProjectDetailResponse>(`/api/projects/${projectId}`).catch(() => null),
    ]).then(([s, d]) => {
      if (!alive) return;
      if (!s || !d) {
        setFetch({ key: fetchKey, status: "notfound", site: null, detail: null });
        return;
      }
      setFetch({ key: fetchKey, status: "ok", site: s, detail: d });
    });
    return () => {
      alive = false;
    };
  }, [slug, projectId, fetchKey]);

  const theme = useMemo(() => (site ? buildPfTheme(site.config) : null), [site]);

  useDocumentMeta(
    detail ? `${detail.project.title} — ${site ? homePage(site.config).hero.name || site.owner.name : "Case study"}` : "Case study",
    detail?.project.summary ?? undefined,
    detail ? detail.project.visibility !== "PUBLIC" : true
  );

  if (status === "loading") {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading case study" />
      </div>
    );
  }
  if (status === "notfound" || !site || !detail || !theme) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20">
        <EmptyState
          icon={Compass}
          title="Case study not available"
          description="This project doesn't exist, is private, or the portfolio isn't published."
          action={<Button onClick={() => navigate("/")}>Back to Discover</Button>}
        />
      </div>
    );
  }

  const { project, owner, isOwner } = detail;
  const vars = theme.vars as React.CSSProperties;
  const related = site.projects.filter((p) => p.id !== project.id && (!project.category || p.category === project.category)).slice(0, 3);
  const fallbackRelated = related.length === 0 ? site.projects.filter((p) => p.id !== project.id).slice(0, 3) : related;

  return (
    <div data-pf style={{ ...vars, backgroundColor: "var(--pf-bg)", color: "var(--pf-text)", fontFamily: "var(--pf-font-body)" }} className="min-h-full w-full pb-20 antialiased">
      {/* project hero */}
      {project.coverUrl && (
        <div className="relative h-[42vh] min-h-64 w-full overflow-hidden sm:h-[52vh]">
          <img src={project.coverUrl} alt={project.title} className="h-full w-full object-cover" />
          <div className="absolute inset-0" style={{ background: "linear-gradient(to top, var(--pf-bg) 4%, transparent 60%)" }} />
        </div>
      )}

      <div className="mx-auto -mt-24 w-full px-5 sm:px-8" style={{ maxWidth: "calc(var(--pf-maxw) * 0.82)" }}>
        <Link
          href={`#/site/${slug}`}
          className="mb-6 inline-flex min-h-9 items-center gap-2 text-[0.85em] transition-opacity hover:opacity-75"
          style={{ color: "var(--pf-muted)" }}
        >
          <ArrowLeft className="size-4" aria-hidden /> Back to {homePage(site.config).hero.name || site.owner.name}&apos;s portfolio
        </Link>

        {project.category && (
          <p className="mb-3 text-[0.72em] font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--pf-accent)" }}>
            {project.category}
          </p>
        )}
        <h1 className="text-balance text-[2.2em] font-semibold leading-[1.08] tracking-tight sm:text-[3em]" style={{ fontFamily: "var(--pf-font-display)" }}>
          {project.title}
        </h1>
        {project.summary && (
          <p className="mt-4 max-w-2xl text-[1.05em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>
            {project.summary}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.82em]" style={{ color: "var(--pf-muted)" }}>
          <span>
            By{" "}
            <Link href={`#/u/${owner.username}`} className="font-medium underline-offset-2 hover:underline" style={{ color: "var(--pf-text)" }}>
              {owner.name}
            </Link>
          </span>
          {project.publishedAt && <span>Published {formatDate(project.publishedAt)}</span>}
          <span>{formatCompact(project.counts.views)} views</span>
          <span>{formatCompact(project.counts.saves)} saves</span>
          {isOwner && (
            <Badge variant="outline" className="border-[color:var(--pf-border-strong)] text-[0.9em]" style={{ color: "var(--pf-accent)" }}>
              Your project
            </Badge>
          )}
        </div>

        {(project.externalUrl || project.repoUrl) && (
          <div className="mt-6 flex flex-wrap gap-3">
            {project.externalUrl && (
              <a
                href={project.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-[calc(var(--pf-radius)*0.75)] px-5 py-2.5 text-[0.9em] font-semibold transition-all hover:brightness-110"
                style={{ background: "var(--pf-accent)", color: "var(--pf-bg)" }}
              >
                <ExternalLink className="size-4" aria-hidden /> Visit project
              </a>
            )}
            {project.repoUrl && (
              <a
                href={project.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-[calc(var(--pf-radius)*0.75)] border px-5 py-2.5 text-[0.9em] font-semibold transition-colors"
                style={{ borderColor: "var(--pf-border-strong)", color: "var(--pf-text)" }}
              >
                <Github className="size-4" aria-hidden /> Repository
              </a>
            )}
          </div>
        )}
      </div>

      {/* gallery */}
      {project.media.length > 0 && (
        <div className="mt-14 space-y-6">
          {project.media.map((m) => (
            <figure key={m.id} className="mx-auto w-full px-5 sm:px-8" style={{ maxWidth: "calc(var(--pf-maxw) * 0.82)" }}>
              {m.kind === "IMAGE" && (
                 
                <img src={m.url} alt={m.caption || project.title} loading="lazy" className="w-full rounded-[var(--pf-radius)] border object-cover" style={{ borderColor: "var(--pf-border)" }} />
              )}
              {m.kind === "VIDEO" && <video src={m.url} controls playsInline preload="metadata" className="w-full rounded-[var(--pf-radius)] border" style={{ borderColor: "var(--pf-border)" }} />}
              {m.kind === "AUDIO" && <audio src={m.url} controls preload="none" className="w-full" />}
              {m.kind === "DOCUMENT" && (
                <a href={m.url} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "var(--pf-accent)" }}>
                  Open document
                </a>
              )}
              {m.caption && (
                <figcaption className="mt-2 text-center text-[0.78em]" style={{ color: "var(--pf-muted)" }}>
                  {m.caption}
                </figcaption>
              )}
            </figure>
          ))}
        </div>
      )}

      {/* editorial story */}
      <div className="mt-16 space-y-14">
        {project.brief && (
          <CaseSection eyebrow="The brief">
            <p className="max-w-2xl text-[1em] leading-[1.8] whitespace-pre-line" style={{ color: "var(--pf-muted)" }}>{project.brief}</p>
          </CaseSection>
        )}
        {project.role && (
          <CaseSection eyebrow="My role">
            <p className="max-w-2xl border-l-2 pl-5 text-[1em] leading-[1.8]" style={{ borderColor: "var(--pf-accent)", color: "var(--pf-muted)" }}>
              {project.role}
            </p>
          </CaseSection>
        )}
        {project.process && (
          <CaseSection eyebrow="Process">
            <p className="max-w-2xl text-[1em] leading-[1.8] whitespace-pre-line" style={{ color: "var(--pf-muted)" }}>{project.process}</p>
          </CaseSection>
        )}
        {project.challenges && (
          <CaseSection eyebrow="Challenges & decisions">
            <p className="max-w-2xl text-[1em] leading-[1.8] whitespace-pre-line" style={{ color: "var(--pf-muted)" }}>{project.challenges}</p>
          </CaseSection>
        )}
        {project.outcome && (
          <CaseSection eyebrow="Outcome">
            <p className="max-w-2xl text-[1em] leading-[1.8] whitespace-pre-line" style={{ color: "var(--pf-muted)" }}>{project.outcome}</p>
          </CaseSection>
        )}
        {project.description && (
          <CaseSection>
            <p className="max-w-2xl text-[1em] leading-[1.8] whitespace-pre-line" style={{ color: "var(--pf-muted)" }}>{project.description}</p>
          </CaseSection>
        )}
      </div>

      {/* facts */}
      {(project.skills.length > 0 || project.tools.length > 0 || project.contributors.length > 0) && (
        <div className="mt-16">
          <CaseSection eyebrow="Details">
            <div className="grid gap-6 sm:grid-cols-2">
              {project.skills.length > 0 && (
                <div>
                  <p className="mb-2 text-[0.78em] font-semibold uppercase tracking-widest" style={{ color: "var(--pf-muted)" }}>Skills</p>
                  <div className="flex flex-wrap gap-1.5">
                    {project.skills.map((s) => (
                      <span key={s} className="rounded-full border px-3 py-1 text-[0.8em]" style={{ borderColor: "var(--pf-border)", color: "var(--pf-muted)" }}>
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {project.tools.length > 0 && (
                <div>
                  <p className="mb-2 text-[0.78em] font-semibold uppercase tracking-widest" style={{ color: "var(--pf-muted)" }}>Tools</p>
                  <div className="flex flex-wrap gap-1.5">
                    {project.tools.map((t) => (
                      <span key={t} className="rounded-full border px-3 py-1 text-[0.8em]" style={{ borderColor: "var(--pf-border)", color: "var(--pf-muted)" }}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {project.contributors.length > 0 && (
                <div className="sm:col-span-2">
                  <p className="mb-2 text-[0.78em] font-semibold uppercase tracking-widest" style={{ color: "var(--pf-muted)" }}>Credits</p>
                  <ul className="space-y-1 text-[0.88em]" style={{ color: "var(--pf-muted)" }}>
                    {project.contributors.map((c) => (
                      <li key={c.id}>
                        <span className="font-medium" style={{ color: "var(--pf-text)" }}>{c.name}</span>
                        {c.role && ` — ${c.role}`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </CaseSection>
        </div>
      )}

      {/* related */}
      {fallbackRelated.length > 0 && (
        <div className="mt-16 border-t pt-12" style={{ borderColor: "var(--pf-border)" }}>
          <CaseSection eyebrow="More work">
            <div className="grid gap-5 sm:grid-cols-3">
              {fallbackRelated.map((p) => (
                <Link
                  key={p.id}
                  href={`#/site/${slug}/work/${p.id}`}
                  className="group overflow-hidden rounded-[var(--pf-radius)] border transition-transform duration-300 hover:-translate-y-0.5"
                  style={{ borderColor: "var(--pf-border)", background: "var(--pf-surface)", boxShadow: "var(--pf-shadow)" }}
                >
                  <div className="aspect-video w-full overflow-hidden">
                    {p.coverUrl ? (
                       
                      <img src={p.coverUrl} alt={p.title} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                    ) : (
                      <div className="grid h-full place-items-center text-[1.6em] opacity-40" style={{ fontFamily: "var(--pf-font-display)" }}>
                        {p.title.slice(0, 1)}
                      </div>
                    )}
                  </div>
                  <div className="p-4">
                    <p className="text-[0.95em] font-semibold">{p.title}</p>
                    {p.summary && <p className="mt-1 line-clamp-2 text-[0.8em]" style={{ color: "var(--pf-muted)" }}>{p.summary}</p>}
                  </div>
                </Link>
              ))}
            </div>
          </CaseSection>
        </div>
      )}

      <footer className="mt-16 border-t pt-8 text-center text-[0.8em]" style={{ borderColor: "var(--pf-border)", color: "var(--pf-muted)" }}>
        <Link href={`#/site/${slug}`} className="hover:underline">
          {homePage(site.config).hero.name || site.owner.name} — full portfolio
        </Link>
        <span className="mx-2">·</span>
        <a href="#/" className="hover:underline">Built with BEAN Folio</a>
      </footer>
    </div>
  );
}
