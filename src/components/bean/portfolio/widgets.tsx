"use client";

import { useState } from "react";
import {
  ArrowUpRight,
  Award,
  Download,
  ExternalLink,
  FileText,
  Github,
  Globe,
  Mail,
  MapPin,
  Music,
  Sparkles,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { WidgetConfig } from "@/lib/portfolio-schema";
import { cn } from "@/lib/utils";
import {
  PfButton,
  PfCard,
  PfChip,
  PfEmpty,
  PfEyebrow,
  PfMedia,
  PfReveal,
  usePf,
  mediaUrl,
  darr,
  dstr,
  dnstr,
  dnum,
} from "./kit";
import { PfProjectCard, useCaseHref, projectById } from "./sections";
import type { PfRenderCtx } from "./sections";

/**
 * Widget library — every widget renders only when enabled AND configured.
 * Data comes from the owner's own configuration (schema-validated); nothing is
 * fetched from third-party services, so no credentials or private data can
 * leak. Widgets render inside a shared shell provided by the renderer.
 */

function WidgetShell({
  title,
  description,
  children,
  wide = true,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn(wide ? "w-full" : "w-full")}>
      {(title || description) && (
        <PfReveal className="mb-6">
          {title && (
            <h3 className="text-[1.25em] font-semibold tracking-tight" style={{ fontFamily: "var(--pf-font-display)" }}>
              {title}
            </h3>
          )}
          {description && <p className="mt-1.5 text-[0.88em]" style={{ color: "var(--pf-muted)" }}>{description}</p>}
        </PfReveal>
      )}
      {children}
    </div>
  );
}

function Grid({ children, cols = 3 }: { children: React.ReactNode; cols?: number }) {
  const map: Record<number, string> = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
  };
  return <div className={cn("grid grid-cols-1 gap-4 sm:gap-6", map[cols] ?? map[3])}>{children}</div>;
}

// ---------------------------------------------------------------- individual widgets

function TechStack({ w }: { w: WidgetConfig }) {
  const items = darr<string>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add technologies in the studio" />;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((s) => (
        <PfChip key={s}>{s}</PfChip>
      ))}
    </div>
  );
}

function GithubRepos({ w }: { w: WidgetConfig }) {
  const items = darr<{ name: string; url: string; description: string; language: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add repositories in the studio" />;
  return (
    <Grid cols={3}>
      {items.map((r, i) => (
        <PfReveal key={i}>
          <PfCard className="h-full p-5">
            <div className="flex items-center justify-between gap-2">
              <Github className="size-4" style={{ color: "var(--pf-accent)" }} aria-hidden />
              <a href={r.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${r.name} on GitHub`} className="transition-opacity hover:opacity-70">
                <ArrowUpRight className="size-4" style={{ color: "var(--pf-muted)" }} aria-hidden />
              </a>
            </div>
            <p className="mt-3 text-[0.95em] font-semibold">{r.name}</p>
            {r.description && <p className="mt-1 text-[0.82em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>{r.description}</p>}
            {r.language && (
              <p className="mt-3 inline-flex items-center gap-1.5 text-[0.75em]" style={{ color: "var(--pf-muted)" }}>
                <span className="size-2 rounded-full" style={{ background: "var(--pf-accent)" }} aria-hidden /> {r.language}
              </p>
            )}
          </PfCard>
        </PfReveal>
      ))}
    </Grid>
  );
}

function FeaturedVideo({ w }: { w: WidgetConfig }) {
  const src = mediaUrl(dnstr(w.data, "mediaId"));
  const caption = dstr(w.data, "caption");
  if (!src) return <EmptyHint label="Upload a video in the studio" />;
  return (
    <PfCard>
      <video src={src} controls playsInline preload="metadata" className="w-full" />
      {caption && <p className="px-5 py-3 text-[0.82em]" style={{ color: "var(--pf-muted)" }}>{caption}</p>}
    </PfCard>
  );
}

function ImageGallery({ w }: { w: WidgetConfig }) {
  const [open, setOpen] = useState<number | null>(null);
  const items = darr<{ mediaId: string; caption: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Upload images in the studio" />;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((it, i) => (
          <Dialog key={i} open={open === i} onOpenChange={(o) => setOpen(o ? i : null)}>
            <DialogTrigger asChild>
              <button
                type="button"
                className="group aspect-square w-full overflow-hidden rounded-[var(--pf-radius)] border focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ borderColor: "var(--pf-border)" }}
                aria-label={`View image ${i + 1}${it.caption ? `: ${it.caption}` : ""}`}
              >
                <PfMedia src={mediaUrl(it.mediaId)} alt={it.caption || `Gallery image ${i + 1}`} className="transition-transform duration-300 group-hover:scale-105" />
              </button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl border-border bg-card p-2">
              <DialogTitle className="sr-only">{it.caption || `Gallery image ${i + 1}`}</DialogTitle>
              { }
              <img src={mediaUrl(it.mediaId) ?? ""} alt={it.caption || `Gallery image ${i + 1}`} className="max-h-[75vh] w-full rounded-lg object-contain" />
              {it.caption && <p className="px-2 pb-1 pt-2 text-sm text-muted-foreground">{it.caption}</p>}
            </DialogContent>
          </Dialog>
        ))}
      </div>
    </>
  );
}

function AudioPlayer({ w }: { w: WidgetConfig }) {
  const items = darr<{ mediaId: string; title: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Upload audio in the studio" />;
  return (
    <div className="space-y-3">
      {items.map((it, i) => (
        <PfCard key={i} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-[calc(var(--pf-radius)*0.6)]" style={{ background: "var(--pf-accent-soft)", color: "var(--pf-accent)" }}>
              <Music className="size-4" aria-hidden />
            </span>
            <p className="text-[0.9em] font-medium">{it.title || `Track ${i + 1}`}</p>
          </div>
          <audio src={mediaUrl(it.mediaId) ?? undefined} controls preload="none" className="h-10 w-full sm:ml-auto sm:max-w-md" />
        </PfCard>
      ))}
    </div>
  );
}

function TimelineList({
  items,
  linkProjectIds,
}: {
  items: { title: string; period?: string; note?: string; kind?: string; role?: string; projectId?: string | null }[];
  linkProjectIds?: boolean;
}) {
  const hrefFor = useCaseHref();
  return (
    <ol className="relative space-y-7 pl-1">
      {items.map((it, i) => {
        const href = linkProjectIds && it.projectId ? hrefFor(it.projectId) : "";
        const body = (
          <>
            <span
              className="absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2"
              style={{ borderColor: "var(--pf-accent)", background: "var(--pf-bg)" }}
              aria-hidden
            />
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h4 className="text-[0.95em] font-semibold">{it.title}</h4>
              {it.period && <span className="text-[0.75em]" style={{ color: "var(--pf-muted)" }}>{it.period}</span>}
            </div>
            {it.role && <p className="mt-0.5 text-[0.82em]" style={{ color: "var(--pf-accent)" }}>{it.role}</p>}
            {it.note && <p className="mt-1 max-w-2xl text-[0.85em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>{it.note}</p>}
          </>
        );
        return (
          <PfReveal key={i}>
            <li className="relative border-l pb-1 pl-6" style={{ borderColor: "var(--pf-border)" }}>
              {href ? <a href={href} className="group block">{body}</a> : body}
            </li>
          </PfReveal>
        );
      })}
    </ol>
  );
}

function ProjectTimeline({ w }: { w: WidgetConfig }) {
  const items = darr<{ title: string; period: string; note: string; projectId: string | null }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add milestones in the studio" />;
  return <TimelineList items={items} linkProjectIds />;
}

function ExperienceTimeline({ w }: { w: WidgetConfig }) {
  const items = darr<{ kind: string; org: string; role: string; period: string; summary: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add experience entries in the studio" />;
  return (
    <TimelineList
      items={items.map((it) => ({ title: it.org, role: it.role, period: it.period, note: it.summary, kind: it.kind }))}
    />
  );
}

function Achievements({ w }: { w: WidgetConfig }) {
  const items = darr<{ title: string; issuer: string; year: string; url: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add achievements in the studio" />;
  return (
    <Grid cols={3}>
      {items.map((a, i) => (
        <PfReveal key={i}>
          <PfCard className="h-full p-5">
            <Award className="size-5" style={{ color: "var(--pf-accent)" }} aria-hidden />
            <p className="mt-3 text-[0.95em] font-semibold leading-snug">{a.title}</p>
            <p className="mt-1 text-[0.78em]" style={{ color: "var(--pf-muted)" }}>
              {[a.issuer, a.year].filter(Boolean).join(" · ")}
            </p>
            {a.url && (
              <a href={a.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-[0.8em] font-medium" style={{ color: "var(--pf-accent)" }}>
                View credential <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </PfCard>
        </PfReveal>
      ))}
    </Grid>
  );
}

function ResumeDownload({ w }: { w: WidgetConfig }) {
  const mediaId = dnstr(w.data, "mediaId");
  const note = dstr(w.data, "note");
  if (!mediaId) return <EmptyHint label="Upload a resume PDF in the studio" />;
  return (
    <PfCard className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
      <div className="flex items-center gap-4">
        <span className="grid size-11 place-items-center rounded-[calc(var(--pf-radius)*0.6)]" style={{ background: "var(--pf-accent-soft)", color: "var(--pf-accent)" }}>
          <FileText className="size-5" aria-hidden />
        </span>
        <div>
          <p className="text-[0.95em] font-semibold">{note || "Resume"}</p>
          <p className="text-[0.75em]" style={{ color: "var(--pf-muted)" }}>PDF download</p>
        </div>
      </div>
      <PfButton href={`/api/media/${mediaId}/raw`} ariaLabel="Download resume">
        <Download className="size-4" aria-hidden /> Download
      </PfButton>
    </PfCard>
  );
}

const SOCIAL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  website: Globe,
  mail: Mail,
  github: Github,
};

function SocialLinks({ w }: { w: WidgetConfig }) {
  const items = darr<{ label: string; url: string; icon: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add links in the studio" />;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((l, i) => {
        const Icon = SOCIAL_ICONS[l.icon] ?? ArrowUpRight;
        return (
          <a
            key={i}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-10 items-center gap-2 rounded-full border px-4 text-[0.85em] font-medium transition-colors hover:opacity-80"
            style={{ borderColor: "var(--pf-border)", color: "var(--pf-muted)" }}
          >
            <Icon className="size-4" />
            {l.label}
          </a>
        );
      })}
    </div>
  );
}

function AvailabilityWidget({ w, ctx }: { w: WidgetConfig; ctx: PfRenderCtx }) {
  const status = ctx.owner.availability || dstr(w.data, "note");
  if (!status) return <EmptyHint label="Set your availability on your BEAN Folio profile" />;
  return (
    <PfCard className="inline-flex items-center gap-3 p-4">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: "var(--pf-accent)" }} />
        <span className="relative inline-flex size-2.5 rounded-full" style={{ background: "var(--pf-accent)" }} />
      </span>
      <p className="text-[0.9em] font-medium">{status}</p>
      {ctx.owner.location && (
        <span className="inline-flex items-center gap-1 text-[0.8em]" style={{ color: "var(--pf-muted)" }}>
          <MapPin className="size-3.5" aria-hidden /> {ctx.owner.location}
        </span>
      )}
    </PfCard>
  );
}

function TestimonialsWidget({ w }: { w: WidgetConfig }) {
  const items = darr<{ quote: string; author: string; role: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add testimonials in the studio" />;
  return (
    <Grid cols={2}>
      {items.map((t, i) => (
        <PfReveal key={i}>
          <PfCard className="h-full p-6">
            <p className="text-[2em] leading-none" style={{ fontFamily: "var(--pf-font-display)", color: "var(--pf-accent)" }} aria-hidden>
              &ldquo;
            </p>
            <blockquote className="mt-2 text-[0.92em] leading-relaxed">{t.quote}</blockquote>
            <footer className="mt-4 text-[0.8em]" style={{ color: "var(--pf-muted)" }}>
              <span className="font-semibold" style={{ color: "var(--pf-text)" }}>{t.author}</span>
              {t.role && <span> · {t.role}</span>}
            </footer>
          </PfCard>
        </PfReveal>
      ))}
    </Grid>
  );
}

function WritingFeed({ w }: { w: WidgetConfig }) {
  const items = darr<{ title: string; url: string; year: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add articles in the studio" />;
  return (
    <div className="divide-y" style={{ borderColor: "var(--pf-border)" }}>
      {items.map((it, i) => (
        <a key={i} href={it.url} target="_blank" rel="noopener noreferrer" className="group flex items-center justify-between gap-4 py-3.5">
          <div>
            <p className="text-[0.95em] font-medium group-hover:underline">{it.title}</p>
            {it.year && <p className="mt-0.5 text-[0.75em]" style={{ color: "var(--pf-muted)" }}>{it.year}</p>}
          </div>
          <ExternalLink className="size-4 shrink-0" style={{ color: "var(--pf-muted)" }} aria-hidden />
        </a>
      ))}
    </div>
  );
}

function CurrentProgress({ w, ctx }: { w: WidgetConfig; ctx: PfRenderCtx }) {
  const project = projectById(ctx.projects, dnstr(w.data, "projectId") ?? ctx.hero.currentProjectId);
  const percent = dnum(w.data, "percent");
  const note = dstr(w.data, "note");
  if (!project && !note) return <EmptyHint label="Pick your current project in the studio" />;
  return (
    <PfCard className="p-6">
      {project && (
        <p className="text-[0.95em] font-semibold">
          {project.title}
        </p>
      )}
      {note && <p className="mt-1 text-[0.85em]" style={{ color: "var(--pf-muted)" }}>{note}</p>}
      <div
        className="mt-4 h-2 w-full overflow-hidden rounded-full"
        style={{ background: "color-mix(in srgb, var(--pf-text) 8%, transparent)" }}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Current project progress"
      >
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(2, Math.min(100, percent))}%`, background: "var(--pf-accent)" }} />
      </div>
      <p className="mt-2 text-[0.75em]" style={{ color: "var(--pf-muted)" }}>{percent}% complete</p>
    </PfCard>
  );
}

function Faq({ w }: { w: WidgetConfig }) {
  const items = darr<{ q: string; a: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add questions in the studio" />;
  return (
    <div className="divide-y rounded-[var(--pf-radius)] border" style={{ borderColor: "var(--pf-border)", background: "var(--pf-surface)" }}>
      {items.map((it, i) => (
        <details key={i} className="group px-5">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-3.5 text-[0.92em] font-medium [&::-webkit-details-marker]:hidden">
            {it.q}
            <span className="text-[1.1em] leading-none transition-transform group-open:rotate-45" style={{ color: "var(--pf-accent)" }} aria-hidden>
              +
            </span>
          </summary>
          <p className="pb-4 text-[0.85em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>
            {it.a}
          </p>
        </details>
      ))}
    </div>
  );
}

function LinkButtons({ w }: { w: WidgetConfig }) {
  const items = darr<{ label: string; url: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add link buttons in the studio" />;
  return (
    <div className="flex flex-wrap gap-3">
      {items.map((l, i) => (
        <PfButton key={i} href={l.url} variant={i === 0 ? "solid" : "outline"} className={i !== 0 ? "pf-btn-outline" : undefined}>
          {l.label}
        </PfButton>
      ))}
    </div>
  );
}

function StatsWidget({ w }: { w: WidgetConfig }) {
  const items = darr<{ value: string; label: string }>(w.data, "items");
  if (items.length === 0) return <EmptyHint label="Add statistics in the studio" />;
  return (
    <Grid cols={4}>
      {items.map((it, i) => (
        <PfReveal key={i}>
          <PfCard className="p-5 text-center sm:p-6">
            <p className="text-[1.8em] font-semibold leading-none" style={{ fontFamily: "var(--pf-font-display)", color: "var(--pf-accent)" }}>
              {it.value}
            </p>
            <p className="mt-2 text-[0.78em]" style={{ color: "var(--pf-muted)" }}>{it.label}</p>
          </PfCard>
        </PfReveal>
      ))}
    </Grid>
  );
}

function CtaBanner({ w }: { w: WidgetConfig }) {
  const text = dstr(w.data, "text");
  const label = dstr(w.data, "buttonLabel") || "Get in touch";
  if (!text) return <EmptyHint label="Add banner text in the studio" />;
  return (
    <PfCard className="flex flex-col items-start gap-4 border p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8" style={undefined}>
      <p className="max-w-xl text-[1.05em] font-medium" style={{ fontFamily: "var(--pf-font-display)" }}>
        {text}
      </p>
      <PfButton
        onClick={() => document.getElementById("pf-sec-contact")?.scrollIntoView({ behavior: "smooth" })}
      >
        {label}
      </PfButton>
    </PfCard>
  );
}

function CodeShowcase({ w }: { w: WidgetConfig }) {
  const code = dstr(w.data, "code");
  const language = dstr(w.data, "language") || "ts";
  const caption = dstr(w.data, "caption");
  if (!code.trim()) return <EmptyHint label="Add a code snippet in the studio" />;
  return (
    <PfCard className="relative">
      <CopyCodeButton code={code} />
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{ margin: 0, borderRadius: "var(--pf-radius)", background: "transparent", fontSize: "0.85em" }}
      >
        {code}
      </SyntaxHighlighter>
      {caption && <p className="px-5 py-3 text-[0.78em]" style={{ color: "var(--pf-muted)" }}>{caption}</p>}
    </PfCard>
  );
}

function BeforeAfter({ w }: { w: WidgetConfig }) {
  const [pos, setPos] = useState(50);
  const before = mediaUrl(dnstr(w.data, "beforeMediaId"));
  const after = mediaUrl(dnstr(w.data, "afterMediaId"));
  if (!before || !after) return <EmptyHint label="Upload before/after images in the studio" />;
  return (
    <PfCard className="overflow-hidden">
      <div className="relative aspect-[16/9] w-full select-none" style={{ ["--pos" as string]: `${pos}%` }}>
        { }
        <img src={after} alt={dstr(w.data, "afterLabel") || "After"} className="absolute inset-0 h-full w-full object-cover" draggable={false} />
        <div className="absolute inset-0 overflow-hidden" style={{ width: `${pos}%` }}>
          <img src={before} alt={dstr(w.data, "beforeLabel") || "Before"} className="absolute inset-0 h-full w-full object-cover" style={{ width: "100%" }} draggable={false} />
        </div>
        { }
        <div className="absolute inset-y-0 w-0.5" style={{ left: `${pos}%`, background: "var(--pf-accent)" }} aria-hidden />
        <span className="absolute left-3 top-3 rounded-full px-2.5 py-1 text-[0.7em] font-semibold" style={{ background: "var(--pf-accent)", color: "var(--pf-bg)" }}>
          {dstr(w.data, "beforeLabel") || "Before"}
        </span>
        <span className="absolute right-3 top-3 rounded-full border px-2.5 py-1 text-[0.7em] font-semibold" style={{ borderColor: "var(--pf-border-strong)", background: "var(--pf-bg)", color: "var(--pf-text)" }}>
          {dstr(w.data, "afterLabel") || "After"}
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          className="absolute inset-x-0 bottom-3 mx-auto w-[85%] accent-[var(--pf-accent)]"
          aria-label="Drag to compare before and after"
        />
      </div>
    </PfCard>
  );
}

function Comparison({ w, ctx }: { w: WidgetConfig; ctx: PfRenderCtx }) {
  const a = projectById(ctx.projects, dnstr(w.data, "projectIdA"));
  const b = projectById(ctx.projects, dnstr(w.data, "projectIdB"));
  if (!a && !b) return <EmptyHint label="Pick two projects to compare in the studio" />;
  const labelA = dstr(w.data, "labelA");
  const labelB = dstr(w.data, "labelB");
  return (
    <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
      {[
        { p: a, label: labelA },
        { p: b, label: labelB },
      ].map(({ p, label }, i) => (
        <div key={i}>
          {label && <PfEyebrow>{label}</PfEyebrow>}
          {p ? <PfProjectCard project={p} index={i} /> : <EmptyHint label="Pick a project in the studio" />}
        </div>
      ))}
    </div>
  );
}

function DemoPreview({ w }: { w: WidgetConfig }) {
  const url = dstr(w.data, "url");
  const shot = mediaUrl(dnstr(w.data, "screenshotMediaId"));
  const note = dstr(w.data, "note");
  if (!url && !shot) return <EmptyHint label="Add a live demo URL in the studio" />;
  return (
    <PfCard className="overflow-hidden">
      {shot && (
        <div className="aspect-video w-full border-b" style={{ borderColor: "var(--pf-border)" }}>
          <PfMedia src={shot} alt={note || "Live demo preview"} />
        </div>
      )}
      <div className="flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-[0.95em] font-semibold">{note || "Live demo"}</p>
          {url && <p className="truncate text-[0.78em]" style={{ color: "var(--pf-muted)" }}>{url}</p>}
        </div>
        {url && (
          <PfButton href={url} variant="outline" className="pf-btn-outline" ariaLabel="Open live demo in a new tab">
            <ExternalLink className="size-4" aria-hidden /> Visit demo
          </PfButton>
        )}
      </div>
    </PfCard>
  );
}

function EmptyHint({ label }: { label: string }) {
  // Studio preview: an honest "not configured yet" hint. Public site: an
  // unconfigured widget is invisible — never rendered, never hinted.
  const { interactive } = usePf();
  if (interactive) return null;
  return (
    <div className="rounded-[var(--pf-radius)] border border-dashed p-6 text-center text-[0.85em]" style={{ borderColor: "var(--pf-border)", color: "var(--pf-muted)" }}>
      {label} — this widget is hidden from visitors until then.
    </div>
  );
}

// ---------------------------------------------------------------- Code Giftz widgets (v2)

/** Copy-to-clipboard control shared by code widgets. */
function CopyCodeButton({ code, label = "Copy code" }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="pf-copy-btn absolute right-3 top-3 z-10 rounded-md border px-2.5 py-1 text-[0.7em] font-medium transition-colors"
      style={{ borderColor: "var(--pf-border-strong)", background: "var(--pf-bg)", color: "var(--pf-muted)" }}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard unavailable — the user can select the text manually */
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Tiny markdown-ish renderer for the README preview. React escapes all text;
 *  links are restricted to http(s) and get rel=noopener. No raw HTML passthrough. */
function renderMiniMarkdown(text: string): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  let list: string[] = [];
  let para: string[] = [];
  let key = 0;
  const inline = (s: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\((?:https?:\/\/)[^\s)]+\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith("**")) parts.push(<strong key={`b${key++}`}>{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith("`")) parts.push(<code key={`c${key++}`} className="rounded px-1 py-0.5 text-[0.9em]" style={{ background: "var(--pf-accent-soft)", color: "var(--pf-accent)" }}>{tok.slice(1, -1)}</code>);
      else {
        const mm = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(tok);
        if (mm) {
          parts.push(
            <a key={`l${key++}`} href={mm[2]} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "var(--pf-accent)" }}>
              {mm[1]}
            </a>
          );
        }
      }
      last = m.index + tok.length;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
  };
  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={`p${key++}`} className="text-[0.92em] leading-relaxed" style={{ color: "var(--pf-muted)" }}>{inline(para.join(" "))}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(
        <ul key={`u${key++}`} className="ml-5 list-disc space-y-1 text-[0.92em]" style={{ color: "var(--pf-muted)" }}>
          {list.map((li, i) => <li key={i}>{inline(li)}</li>)}
        </ul>
      );
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,3}\s/.test(line)) {
      flushPara();
      flushList();
      const level = line.match(/^#+/)![0].length;
      blocks.push(
        <p key={`h${key++}`} className={cn("font-semibold tracking-tight", level === 1 ? "text-[1.15em]" : level === 2 ? "text-[1.02em]" : "text-[0.92em]")} style={{ color: "var(--pf-text)", fontFamily: "var(--pf-font-display)" }}>
          {inline(line.replace(/^#+\s*/, ""))}
        </p>
      );
    } else if (/^[-*]\s/.test(line)) {
      flushPara();
      list.push(line.replace(/^[-*]\s*/, ""));
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

/**
 * Live HTML/CSS/JS demo — executed ONLY inside a sandboxed iframe with an
 * opaque origin (sandbox="allow-scripts", no allow-same-origin) and a
 * content-security-policy that allows inline code but blocks every network
 * request, cookie, storage API and same-origin access. The code can paint and
 * compute; it cannot leave the box.
 */
function CodeSandbox({ w }: { w: WidgetConfig }) {
  const html = dstr(w.data, "html");
  const css = dstr(w.data, "css");
  const js = dstr(w.data, "js");
  const note = dstr(w.data, "note");
  const height = dnum(w.data, "height") || 320;
  if (!html.trim() && !css.trim() && !js.trim()) return <EmptyHint label="Add HTML, CSS or JS in the studio" />;
  // Restrictive CSP inside the sandbox: inline code allowed, everything else
  // (network, framing, forms, navigation) denied.
  const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:;";
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>html,body{margin:0;padding:12px;font-family:ui-sans-serif,system-ui,sans-serif;background:transparent;color:#111}${css}</style></head><body>${html}<script>try{${js}\n}catch(e){document.body.insertAdjacentHTML("beforeend","<pre style=\\"color:#b00;white-space:pre-wrap\\">"+String(e)+"</pre>")}<\/script></body></html>`;
  return (
    <PfCard className="overflow-hidden">
      <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--pf-border)" }}>
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-red-400/80" />
          <span className="size-2.5 rounded-full bg-yellow-400/80" />
          <span className="size-2.5 rounded-full bg-green-400/80" />
        </span>
        <span className="text-[0.72em] font-medium uppercase tracking-wider" style={{ color: "var(--pf-muted)" }}>
          Live demo — sandboxed
        </span>
      </div>
      <iframe
        title={w.title || "Live code demo"}
        sandbox="allow-scripts"
        srcDoc={doc}
        className="w-full border-0 bg-white"
        style={{ height }}
      />
      {note && <p className="px-5 py-3 text-[0.78em]" style={{ color: "var(--pf-muted)" }}>{note}</p>}
    </PfCard>
  );
}

/** Terminal-style demonstration of commands and their output. */
function TerminalDemo({ w }: { w: WidgetConfig }) {
  const lines = darr<{ cmd: string; output: string }>(w.data, "lines");
  const title = dstr(w.data, "title") || "terminal";
  if (lines.length === 0) return <EmptyHint label="Add terminal commands in the studio" />;
  return (
    <PfCard className="overflow-hidden">
      <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--pf-border)", background: "color-mix(in srgb, var(--pf-bg) 55%, black)" }}>
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-red-400/80" />
          <span className="size-2.5 rounded-full bg-yellow-400/80" />
          <span className="size-2.5 rounded-full bg-green-400/80" />
        </span>
        <span className="font-mono text-[0.72em]" style={{ color: "var(--pf-muted)" }}>{title}</span>
      </div>
      <div className="space-y-1.5 overflow-x-auto p-4 font-mono text-[0.8em] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i}>
            {l.cmd && (
              <p className="whitespace-pre-wrap">
                <span style={{ color: "var(--pf-accent)" }}>$ </span>
                <span style={{ color: "var(--pf-text)" }}>{l.cmd}</span>
              </p>
            )}
            {l.output && <p className="whitespace-pre-wrap opacity-80" style={{ color: "var(--pf-muted)" }}>{l.output}</p>}
          </div>
        ))}
      </div>
    </PfCard>
  );
}

/** Two code versions side by side (refactor / before-and-after). */
function CodeCompare({ w }: { w: WidgetConfig }) {
  const codeA = dstr(w.data, "codeA");
  const codeB = dstr(w.data, "codeB");
  const language = dstr(w.data, "language") || "ts";
  if (!codeA.trim() && !codeB.trim()) return <EmptyHint label="Add the two code versions in the studio" />;
  const pane = (code: string, label: string, key: string) => (
    <div key={key} className="relative min-w-0">
      <div className="relative">
        <CopyCodeButton code={code} label={`Copy ${label}`} />
        <p className="border-b px-4 py-2 text-[0.72em] font-semibold uppercase tracking-wider" style={{ borderColor: "var(--pf-border)", color: "var(--pf-accent)" }}>{label}</p>
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          wrapLongLines
          customStyle={{ margin: 0, borderRadius: 0, background: "transparent", fontSize: "0.8em" }}
        >
          {code || "// (empty)"}
        </SyntaxHighlighter>
      </div>
    </div>
  );
  return (
    <PfCard className="overflow-hidden">
      <div className="grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0" style={{ borderColor: "var(--pf-border)" }}>
        {pane(codeA, dstr(w.data, "labelA") || "Before", "a")}
        {pane(codeB, dstr(w.data, "labelB") || "After", "b")}
      </div>
    </PfCard>
  );
}

/** Architecture / pipeline diagram from ordered steps. */
function ArchDiagram({ w }: { w: WidgetConfig }) {
  const steps = darr<{ title: string; note: string }>(w.data, "steps");
  if (steps.length === 0) return <EmptyHint label="Add the pipeline steps in the studio" />;
  return (
    <PfCard>
      <ol className="flex flex-col gap-0 p-5 sm:flex-row sm:items-stretch sm:gap-2">
        {steps.map((s, i) => (
          <li key={i} className="flex min-w-0 flex-1 items-start gap-2 sm:flex-col sm:items-stretch sm:text-center">
            <div className="min-w-0 flex-1 rounded-[calc(var(--pf-radius)*0.8)] border p-3.5" style={{ borderColor: "var(--pf-border)", background: "var(--pf-bg)" }}>
              <p className="text-[0.72em] font-bold" style={{ color: "var(--pf-accent)" }}>{String(i + 1).padStart(2, "0")}</p>
              <p className="mt-1 text-[0.86em] font-semibold" style={{ color: "var(--pf-text)" }}>{s.title}</p>
              {s.note && <p className="mt-1 text-[0.76em]" style={{ color: "var(--pf-muted)" }}>{s.note}</p>}
            </div>
            {i < steps.length - 1 && (
              <span className="mt-4 shrink-0 font-mono text-lg sm:mt-5 sm:mx-auto" style={{ color: "var(--pf-accent)" }} aria-hidden>
                {i % 2 === 0 ? "→" : "→"}
              </span>
            )}
          </li>
        ))}
      </ol>
    </PfCard>
  );
}

/** GitHub numbers entered by the owner — explicitly labeled as manual so the
 *  widget can never imply live, fetched statistics. */
function GithubSummary({ w }: { w: WidgetConfig }) {
  const items = darr<{ label: string; value: string }>(w.data, "items");
  const handle = dstr(w.data, "handle");
  const url = dnstr(w.data, "profileUrl");
  if (items.length === 0 && !handle) return <EmptyHint label="Add your GitHub numbers in the studio" />;
  return (
    <PfCard>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--pf-border)" }}>
        <p className="flex items-center gap-2 text-[0.95em] font-semibold">
          <Github className="size-4" aria-hidden />
          {handle ? `@${handle.replace(/^@/, "")}` : "GitHub"}
        </p>
        <span className="text-[0.7em] uppercase tracking-wider" style={{ color: "var(--pf-muted)" }}>figures entered manually</span>
      </div>
      <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
        {items.map((it, i) => (
          <div key={i} className="rounded-[calc(var(--pf-radius)*0.8)] border p-3" style={{ borderColor: "var(--pf-border)" }}>
            <p className="font-display text-xl font-semibold" style={{ color: "var(--pf-accent)" }}>{it.value}</p>
            <p className="mt-0.5 text-[0.74em]" style={{ color: "var(--pf-muted)" }}>{it.label}</p>
          </div>
        ))}
      </div>
      {url && (
        <div className="px-5 pb-5">
          <PfButton href={url} variant="outline" className="pf-btn-outline">
            View profile <ArrowUpRight className="size-3.5" aria-hidden />
          </PfButton>
        </div>
      )}
    </PfCard>
  );
}

/** A link card for an approved external source — screenshot + link. External
 *  pages are NEVER embedded live (no third-party iframes on the site). */
function EmbedCard({ w }: { w: WidgetConfig }) {
  const title = dstr(w.data, "title");
  const url = dnstr(w.data, "url");
  const shot = mediaUrl(dnstr(w.data, "screenshotMediaId"));
  if (!title && !url) return <EmptyHint label="Add a title and link in the studio" />;
  let host = "";
  try {
    host = url ? new URL(url).host : "";
  } catch {
    host = "";
  }
  return (
    <PfCard className="overflow-hidden">
      {shot && (
        <img src={shot} alt={`Screenshot of ${title}`} loading="lazy" decoding="async" className="aspect-[16/9] w-full object-cover" />
      )}
      <div className="p-5">
        <p className="text-[1em] font-semibold">{title}</p>
        {dstr(w.data, "note") && <p className="mt-1.5 text-[0.85em]" style={{ color: "var(--pf-muted)" }}>{dstr(w.data, "note")}</p>}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-[0.85em] font-medium transition-opacity hover:opacity-80"
            style={{ color: "var(--pf-accent)" }}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {host || url}
          </a>
        )}
        {dstr(w.data, "source") && <p className="mt-2 text-[0.72em]" style={{ color: "var(--pf-muted)" }}>Source: {dstr(w.data, "source")}</p>}
      </div>
    </PfCard>
  );
}

/** README-style document block with a link back to the full source. */
function ReadmePreview({ w }: { w: WidgetConfig }) {
  const body = dstr(w.data, "body");
  const sourceUrl = dnstr(w.data, "sourceUrl");
  if (!body.trim()) return <EmptyHint label="Add README content in the studio" />;
  return (
    <PfCard>
      <div className="space-y-3 p-5">
        <div className="flex items-center gap-2 border-b pb-3" style={{ borderColor: "var(--pf-border)" }}>
          <FileText className="size-4" style={{ color: "var(--pf-accent)" }} aria-hidden />
          <span className="text-[0.85em] font-semibold">README</span>
        </div>
        <div className="space-y-3">{renderMiniMarkdown(body)}</div>
        {sourceUrl && (
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 pt-1 text-[0.82em] font-medium" style={{ color: "var(--pf-accent)" }}>
            <ArrowUpRight className="size-3.5" aria-hidden /> Read the full document
          </a>
        )}
      </div>
    </PfCard>
  );
}

// ---------------------------------------------------------------- registry

export const WIDGET_LABELS: Record<WidgetConfig["type"], string> = {
  techStack: "Technology stack",
  githubRepos: "GitHub repositories",
  featuredVideo: "Featured video",
  imageGallery: "Image gallery",
  audioPlayer: "Audio player",
  projectTimeline: "Project timeline",
  experienceTimeline: "Experience timeline",
  achievements: "Achievements",
  resumeDownload: "Resume download",
  socialLinks: "Social links",
  availability: "Availability indicator",
  testimonials: "Testimonials",
  writingFeed: "Writing feed",
  currentProgress: "Current project progress",
  faq: "FAQ",
  linkButtons: "Link buttons",
  stats: "Statistics",
  ctaBanner: "Call-to-action banner",
  codeShowcase: "Code snippet",
  beforeAfter: "Before & after",
  comparison: "Project comparison",
  demoPreview: "Live demo preview",
  codeSandbox: "Live code sandbox",
  terminalDemo: "Terminal demo",
  codeCompare: "Code comparison",
  archDiagram: "Architecture diagram",
  githubSummary: "GitHub summary",
  embedCard: "Source embed card",
  readmePreview: "README preview",
};

export function WidgetRenderer({ w, ctx }: { w: WidgetConfig; ctx: PfRenderCtx }) {
  switch (w.type) {
    case "techStack": return <TechStack w={w} />;
    case "githubRepos": return <GithubRepos w={w} />;
    case "featuredVideo": return <FeaturedVideo w={w} />;
    case "imageGallery": return <ImageGallery w={w} />;
    case "audioPlayer": return <AudioPlayer w={w} />;
    case "projectTimeline": return <ProjectTimeline w={w} />;
    case "experienceTimeline": return <ExperienceTimeline w={w} />;
    case "achievements": return <Achievements w={w} />;
    case "resumeDownload": return <ResumeDownload w={w} />;
    case "socialLinks": return <SocialLinks w={w} />;
    case "availability": return <AvailabilityWidget w={w} ctx={ctx} />;
    case "testimonials": return <TestimonialsWidget w={w} />;
    case "writingFeed": return <WritingFeed w={w} />;
    case "currentProgress": return <CurrentProgress w={w} ctx={ctx} />;
    case "faq": return <Faq w={w} />;
    case "linkButtons": return <LinkButtons w={w} />;
    case "stats": return <StatsWidget w={w} />;
    case "ctaBanner": return <CtaBanner w={w} />;
    case "codeShowcase": return <CodeShowcase w={w} />;
    case "beforeAfter": return <BeforeAfter w={w} />;
    case "comparison": return <Comparison w={w} ctx={ctx} />;
    case "demoPreview": return <DemoPreview w={w} />;
    case "codeSandbox": return <CodeSandbox w={w} />;
    case "terminalDemo": return <TerminalDemo w={w} />;
    case "codeCompare": return <CodeCompare w={w} />;
    case "archDiagram": return <ArchDiagram w={w} />;
    case "githubSummary": return <GithubSummary w={w} />;
    case "embedCard": return <EmbedCard w={w} />;
    case "readmePreview": return <ReadmePreview w={w} />;
    default: return null;
  }
}

/** True when a widget has real content — unconfigured widgets never render on the public site. */
export function isWidgetConfigured(w: WidgetConfig): boolean {
  const has = (key: string) => {
    const v = w.data[key];
    return typeof v === "string" ? v.trim().length > 0 : Boolean(v);
  };
  const items = (key: string) => Array.isArray(w.data[key]) && (w.data[key] as unknown[]).length > 0;
  switch (w.type) {
    case "techStack":
    case "githubRepos":
    case "imageGallery":
    case "audioPlayer":
    case "projectTimeline":
    case "achievements":
    case "socialLinks":
    case "testimonials":
    case "writingFeed":
    case "faq":
    case "linkButtons":
    case "stats":
    case "experienceTimeline":
      return items("items");
    case "featuredVideo":
    case "resumeDownload":
    case "beforeAfter":
      return Boolean(w.data.mediaId) || Boolean(w.data.beforeMediaId && w.data.afterMediaId);
    case "currentProgress":
      return Boolean(w.data.projectId) || has("note");
    case "availability":
      return true; // fed from the owner's profile; block renders nothing if profile is empty
    case "ctaBanner":
      return has("text");
    case "codeShowcase":
      return has("code");
    case "comparison":
      return Boolean(w.data.projectIdA || w.data.projectIdB);
    case "demoPreview":
      return has("url") || Boolean(w.data.screenshotMediaId);
    case "codeSandbox":
      return has("html") || has("css") || has("js");
    case "terminalDemo":
      return items("lines");
    case "codeCompare":
      return has("codeA") || has("codeB");
    case "archDiagram":
      return items("steps");
    case "githubSummary":
      return items("items") || has("handle");
    case "embedCard":
      return has("title") || has("url");
    case "readmePreview":
      return has("body");
    default:
      return false;
  }
}

export function WidgetBlock({ w, ctx }: { w: WidgetConfig; ctx: PfRenderCtx }) {
  const { interactive } = usePf();
  // Public rule: enabled AND configured only. Availability depends on profile data.
  const configured = w.type === "availability" ? Boolean(ctx.owner.availability) || !interactive : isWidgetConfigured(w) || !interactive;
  if (interactive && !configured) return null;
  return (
    <div id={`pf-widget-${w.id}`} className="w-full" style={{ paddingBottom: "calc(var(--pf-secy) * 0.45)" }}>
      <WidgetShell title={w.title} description={w.description} wide={w.span === "full"}>
        <WidgetRenderer w={w} ctx={ctx} />
      </WidgetShell>
    </div>
  );
}
