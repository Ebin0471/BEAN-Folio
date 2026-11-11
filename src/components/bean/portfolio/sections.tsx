"use client";

import { useContext, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowUpRight,
  Briefcase,
  Download,
  ExternalLink,
  FileText,
  GraduationCap,
  Github,
  Globe,
  Linkedin,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  Send,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { SiteOwner, SiteProjectCard } from "@/lib/portfolio-schema";
import {
  PfButton,
  PfCard,
  PfChip,
  PfContext,
  PfEmpty,
  PfMedia,
  PfReveal,
  PfSection,
  usePf,
  usePfMotion,
  mediaUrl,
  darr,
  dstr,
  dnstr,
  dbool,
} from "./kit";

// ---------------------------------------------------------------- shared context

export interface PfRenderCtx {
  owner: SiteOwner;
  projects: SiteProjectCard[];
  hero: {
    name: string;
    title: string;
    intro: string;
    location: string;
    availability: string;
    avatarMediaId: string | null;
    coverMediaId: string | null;
    metrics: { value: string; label: string }[];
    currentProjectId: string | null;
    showCursorGlow: boolean;
    primaryCtaLabel: string;
    secondaryCtaLabel: string;
  };
}

export function projectById(projects: SiteProjectCard[], id: string | null): SiteProjectCard | null {
  if (!id) return null;
  return projects.find((p) => p.id === id) ?? null;
}

/** Case-study link builder — empty string when non-interactive (studio preview). */
export function useCaseHref(): (projectId: string) => string {
  const { caseBase, interactive } = usePf();
  return (projectId: string) => (interactive ? `${caseBase}/${projectId}` : "");
}

/** Card aspect class from layout settings (provided via PfContext). */
export function useAspect(): string {
  return useContext(PfContext).aspectClass;
}

// ---------------------------------------------------------------- project card

export function PfProjectCard({ project, index = 0 }: { project: SiteProjectCard; index?: number }) {
  const href = useCaseHref();
  const aspect = useAspect();
  const m = usePfMotion();
  const cover = project.coverUrl;
  const body = (
    <>
      <div className={cn("relative w-full overflow-hidden", aspect)} style={{ background: "color-mix(in srgb, var(--pf-surface) 80%, var(--pf-bg))" }}>
        {cover ? (
          <PfMedia src={cover} alt={project.title} className="transition-transform duration-500 hover:scale-[1.03]" />
        ) : (
          <div className="grid h-full w-full place-items-center" style={{ color: "var(--pf-muted)" }}>
            <span className="text-[2em] opacity-40" style={{ fontFamily: "var(--pf-font-display)" }}>
              {project.title.slice(0, 1)}
            </span>
          </div>
        )}
      </div>
      <div className="p-4 sm:p-5">
        <h3 className="text-[1.05em] font-semibold leading-snug" style={{ fontFamily: "var(--pf-font-display)" }}>
          {project.title}
        </h3>
        {project.summary && (
          <p className="mt-1.5 line-clamp-2 text-[0.85em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>
            {project.summary}
          </p>
        )}
        {project.skills.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {project.skills.slice(0, 3).map((s) => (
              <PfChip key={s}>{s}</PfChip>
            ))}
          </div>
        )}
      </div>
    </>
  );
  const cls = "block h-full text-left";
  return (
    <motion.div initial={m.initial} whileInView={m.whileInView} viewport={m.viewport} transition={{ ...m.transition, delay: Math.min(index * 0.05, 0.3) }}>
      <PfCard hover className="group h-full">
        {href(project.id) ? (
          <a href={href(project.id)} className={cls} aria-label={`Open case study: ${project.title}`}>
            {body}
          </a>
        ) : (
          <div className={cls}>{body}</div>
        )}
      </PfCard>
    </motion.div>
  );
}

// ---------------------------------------------------------------- hero

function CursorGlow() {
  const reduce = useReducedMotion();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  if (reduce) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0"
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}
    >
      {pos && (
        <div
          className="absolute size-[420px] rounded-full transition-transform duration-300"
          style={{
            left: pos.x - 210,
            top: pos.y - 210,
            background: "radial-gradient(circle, var(--pf-accent-soft) 0%, transparent 65%)",
          }}
        />
      )}
    </div>
  );
}

function HeroMetrics({ metrics }: { metrics: { value: string; label: string }[] }) {
  if (metrics.length === 0) return null;
  return (
    <div className="mt-8 flex flex-wrap items-stretch gap-x-8 gap-y-4">
      {metrics.map((mt, i) => (
        <div key={i} className="min-w-20">
          <p className="text-[1.7em] font-semibold leading-none" style={{ fontFamily: "var(--pf-font-display)", color: "var(--pf-accent)" }}>
            {mt.value}
          </p>
          <p className="mt-1.5 text-[0.78em]" style={{ color: "var(--pf-muted)" }}>
            {mt.label}
          </p>
        </div>
      ))}
    </div>
  );
}

function FeaturedCurrentCard({ project }: { project: SiteProjectCard }) {
  const href = useCaseHref();
  const inner = (
    <>
      <div className="flex items-center gap-2 px-5 pt-4">
        <span className="relative flex size-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: "var(--pf-accent)" }} />
          <span className="relative inline-flex size-2 rounded-full" style={{ background: "var(--pf-accent)" }} />
        </span>
        <span className="text-[0.72em] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--pf-accent)" }}>
          Currently building
        </span>
      </div>
      <div className="flex items-center gap-4 p-5 pt-3">
        {project.coverUrl && (
          <div className="size-16 shrink-0 overflow-hidden rounded-[calc(var(--pf-radius)*0.6)]">
            <PfMedia src={project.coverUrl} alt={project.title} />
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-[0.98em] font-semibold">{project.title}</p>
          {project.summary && <p className="mt-0.5 line-clamp-2 text-[0.8em]" style={{ color: "var(--pf-muted)" }}>{project.summary}</p>}
        </div>
        <ArrowUpRight className="ml-auto size-4 shrink-0" style={{ color: "var(--pf-muted)" }} aria-hidden />
      </div>
    </>
  );
  return (
    <PfCard className="max-w-md transition-transform duration-300 hover:-translate-y-0.5">
      {href(project.id) ? (
        <a href={href(project.id)} aria-label={`Open case study: ${project.title}`}>
          {inner}
        </a>
      ) : (
        inner
      )}
    </PfCard>
  );
}

export function PfHero({ ctx, layout }: { ctx: PfRenderCtx; layout: string }) {
  const { hero } = ctx;
  const { interactive } = usePf();
  const avatar = mediaUrl(hero.avatarMediaId);
  const cover = mediaUrl(hero.coverMediaId);
  const current = projectById(ctx.projects, hero.currentProjectId);
  const scrollTarget = (which: "work" | "contact") => {
    const ids = which === "work" ? ["pf-sec-featured", "pf-sec-gallery", "pf-sec-current"] : ["pf-sec-contact"];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
        return;
      }
    }
    if (!interactive) document.getElementById("pf-sec-contact")?.scrollIntoView({ behavior: "smooth" });
  };

  const nameBlock = (centered: boolean) => (
    <div className={cn(centered && "text-center")}>
      {hero.title && (
        <p className="mb-3 text-[0.72em] font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--pf-accent)" }} data-pf-field="title">
          {hero.title}
        </p>
      )}
      <h1
        className="text-balance text-[2.6em] font-semibold leading-[1.04] tracking-tight sm:text-[3.4em]"
        style={{ fontFamily: "var(--pf-font-display)" }}
        data-pf-field="name"
      >
        {hero.name}
      </h1>
      {hero.intro && (
        <p className={cn("mt-5 max-w-xl text-[1.02em] leading-relaxed", centered && "mx-auto")} style={{ color: "var(--pf-muted)" }} data-pf-field="intro">
          {hero.intro}
        </p>
      )}
      {(hero.location || hero.availability) && (
        <div className={cn("mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.85em]", centered && "justify-center")} style={{ color: "var(--pf-muted)" }}>
          {hero.availability && (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full" style={{ background: "var(--pf-accent)" }} aria-hidden />
              {hero.availability}
            </span>
          )}
          {hero.location && (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-3.5" aria-hidden /> {hero.location}
            </span>
          )}
        </div>
      )}
      <div className={cn("mt-8 flex flex-wrap items-center gap-3", centered && "justify-center")}>
        <PfButton onClick={() => scrollTarget("work")}>{hero.primaryCtaLabel || "View my work"}</PfButton>
        <PfButton variant="outline" className="pf-btn-outline" onClick={() => scrollTarget("contact")}>
          {hero.secondaryCtaLabel || "Contact me"}
        </PfButton>
      </div>
      <HeroMetrics metrics={hero.metrics} />
    </div>
  );

  const avatarCard = (size: string) =>
    avatar ? (
      <div className={cn("relative overflow-hidden rounded-[var(--pf-radius)]", size)} style={{ boxShadow: "var(--pf-shadow)", border: "1px solid var(--pf-border)" }}>
        <PfMedia src={avatar} alt={`Portrait of ${hero.name}`} />
      </div>
    ) : null;

  return (
    <header className="relative w-full overflow-hidden" style={{ paddingTop: "var(--pf-secy)", paddingBottom: "var(--pf-secy)" }}>
      {hero.showCursorGlow && <CursorGlow />}
      {layout === "cinematic" ? (
        <div className="relative flex min-h-[72vh] items-end">
          {cover && (
            <div className="absolute inset-0">
              <PfMedia src={cover} alt="" className="opacity-45" style={{ objectFit: "cover" }} />
              <div className="absolute inset-0" style={{ background: "linear-gradient(to top, var(--pf-bg) 8%, color-mix(in srgb, var(--pf-bg) 40%, transparent) 55%, transparent)" }} />
            </div>
          )}
          <div className="relative mx-auto w-full px-5 pb-6 sm:px-8" style={{ maxWidth: "var(--pf-maxw)" }}>
            {avatar && (
              <div className="mb-6 size-14 overflow-hidden rounded-full border" style={{ borderColor: "var(--pf-border-strong)" }}>
                <PfMedia src={avatar} alt={`Portrait of ${hero.name}`} />
              </div>
            )}
            <PfReveal>{nameBlock(false)}</PfReveal>
            {current && (
              <div className="mt-10">
                <FeaturedCurrentCard project={current} />
              </div>
            )}
          </div>
        </div>
      ) : layout === "split" ? (
        <div className="mx-auto grid w-full items-center gap-10 px-5 sm:px-8 md:grid-cols-[1.2fr_0.8fr]" style={{ maxWidth: "var(--pf-maxw)" }}>
          <PfReveal>{nameBlock(false)}</PfReveal>
          <PfReveal className="justify-self-center md:justify-self-end">
            {avatarCard("aspect-[4/5] w-full max-w-sm")}
            {current && !avatar && (
              <div className="mt-6">
                <FeaturedCurrentCard project={current} />
              </div>
            )}
          </PfReveal>
          {avatar && current && (
            <div className="md:col-span-2">
              <FeaturedCurrentCard project={current} />
            </div>
          )}
        </div>
      ) : layout === "portrait" ? (
        <div className="mx-auto grid w-full items-center gap-10 px-5 sm:px-8 md:grid-cols-[0.9fr_1.1fr]" style={{ maxWidth: "var(--pf-maxw)" }}>
          <PfReveal className="order-2 md:order-1">{nameBlock(false)}</PfReveal>
          <PfReveal className="order-1 justify-self-center md:order-2 md:justify-self-end">
            {avatarCard("aspect-[3/4] w-full max-w-[420px]")}
          </PfReveal>
        </div>
      ) : layout === "minimal" ? (
        <div className="mx-auto w-full px-5 sm:px-8" style={{ maxWidth: "var(--pf-maxw)" }}>
          <PfReveal>{nameBlock(false)}</PfReveal>
          <div className="mt-12 border-t pt-8" style={{ borderColor: "var(--pf-border)" }}>
            {current && <FeaturedCurrentCard project={current} />}
          </div>
        </div>
      ) : (
        // centered
        <div className="mx-auto flex w-full flex-col items-center px-5 text-center sm:px-8" style={{ maxWidth: "var(--pf-maxw)" }}>
          {avatar && (
            <PfReveal className="mb-8">
              <div className="size-28 overflow-hidden rounded-full border-2 sm:size-32" style={{ borderColor: "var(--pf-accent-border)" }}>
                <PfMedia src={avatar} alt={`Portrait of ${hero.name}`} />
              </div>
            </PfReveal>
          )}
          <PfReveal>{nameBlock(true)}</PfReveal>
          {current && (
            <PfReveal className="mt-12 w-full max-w-md">
              <FeaturedCurrentCard project={current} />
            </PfReveal>
          )}
        </div>
      )}
    </header>
  );
}

// ---------------------------------------------------------------- sections

export function CurrentSection({ ctx, data, title }: { ctx: PfRenderCtx; data: Record<string, unknown>; title: string }) {
  const project = projectById(ctx.projects, dnstr(data, "projectId") ?? ctx.hero.currentProjectId);
  const note = dstr(data, "note");
  if (!project && !note) return null;
  return (
    <PfSection id="pf-sec-current" title={title || "Currently"} containerClassName="max-w-4xl">
      <PfReveal>
        {project ? (
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <div className="w-full sm:w-64">
              <PfProjectCard project={project} />
            </div>
            {note && <p className="text-[1em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>{note}</p>}
          </div>
        ) : (
          <p className="text-[1em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>{note}</p>
        )}
      </PfReveal>
    </PfSection>
  );
}

export function StatsSection({ data, title }: { data: Record<string, unknown>; title: string }) {
  const items = darr<{ value: string; label: string }>(data, "items");
  if (items.length === 0) return null;
  return (
    <PfSection id="pf-sec-stats" title={title || "By the numbers"}>
      <div className="grid grid-cols-2 gap-4 sm:gap-6 md:grid-cols-4">
        {items.map((it, i) => (
          <PfReveal key={i}>
            <PfCard className="p-6">
              <p className="text-[2em] font-semibold leading-none" style={{ fontFamily: "var(--pf-font-display)", color: "var(--pf-accent)" }}>
                {it.value}
              </p>
              <p className="mt-2 text-[0.82em]" style={{ color: "var(--pf-muted)" }}>{it.label}</p>
            </PfCard>
          </PfReveal>
        ))}
      </div>
    </PfSection>
  );
}

export function ServicesSection({ data, title }: { data: Record<string, unknown>; title: string }) {
  const items = darr<{ title: string; description: string }>(data, "items");
  if (items.length === 0) return null;
  return (
    <PfSection id="pf-sec-services" title={title || "What I do"}>
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
        {items.map((it, i) => (
          <PfReveal key={i}>
            <PfCard className="h-full p-6">
              <p className="text-[0.78em] font-semibold tracking-widest" style={{ color: "var(--pf-accent)" }}>
                {String(i + 1).padStart(2, "0")}
              </p>
              <h3 className="mt-3 text-[1.05em] font-semibold" style={{ fontFamily: "var(--pf-font-display)" }}>{it.title}</h3>
              {it.description && <p className="mt-2 text-[0.88em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>{it.description}</p>}
            </PfCard>
          </PfReveal>
        ))}
      </div>
    </PfSection>
  );
}

export function FeaturedSection({ ctx, data, title }: { ctx: PfRenderCtx; data: Record<string, unknown>; title: string }) {
  const ids = darr<string>(data, "projectIds");
  const projects = ids.map((id) => projectById(ctx.projects, id)).filter((p): p is SiteProjectCard => Boolean(p));
  if (projects.length === 0) return null;
  const [first, ...rest] = projects;
  return (
    <PfSection id="pf-sec-featured" title={title || "Featured work"}>
      <div className="grid gap-4 sm:gap-6">
        <PfProjectCard project={first} />
        {rest.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
            {rest.map((p, i) => (
              <PfProjectCard key={p.id} project={p} index={i + 1} />
            ))}
          </div>
        )}
      </div>
    </PfSection>
  );
}

export function GallerySection({ ctx, data, title, layout }: { ctx: PfRenderCtx; data: Record<string, unknown>; title: string; layout: { projectGrid: string; cardAspect: string; columns: number } }) {
  const filterable = dbool(data, "filterable");
  const categories = useMemo(
    () => Array.from(new Set(ctx.projects.map((p) => p.category).filter((c): c is string => Boolean(c)))),
    [ctx.projects]
  );
  const [filter, setFilter] = useState<string | null>(null);
  const projects = filter ? ctx.projects.filter((p) => p.category === filter) : ctx.projects;
  if (ctx.projects.length === 0) return null;

  const cols = Math.min(layout.columns, 4);
  const gridCls =
    layout.projectGrid === "masonry"
      ? `columns-1 sm:columns-2 ${cols >= 3 ? (cols >= 4 ? "md:columns-3 lg:columns-4" : "md:columns-3") : "md:columns-2"} gap-4 [&>*]:mb-4`
      : `grid grid-cols-1 sm:grid-cols-2 ${cols >= 3 ? `md:grid-cols-${Math.min(cols, 4)}` : "md:grid-cols-2"} gap-4 sm:gap-6`;

  return (
    <PfSection id="pf-sec-gallery" title={title || "Selected work"}>
      {filterable && categories.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2">
          <button type="button" onClick={() => setFilter(null)} aria-pressed={filter === null}>
            <PfChip active={filter === null}>All</PfChip>
          </button>
          {categories.map((c) => (
            <button key={c} type="button" onClick={() => setFilter(c === filter ? null : c)} aria-pressed={filter === c}>
              <PfChip active={filter === c}>{c}</PfChip>
            </button>
          ))}
        </div>
      )}
      {projects.length === 0 ? (
        <PfEmpty>No projects in this category yet.</PfEmpty>
      ) : (
        <div className={gridCls}>
          {projects.map((p, i) => (
            <div key={p.id} className={layout.projectGrid === "masonry" ? "break-inside-avoid" : undefined}>
              <PfProjectCard project={p} index={i} />
            </div>
          ))}
        </div>
      )}
    </PfSection>
  );
}

export function AboutSection({ data, title, owner }: { data: Record<string, unknown>; title: string; owner: SiteOwner }) {
  const body = dstr(data, "body");
  if (!body.trim()) return null;
  const paragraphs = body.split(/\n{2,}/).filter(Boolean);
  return (
    <PfSection id="pf-sec-about" title={title || "About"}>
      <div className="grid gap-8 md:grid-cols-[1fr_240px]">
        <div className="max-w-2xl space-y-4">
          {paragraphs.map((p, i) => (
            <PfReveal key={i}>
              <p className="text-[1em] leading-[1.8]" style={{ color: "var(--pf-muted)" }}>
                {p}
              </p>
            </PfReveal>
          ))}
        </div>
        <PfReveal>
          <PfCard className="p-5">
            {owner.avatarUrl && (
              <div className="mb-4 size-16 overflow-hidden rounded-full">
                <PfMedia src={owner.avatarUrl} alt={owner.name} />
              </div>
            )}
            <p className="text-[0.95em] font-semibold">{owner.name}</p>
            {owner.headline && <p className="mt-0.5 text-[0.8em]" style={{ color: "var(--pf-muted)" }}>{owner.headline}</p>}
            {owner.professions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {owner.professions.slice(0, 4).map((p) => (
                  <PfChip key={p}>{p}</PfChip>
                ))}
              </div>
            )}
          </PfCard>
        </PfReveal>
      </div>
    </PfSection>
  );
}

export function SkillsSection({ data, title }: { data: Record<string, unknown>; title: string }) {
  const items = darr<string>(data, "items");
  if (items.length === 0) return null;
  return (
    <PfSection id="pf-sec-skills" title={title || "Skills & tools"}>
      <PfReveal>
        <div className="flex flex-wrap gap-2">
          {items.map((s) => (
            <PfChip key={s}>{s}</PfChip>
          ))}
        </div>
      </PfReveal>
    </PfSection>
  );
}

export function ExperienceSection({ data, title }: { data: Record<string, unknown>; title: string }) {
  const items = darr<{ kind: string; org: string; role: string; period: string; summary: string }>(data, "items");
  if (items.length === 0) return null;
  return (
    <PfSection id="pf-sec-experience" title={title || "Experience"}>
      <ol className="relative space-y-8 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px" style={{ ["--tw-before-bg" as never]: "none", borderLeft: "none" }}>
        {items.map((it, i) => (
          <PfReveal key={i}>
            <li className="relative pl-8">
              <span
                className="absolute left-0 top-1 grid size-4 place-items-center rounded-full border"
                style={{ borderColor: "var(--pf-accent-border)", background: "var(--pf-accent-soft)" }}
                aria-hidden
              >
                {it.kind === "education" ? (
                  <GraduationCap className="size-2.5" style={{ color: "var(--pf-accent)" }} />
                ) : (
                  <Briefcase className="size-2.5" style={{ color: "var(--pf-accent)" }} />
                )}
              </span>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-[1em] font-semibold">{it.org}</h3>
                {it.period && <span className="text-[0.78em]" style={{ color: "var(--pf-muted)" }}>{it.period}</span>}
              </div>
              {it.role && <p className="mt-0.5 text-[0.85em]" style={{ color: "var(--pf-accent)" }}>{it.role}</p>}
              {it.summary && <p className="mt-1.5 max-w-2xl text-[0.88em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>{it.summary}</p>}
            </li>
          </PfReveal>
        ))}
      </ol>
    </PfSection>
  );
}

export function TestimonialsSection({ data, title }: { data: Record<string, unknown>; title: string }) {
  const items = darr<{ quote: string; author: string; role: string }>(data, "items");
  if (items.length === 0) return null;
  return (
    <PfSection id="pf-sec-testimonials" title={title || "Kind words"}>
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
        {items.map((it, i) => (
          <PfReveal key={i}>
            <PfCard className="h-full p-6">
              <p className="text-[2em] leading-none" style={{ fontFamily: "var(--pf-font-display)", color: "var(--pf-accent)" }} aria-hidden>
                &ldquo;
              </p>
              <blockquote className="mt-2 text-[0.95em] leading-relaxed">{it.quote}</blockquote>
              <footer className="mt-4 text-[0.82em]" style={{ color: "var(--pf-muted)" }}>
                <span className="font-semibold" style={{ color: "var(--pf-text)" }}>{it.author}</span>
                {it.role && <span> · {it.role}</span>}
              </footer>
            </PfCard>
          </PfReveal>
        ))}
      </div>
    </PfSection>
  );
}

export function WritingSection({ data, title }: { data: Record<string, unknown>; title: string }) {
  const items = darr<{ title: string; url: string; year: string }>(data, "items");
  if (items.length === 0) return null;
  return (
    <PfSection id="pf-sec-writing" title={title || "Writing"}>
      <div className="divide-y" style={{ borderColor: "var(--pf-border)" }}>
        {items.map((it, i) => (
          <PfReveal key={i}>
            <a
              href={it.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center justify-between gap-4 py-4 transition-colors"
              style={{ borderColor: "var(--pf-border)" }}
            >
              <div>
                <p className="text-[0.98em] font-medium group-hover:underline">{it.title}</p>
                {it.year && <p className="mt-0.5 text-[0.78em]" style={{ color: "var(--pf-muted)" }}>{it.year}</p>}
              </div>
              <ExternalLink className="size-4 shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" style={{ color: "var(--pf-muted)" }} aria-hidden />
            </a>
          </PfReveal>
        ))}
      </div>
    </PfSection>
  );
}

export function ResumeSection({ data, title }: { data: Record<string, unknown>; title: string }) {
  const mediaId = dnstr(data, "mediaId");
  const note = dstr(data, "note");
  if (!mediaId) return null;
  return (
    <PfSection id="pf-sec-resume" title={title || "Resume"} containerClassName="max-w-3xl">
      <PfReveal>
        <PfCard className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-[calc(var(--pf-radius)*0.6)]" style={{ background: "var(--pf-accent-soft)", color: "var(--pf-accent)" }}>
              <FileText className="size-5" aria-hidden />
            </span>
            <div>
              <p className="text-[0.98em] font-semibold">{note || "Resume"}</p>
              <p className="text-[0.78em]" style={{ color: "var(--pf-muted)" }}>PDF download</p>
            </div>
          </div>
          <PfButton href={`/api/media/${mediaId}/raw`} ariaLabel="Download resume">
            <Download className="size-4" aria-hidden /> Download
          </PfButton>
        </PfCard>
      </PfReveal>
    </PfSection>
  );
}

// ---------------------------------------------------------------- contact

interface InquiryState {
  open: boolean;
  subject: string;
  message: string;
  sending: boolean;
}

export function ContactSection({ ctx, data, title }: { ctx: PfRenderCtx; data: Record<string, unknown>; title: string }) {
  const { owner } = ctx;
  const sub = dstr(data, "sub");
  const email = dstr(data, "email");
  const links = darr<{ label: string; url: string; icon: string }>(data, "links");
  const [state, setState] = useState<InquiryState>({ open: false, subject: "", message: "", sending: false });
  const { interactive } = usePf();

  const iconFor = (icon: string) => {
    switch (icon) {
      case "mail": return <Mail className="size-4" aria-hidden />;
      case "github": return <Github className="size-4" aria-hidden />;
      case "linkedin": return <Linkedin className="size-4" aria-hidden />;
      case "website": return <Globe className="size-4" aria-hidden />;
      default: return <ArrowUpRight className="size-4" aria-hidden />;
    }
  };

  async function send() {
    if (!state.subject.trim() || !state.message.trim()) {
      toast.error("Add a subject and a short message first.");
      return;
    }
    setState((s) => ({ ...s, sending: true }));
    try {
      await api("/api/inquiries", {
        method: "POST",
        json: { recipientUsername: owner.username, type: "INQUIRY", subject: state.subject.trim().slice(0, 160), message: state.message.trim() },
      });
      toast.success("Message sent — it will appear in their Connect inbox.");
      setState({ open: false, subject: "", message: "", sending: false });
    } catch (e) {
      setState((s) => ({ ...s, sending: false }));
      const status = e instanceof Error && "status" in e ? (e as unknown as { status: number }).status : 0;
      if (status === 401) {
        toast.error("Sign in with your free BEAN Folio account to send this message.", {
          action: { label: "Sign in", onClick: () => window.location.assign("#/auth") },
        });
      } else {
        toast.error(e instanceof Error ? e.message : "Could not send the message.");
      }
    }
  }

  return (
    <PfSection id="pf-sec-contact" title={title || "Get in touch"} containerClassName="max-w-3xl">
      <PfReveal>
        <PfCard className="p-6 sm:p-10">
          {sub && <p className="max-w-xl text-[1em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>{sub}</p>}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {interactive ? (
              <PfButton onClick={() => setState({ open: true, subject: "", message: "", sending: false })}>
                <MessageSquare className="size-4" aria-hidden /> Message me
              </PfButton>
            ) : (
              <PfButton onClick={() => toast("Preview: the contact button opens a real message form on your published site.")}>
                <MessageSquare className="size-4" aria-hidden /> Message me
              </PfButton>
            )}
            {email && (
              <PfButton variant="outline" className="pf-btn-outline" href={`mailto:${email}`}>
                <Mail className="size-4" aria-hidden /> {email}
              </PfButton>
            )}
          </div>
          {links.length > 0 && (
            <div className="mt-8 flex flex-wrap gap-2">
              {links.map((l, i) => (
                <a
                  key={i}
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-10 items-center gap-2 rounded-full border px-4 text-[0.85em] font-medium transition-colors"
                  style={{ borderColor: "var(--pf-border)", color: "var(--pf-muted)" }}
                >
                  {iconFor(l.icon)}
                  {l.label}
                </a>
              ))}
            </div>
          )}
          {state.open && (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={`Message ${owner.name}`} onClick={() => !state.sending && setState((s) => ({ ...s, open: false }))}>
              <div
                className="w-full max-w-md rounded-[var(--pf-radius)] border p-6"
                style={{ background: "var(--pf-surface)", borderColor: "var(--pf-border)" }}
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="text-[1.1em] font-semibold" style={{ fontFamily: "var(--pf-font-display)" }}>Message {owner.name}</h3>
                <p className="mt-1 text-[0.8em]" style={{ color: "var(--pf-muted)" }}>
                  Delivered to their BEAN Folio inbox. Sending requires a free account.
                </p>
                <label className="mt-4 block text-[0.8em] font-medium" htmlFor="pf-msg-subject">Subject</label>
                <input
                  id="pf-msg-subject"
                  value={state.subject}
                  onChange={(e) => setState((s) => ({ ...s, subject: e.target.value }))}
                  className="mt-1 w-full rounded-[calc(var(--pf-radius)*0.5)] border bg-transparent px-3 py-2.5 text-[0.9em] outline-none focus:border-[var(--pf-accent)]"
                  style={{ borderColor: "var(--pf-border-strong)", color: "var(--pf-text)" }}
                  maxLength={160}
                />
                <label className="mt-3 block text-[0.8em] font-medium" htmlFor="pf-msg-body">Message</label>
                <textarea
                  id="pf-msg-body"
                  value={state.message}
                  onChange={(e) => setState((s) => ({ ...s, message: e.target.value }))}
                  rows={4}
                  maxLength={4000}
                  className="mt-1 w-full resize-y rounded-[calc(var(--pf-radius)*0.5)] border bg-transparent px-3 py-2.5 text-[0.9em] outline-none focus:border-[var(--pf-accent)]"
                  style={{ borderColor: "var(--pf-border-strong)", color: "var(--pf-text)" }}
                />
                <div className="mt-4 flex justify-end gap-2">
                  <PfButton variant="ghost" onClick={() => setState((s) => ({ ...s, open: false }))}>Cancel</PfButton>
                  <PfButton onClick={() => void send()} ariaLabel="Send message">
                    {state.sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
                    Send
                  </PfButton>
                </div>
              </div>
            </div>
          )}
        </PfCard>
      </PfReveal>
    </PfSection>
  );
}

export function FooterSection({ ctx, data }: { ctx: PfRenderCtx; data: Record<string, unknown> }) {
  const text = dstr(data, "text");
  const availability = dstr(data, "availability");
  return (
    <footer className="w-full border-t" style={{ borderColor: "var(--pf-border)", paddingTop: "calc(var(--pf-secy) * 0.5)", paddingBottom: "calc(var(--pf-secy) * 0.5)" }}>
      <div className="mx-auto flex w-full flex-col items-center justify-between gap-3 px-5 text-center text-[0.8em] sm:flex-row sm:px-8 sm:text-left" style={{ maxWidth: "var(--pf-maxw)", color: "var(--pf-muted)" }}>
        <p>{text || `© ${new Date().getFullYear()} ${ctx.owner.name}`}</p>
        <div className="flex items-center gap-4">
          {availability && (
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="size-3.5" style={{ color: "var(--pf-accent)" }} aria-hidden /> {availability}
            </span>
          )}
          <a href="#/" className="transition-colors hover:underline" style={{ color: "var(--pf-muted)" }}>
            Built with BEAN Folio
          </a>
        </div>
      </div>
    </footer>
  );
}
