"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { PortfolioConfig } from "@/lib/portfolio-schema";
import { cn } from "@/lib/utils";

/**
 * Shared portfolio rendering kit — atoms used by every section/widget so the
 * whole site responds to one theme (colors, radius, type, spacing, motion).
 * All styles are driven by the --pf-* custom properties set on the root.
 */

export interface PfContextValue {
  motionEnabled: boolean;
  entrance: PortfolioConfig["motion"]["entrance"];
  interactive: boolean; // false in studio preview: links are inert
  caseBase: string; // "#/site/<slug>/work"
  aspectClass: string; // card aspect class from layout settings
  pageBase: string; // "#/site/<slug>" or "#/embed/.../<slug>" for internal page links
  pages: { id: string; name: string; slug: string; isHome: boolean; isPublished: boolean }[];
  activePageSlug: string;
  isHome: boolean;
}

export const PfContext = createContext<PfContextValue>({
  motionEnabled: true,
  entrance: "rise",
  interactive: true,
  caseBase: "",
  aspectClass: "aspect-[4/3]",
  pageBase: "",
  pages: [],
  activePageSlug: "home",
  isHome: true,
});

export { mediaUrl, dstr, dnstr, dnum, dbool, darr } from "./theme";

export function usePf() {
  return useContext(PfContext);
}

/** Scroll entrance animation honoring the config + the OS reduced-motion setting. */
export function usePfMotion() {
  const { motionEnabled, entrance } = usePf();
  const reduce = useReducedMotion();
  const on = motionEnabled && entrance !== "none" && !reduce;
  return {
    initial: on ? (entrance === "blur" ? { opacity: 0, filter: "blur(8px)" } : { opacity: 0, y: entrance === "rise" ? 18 : 0 }) : undefined,
    whileInView: on ? { opacity: 1, y: 0, filter: "blur(0px)" } : undefined,
    viewport: { once: true, margin: "-40px" },
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  };
}

export function PfReveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const m = usePfMotion();
  return (
    <motion.div initial={m.initial} whileInView={m.whileInView} viewport={m.viewport} transition={m.transition} className={className}>
      {children}
    </motion.div>
  );
}

export function PfSection({
  id,
  title,
  description,
  children,
  className,
  containerClassName,
}: {
  id?: string;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  containerClassName?: string;
}) {
  return (
    <section id={id} className={cn("w-full", className)} style={{ paddingTop: "var(--pf-secy)", paddingBottom: "var(--pf-secy)" }}>
      <div className={cn("mx-auto w-full px-5 sm:px-8", containerClassName)} style={{ maxWidth: "var(--pf-maxw)" }}>
        {(title || description) && (
          <PfReveal className="mb-8 sm:mb-10">
            {title && (
              <h2
                className="text-[1.6em] font-semibold tracking-tight sm:text-[2em]"
                style={{ fontFamily: "var(--pf-font-display)" }}
                data-pf-field="sectionTitle"
              >
                {title}
              </h2>
            )}
            {description && <p className="mt-2 max-w-2xl text-[0.95em]" style={{ color: "var(--pf-muted)" }}>{description}</p>}
          </PfReveal>
        )}
        {children}
      </div>
    </section>
  );
}

export function PfCard({
  children,
  className,
  hover = false,
  as: As = "div",
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  as?: "div" | "article";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <As
      className={cn("overflow-hidden border", hover && "transition-all duration-300 hover:-translate-y-0.5", className)}
      style={{
        background: "var(--pf-surface)",
        borderColor: "var(--pf-border)",
        borderRadius: "var(--pf-radius)",
        boxShadow: "var(--pf-shadow)",
      }}
      {...rest}
    >
      {children}
    </As>
  );
}

export function PfChip({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.8em] font-medium"
      style={{
        borderColor: active ? "var(--pf-accent-border)" : "var(--pf-border)",
        background: active ? "var(--pf-accent-soft)" : "transparent",
        color: active ? "var(--pf-accent)" : "var(--pf-muted)",
      }}
    >
      {children}
    </span>
  );
}

export function PfButton({
  children,
  onClick,
  href,
  variant = "solid",
  className,
  ariaLabel,
}: {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  href?: string;
  variant?: "solid" | "outline" | "ghost";
  className?: string;
  ariaLabel?: string;
}) {
  const base =
    "inline-flex min-h-11 items-center justify-center gap-2 px-5 py-2.5 text-[0.9em] font-semibold transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-2";
  const styles: React.CSSProperties =
    variant === "solid"
      ? { background: "var(--pf-accent)", color: "var(--pf-bg)" }
      : variant === "outline"
        ? { border: "1px solid var(--pf-border-strong)", color: "var(--pf-text)" }
        : { color: "var(--pf-muted)" };
  const radius = { borderRadius: "calc(var(--pf-radius) * 0.75)" };
  const cls = cn(base, className);
  const hoverCss = (
    <style>{`
      [data-pf] .pf-btn:hover { filter: brightness(1.08); }
      [data-pf] .pf-btn-outline:hover { border-color: var(--pf-accent); color: var(--pf-accent); }
    `}</style>
  );
  if (href !== undefined) {
    return (
      <>
        {hoverCss}
        <a href={href} onClick={onClick} aria-label={ariaLabel} className={cn(cls, "pf-btn")} style={{ ...styles, ...radius }}>
          {children}
        </a>
      </>
    );
  }
  return (
    <>
      {hoverCss}
      <button type="button" onClick={onClick} aria-label={ariaLabel} className={cn(cls, "pf-btn")} style={{ ...styles, ...radius }}>
        {children}
      </button>
    </>
  );
}

/** Lazy, bounded media frame. */
export function PfMedia({
  src,
  alt,
  kind = "IMAGE",
  className,
  style,
}: {
  src: string | null;
  alt: string;
  kind?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  if (!src) return null;
  if (kind === "VIDEO") {
    return <video src={src} controls playsInline preload="metadata" className={cn("h-full w-full object-cover", className)} style={style} />;
  }
  return (
     
    <img src={src} alt={alt} loading="lazy" decoding="async" className={cn("h-full w-full object-cover", className)} style={style} />
  );
}

export function PfEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-[0.72em] font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--pf-accent)" }}>
      {children}
    </p>
  );
}

export function PfEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-[var(--pf-radius)] border border-dashed p-8 text-center text-[0.9em]"
      style={{ borderColor: "var(--pf-border)", color: "var(--pf-muted)" }}
    >
      {children}
    </div>
  );
}

/** Document title/meta description per route (SPA-safe client SEO). */
export function useDocumentMeta(title: string, description?: string, noindex = false) {
  useEffect(() => {
    document.title = title;
    const setMeta = (selector: string, attr: string, value: string, create: () => HTMLMetaElement) => {
      let el = document.head.querySelector<HTMLMetaElement>(selector);
      if (!el) {
        el = create();
        document.head.appendChild(el);
      }
      el.setAttribute(attr, value);
    };
    setMeta('meta[name="description"]', "content", description ?? "Portfolio on BEAN Folio", () => {
      const m = document.createElement("meta");
      m.setAttribute("name", "description");
      return m;
    });
    setMeta('meta[name="robots"]', "content", noindex ? "noindex, nofollow" : "index, follow", () => {
      const m = document.createElement("meta");
      m.setAttribute("name", "robots");
      return m;
    });
  }, [title, description, noindex]);
}

/** usePfScroll — smooth-scroll to an in-page section id. */
export function pfScrollTo(id: string) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}
