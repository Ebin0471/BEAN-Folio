import { z } from "zod";

/**
 * BEAN Folio — Portfolio Studio configuration model.
 *
 * Single source of truth for the portfolio config, shared by:
 * - API validation (PATCH /api/portfolio, publish, import, /api/site/[slug])
 * - The customization studio (PortfolioStudioView)
 * - The renderer (PortfolioSiteView / preview)
 *
 * Content rules enforced by product design (not just schema):
 * - Stats, testimonials, services, experience are USER-PROVIDED. The studio
 *   starts them empty/invisible — the public site never fabricates them.
 * - Projects referenced by id must be the owner's real published projects;
 *   the public site payload resolves them server-side (public+published only).
 */

// ---------------------------------------------------------------- primitives

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const hexColor = z.string().regex(HEX, "Must be a hex color like #E8BC51");
const urlish = z
  .string()
  .trim()
  .max(600)
  .refine((v) => v === "" || /^(https?:\/\/|mailto:|\/)/i.test(v), "Must be an http(s), mailto or / link");

const id = () => z.string().min(1).max(40);

// ---------------------------------------------------------------- theme / layout / motion

export const FONT_PAIRINGS = ["editorial", "modern", "technical", "classic"] as const;
export const HERO_LAYOUTS = ["centered", "split", "cinematic", "portrait", "minimal"] as const;
export const CONTENT_WIDTHS = ["narrow", "regular", "wide"] as const;
export const DENSITIES = ["compact", "regular", "spacious"] as const;
export const CARD_ASPECTS = ["landscape", "square", "cinema", "portrait"] as const;

export const themeSchemaP = z.object({
  mode: z.enum(["dark", "light", "custom"]).default("dark"),
  accent: hexColor.default("#E8BC51"),
  background: hexColor.default("#090A0C"),
  surface: hexColor.default("#17191D"),
  text: hexColor.default("#F7F5EF"),
  muted: hexColor.default("#A5A6A8"),
  fontPairing: z.enum(FONT_PAIRINGS).default("editorial"),
  fontScale: z.number().min(0.85).max(1.25).default(1),
  contentWidth: z.enum(CONTENT_WIDTHS).default("regular"),
  radius: z.number().min(0).max(24).default(12),
  density: z.enum(DENSITIES).default("regular"),
  shadows: z.boolean().default(true),
  glass: z.boolean().default(true),
  grain: z.boolean().default(false),
});

export const layoutSchemaP = z.object({
  nav: z.enum(["top", "sidebar"]).default("top"),
  heroLayout: z.enum(HERO_LAYOUTS).default("centered"),
  projectGrid: z.enum(["grid", "masonry"]).default("grid"),
  cardAspect: z.enum(CARD_ASPECTS).default("landscape"),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  sectionSpacing: z.enum(DENSITIES).default("regular"),
  align: z.enum(["left", "center"]).default("left"),
});

export const motionSchemaP = z.object({
  enabled: z.boolean().default(true),
  entrance: z.enum(["none", "fade", "rise", "blur"]).default("rise"),
});

// ---------------------------------------------------------------- shared items

export const metricItem = z.object({ value: z.string().max(24), label: z.string().max(60) });
export const linkItem = z.object({ label: z.string().min(1).max(60), url: urlish });
export const socialIconEnum = z.enum([
  "website", "mail", "github", "linkedin", "x", "instagram", "youtube", "dribbble", "behance", "medium", "other",
]);

// ---------------------------------------------------------------- hero

export const heroSchemaP = z.object({
  name: z.string().max(80).default(""),
  title: z.string().max(120).default(""),
  intro: z.string().max(400).default(""),
  location: z.string().max(80).default(""),
  availability: z.string().max(80).default(""),
  avatarMediaId: z.string().max(40).nullable().default(null),
  coverMediaId: z.string().max(40).nullable().default(null),
  metrics: z.array(metricItem).max(6).default([]),
  currentProjectId: z.string().max(40).nullable().default(null),
  showCursorGlow: z.boolean().default(false),
  primaryCtaLabel: z.string().max(40).default("View my work"),
  secondaryCtaLabel: z.string().max(40).default("Contact me"),
});

// ---------------------------------------------------------------- section data schemas

export const sectionDataSchemas = {
  current: z.object({
    projectId: z.string().max(40).nullable().default(null),
    note: z.string().max(300).default(""),
  }),
  stats: z.object({ items: z.array(metricItem).max(8).default([]) }),
  services: z.object({
    items: z
      .array(z.object({ title: z.string().min(1).max(80), description: z.string().max(300).default("") }))
      .max(12)
      .default([]),
  }),
  featured: z.object({ projectIds: z.array(id()).max(12).default([]) }),
  gallery: z.object({ filterable: z.boolean().default(true) }),
  about: z.object({ body: z.string().max(6000).default("") }),
  skills: z.object({ items: z.array(z.string().min(1).max(40)).max(40).default([]) }),
  experience: z.object({
    items: z
      .array(
        z.object({
          kind: z.enum(["work", "education"]).default("work"),
          org: z.string().min(1).max(80),
          role: z.string().max(80).default(""),
          period: z.string().max(60).default(""),
          summary: z.string().max(400).default(""),
        })
      )
      .max(25)
      .default([]),
  }),
  testimonials: z.object({
    items: z
      .array(
        z.object({
          quote: z.string().min(1).max(600),
          author: z.string().min(1).max(80),
          role: z.string().max(80).default(""),
        })
      )
      .max(12)
      .default([]),
  }),
  writing: z.object({
    items: z
      .array(
        z.object({
          title: z.string().min(1).max(140),
          url: urlish,
          year: z.string().max(12).default(""),
        })
      )
      .max(20)
      .default([]),
  }),
  resume: z.object({ mediaId: z.string().max(40).nullable().default(null), note: z.string().max(200).default("") }),
  contact: z.object({
    sub: z.string().max(300).default(""),
    email: z.string().max(120).default(""),
    links: z.array(z.object({ label: z.string().min(1).max(60), url: urlish, icon: socialIconEnum.default("other") })).max(12).default([]),
  }),
  footer: z.object({ text: z.string().max(200).default(""), availability: z.string().max(80).default("") }),
} as const;

export type SectionType = keyof typeof sectionDataSchemas;
export const SECTION_TYPES = Object.keys(sectionDataSchemas) as SectionType[];

const sectionSchema: z.ZodType<SectionConfig> = z.lazy(() =>
  z.object({
    id: id(),
    type: z.enum(SECTION_TYPES as [SectionType, ...SectionType[]]),
    visible: z.boolean().default(true),
    title: z.string().max(80).default(""),
    data: z.record(z.string(), z.unknown()).default({}),
  })
) as never;

// ---------------------------------------------------------------- widget data schemas

export const widgetDataSchemas = {
  techStack: z.object({ items: z.array(z.string().min(1).max(40)).max(40).default([]) }),
  githubRepos: z.object({
    items: z
      .array(
        z.object({
          name: z.string().min(1).max(100),
          url: urlish,
          description: z.string().max(300).default(""),
          language: z.string().max(40).default(""),
        })
      )
      .max(12)
      .default([]),
  }),
  featuredVideo: z.object({ mediaId: z.string().max(40).nullable().default(null), caption: z.string().max(200).default("") }),
  imageGallery: z.object({
    items: z.array(z.object({ mediaId: z.string().min(1).max(40), caption: z.string().max(200).default("") })).max(24).default([]),
  }),
  audioPlayer: z.object({
    items: z.array(z.object({ mediaId: z.string().min(1).max(40), title: z.string().max(100).default("") })).max(10).default([]),
  }),
  projectTimeline: z.object({
    items: z
      .array(
        z.object({
          title: z.string().min(1).max(100),
          period: z.string().max(60).default(""),
          note: z.string().max(300).default(""),
          projectId: z.string().max(40).nullable().default(null),
        })
      )
      .max(12)
      .default([]),
  }),
  experienceTimeline: sectionDataSchemas.experience,
  achievements: z.object({
    items: z
      .array(
        z.object({
          title: z.string().min(1).max(120),
          issuer: z.string().max(80).default(""),
          year: z.string().max(12).default(""),
          url: urlish,
        })
      )
      .max(12)
      .default([]),
  }),
  resumeDownload: sectionDataSchemas.resume,
  socialLinks: z.object({ items: z.array(z.object({ label: z.string().min(1).max(60), url: urlish, icon: socialIconEnum.default("other") })).max(12).default([]) }),
  availability: z.object({}),
  testimonials: sectionDataSchemas.testimonials,
  writingFeed: sectionDataSchemas.writing,
  currentProgress: z.object({
    projectId: z.string().max(40).nullable().default(null),
    percent: z.number().min(0).max(100).default(0),
    note: z.string().max(300).default(""),
  }),
  faq: z.object({
    items: z.array(z.object({ q: z.string().min(1).max(200), a: z.string().min(1).max(600) })).max(12).default([]),
  }),
  linkButtons: z.object({ items: z.array(z.object({ label: z.string().min(1).max(40), url: urlish })).max(8).default([]) }),
  stats: z.object({ items: z.array(metricItem).max(8).default([]) }),
  ctaBanner: z.object({ text: z.string().min(1).max(200), buttonLabel: z.string().max(40).default("Get in touch") }),
  codeShowcase: z.object({
    code: z.string().max(4000).default(""),
    language: z.string().max(24).default("ts"),
    caption: z.string().max(140).default(""),
  }),
  beforeAfter: z.object({
    beforeMediaId: z.string().max(40).nullable().default(null),
    afterMediaId: z.string().max(40).nullable().default(null),
    beforeLabel: z.string().max(40).default("Before"),
    afterLabel: z.string().max(40).default("After"),
  }),
  comparison: z.object({
    projectIdA: z.string().max(40).nullable().default(null),
    projectIdB: z.string().max(40).nullable().default(null),
    labelA: z.string().max(40).default(""),
    labelB: z.string().max(40).default(""),
  }),
  demoPreview: z.object({
    url: urlish,
    screenshotMediaId: z.string().max(40).nullable().default(null),
    note: z.string().max(200).default(""),
  }),
  // ---- Code Giftz widget library (v2) ----
  /** Live HTML/CSS/JS demo. Rendered inside a heavily sandboxed iframe
   *  (sandbox="allow-scripts" only + a restrictive CSP in the srcdoc) so the
   *  code can never touch the app, cookies, storage or the network. */
  codeSandbox: z.object({
    html: z.string().max(8000).default(""),
    css: z.string().max(4000).default(""),
    js: z.string().max(4000).default(""),
    note: z.string().max(200).default(""),
    height: z.number().min(120).max(900).default(320),
  }),
  terminalDemo: z.object({
    title: z.string().max(80).default(""),
    lines: z
      .array(z.object({ cmd: z.string().max(200), output: z.string().max(600).default("") }))
      .max(12)
      .default([]),
  }),
  codeCompare: z.object({
    language: z.string().max(24).default("ts"),
    labelA: z.string().max(40).default("Before"),
    labelB: z.string().max(40).default("After"),
    codeA: z.string().max(4000).default(""),
    codeB: z.string().max(4000).default(""),
  }),
  archDiagram: z.object({
    steps: z
      .array(z.object({ title: z.string().min(1).max(60), note: z.string().max(160).default("") }))
      .max(8)
      .default([]),
  }),
  /** Manually entered GitHub numbers — nothing is fetched on the visitor's or
   *  owner's behalf, so the widget can never show fabricated stats. */
  githubSummary: z.object({
    handle: z.string().max(60).default(""),
    profileUrl: urlish,
    items: z.array(z.object({ label: z.string().min(1).max(40), value: z.string().max(24) })).max(8).default([]),
  }),
  /** A link card for an approved external source — screenshot + link, never a
   *  live third-party embed (iframes of external origins are not rendered). */
  embedCard: z.object({
    title: z.string().min(1).max(120),
    url: urlish,
    source: z.string().max(80).default(""),
    screenshotMediaId: z.string().max(40).nullable().default(null),
    note: z.string().max(240).default(""),
  }),
  readmePreview: z.object({
    body: z.string().max(4000).default(""),
    sourceUrl: urlish,
  }),
} as const;

export type WidgetType = keyof typeof widgetDataSchemas;
export const WIDGET_TYPES = Object.keys(widgetDataSchemas) as WidgetType[];

const widgetSchema: z.ZodType<WidgetConfig> = z.lazy(() =>
  z.object({
    id: id(),
    type: z.enum(WIDGET_TYPES as [WidgetType, ...WidgetType[]]),
    visible: z.boolean().default(true),
    title: z.string().max(80).default(""),
    description: z.string().max(240).default(""),
    span: z.enum(["full", "half"]).default("full"),
    /** Render immediately after the section with this id (null = end of page). */
    after: z.string().max(40).nullable().default(null),
    data: z.record(z.string(), z.unknown()).default({}),
  })
) as never;

// ---------------------------------------------------------------- pages (v2)

/**
 * A portfolio PAGE. Config v2 introduced multi-page sites: every page owns its
 * hero (rendered on the home page), sections and widgets; theme/layout/motion
 * stay site-wide. `slug` is the URL segment under #/site/<portfolio-slug>/;
 * the home page is reachable at the bare URL and its slug is always "home".
 */
export const pageSchemaP = z.object({
  id: id(),
  name: z.string().min(1).max(40),
  slug: z.string().max(24).default(""), // "home" for the home page; 3-24 slug chars otherwise
  isHome: z.boolean().default(false),
  inNav: z.boolean().default(true), // show in the site navigation
  isPublished: z.boolean().default(true), // per-page publication (the home page is always published)
  seoTitle: z.string().max(120).default(""),
  seoDescription: z.string().max(300).default(""),
  hero: heroSchemaP.prefault({}),
  sections: z.array(sectionSchema).max(24).default([]),
  widgets: z.array(widgetSchema).max(28).default([]),
});

// ---------------------------------------------------------------- full config

export const themeSchema = themeSchemaP;
export const layoutSchema = layoutSchemaP;
export const motionSchema = motionSchemaP;
export const heroSchema = heroSchemaP;
export const pageSchema = pageSchemaP;

export const portfolioConfigSchema = z.object({
  version: z.literal(2).default(2),
  templateId: z.string().max(40).default("editorial"),
  // prefault: an absent object is itself parsed through the schema so every
  // inner .default() fills in (plain .default({}) would bypass inner defaults).
  theme: themeSchemaP.prefault({}),
  layout: layoutSchemaP.prefault({}),
  motion: motionSchemaP.prefault({}),
  pages: z.array(pageSchemaP).min(1).max(12),
  advanced: z
    .object({
      customCssEnabled: z.boolean().default(false),
      customCss: z.string().max(8000).default(""),
    })
    .prefault({}),
});

export type PortfolioConfig = z.output<typeof portfolioConfigSchema>;
export type PageConfig = z.output<typeof pageSchemaP>;
export type SectionConfig = {
  id: string;
  type: SectionType;
  visible: boolean;
  title: string;
  data: Record<string, unknown>;
};
export type WidgetConfig = {
  id: string;
  type: WidgetType;
  visible: boolean;
  title: string;
  description: string;
  span: "full" | "half";
  after: string | null;
  data: Record<string, unknown>;
};

// ---------------------------------------------------------------- v1 → v2 migration

/**
 * Accept a config from ANY era and return the v2 shape (multi-page). v1
 * configs — hero + sections + widgets at the top level — become a single
 * "Home" page. Unknown shapes pass through untouched and fail zod parsing
 * with the normal messages.
 */
export function migrateConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (r.version === 2 || Array.isArray(r.pages)) return raw;
  const { hero, sections, widgets, ...rest } = r as {
    hero?: unknown;
    sections?: unknown;
    widgets?: unknown;
  };
  return {
    ...rest,
    version: 2,
    pages: [
      {
        id: "page-home",
        name: "Home",
        slug: "home",
        isHome: true,
        inNav: true,
        isPublished: true,
        seoTitle: "",
        seoDescription: "",
        hero: hero ?? {},
        sections: sections ?? [],
        widgets: widgets ?? [],
      },
    ],
  };
}

export const RESERVED_PAGE_SLUGS = new Set(["work"]);

/** 3-24 chars: lowercase letters, numbers, hyphens; must not start/end with a hyphen. */
export function isValidPageSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])?$/.test(slug) && !slug.includes("--");
}

/** The page every visitor lands on (exactly one per config, enforced in parseConfig). */
export function homePage(config: PortfolioConfig): PageConfig {
  return config.pages.find((p) => p.isHome) ?? config.pages[0];
}

export function pageBySlug(config: PortfolioConfig, slug: string): PageConfig | undefined {
  if (!slug || slug === "home") return homePage(config);
  return config.pages.find((p) => !p.isHome && p.slug === slug);
}

/**
 * Validate an arbitrary parsed JSON value as a full config AND normalize every
 * section/widget `data` blob against its type schema (so renderers can trust
 * data shapes). Throws with a human message naming the offending page/section/widget.
 */
export function parseConfig(raw: unknown): PortfolioConfig {
  const config = portfolioConfigSchema.parse(migrateConfig(raw));

  // ---- cross-page normalization + strict rules
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>(["home"]);
  let homeFixed = false;
  for (const page of config.pages) {
    if (seenIds.has(page.id)) throw new Error(`Duplicate page id: ${page.id}`);
    seenIds.add(page.id);
    if (page.isHome && !homeFixed) {
      homeFixed = true;
      page.slug = "home";
      page.isPublished = true; // the home page is the site's front door — always live
    } else {
      page.isHome = false;
      if (!isValidPageSlug(page.slug)) {
        throw new Error(`Page "${page.name}" needs a 3-24 character address (lowercase letters, numbers, hyphens).`);
      }
      if (RESERVED_PAGE_SLUGS.has(page.slug)) {
        throw new Error(`Page address "${page.slug}" is reserved.`);
      }
      if (seenSlugs.has(page.slug)) throw new Error(`Duplicate page address: ${page.slug}`);
      seenSlugs.add(page.slug);
    }
  }
  if (!config.pages.some((p) => p.isHome)) {
    // The schema can't express "exactly one home" — repair instead of throwing:
    // the first page becomes the home page.
    config.pages[0].isHome = true;
    config.pages[0].slug = "home";
    config.pages[0].isPublished = true;
  }

  for (const page of config.pages) {
    for (const sec of page.sections) {
      const schema = sectionDataSchemas[sec.type] as z.ZodType<Record<string, unknown>> | undefined;
      if (!schema) throw new Error(`Unknown section type: ${sec.type}`);
      const r = schema.safeParse(sec.data ?? {});
      if (!r.success) {
        const issue = r.error.issues[0];
        throw new Error(`Section "${sec.title || sec.type}" data invalid — ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "validation failed"}`);
      }
      sec.data = r.data as Record<string, unknown>;
    }
    for (const w of page.widgets) {
      const schema = widgetDataSchemas[w.type] as z.ZodType<Record<string, unknown>> | undefined;
      if (!schema) throw new Error(`Unknown widget type: ${w.type}`);
      const r = schema.safeParse(w.data ?? {});
      if (!r.success) {
        const issue = r.error.issues[0];
        throw new Error(`Widget "${w.title || w.type}" data invalid — ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "validation failed"}`);
      }
      w.data = r.data as Record<string, unknown>;
    }
  }
  return config;
}

/** Non-throwing variant returning a human message on failure. */
export function tryParseConfig(raw: unknown): { ok: true; config: PortfolioConfig } | { ok: false; message: string } {
  try {
    return { ok: true, config: parseConfig(raw) };
  } catch (e) {
    if (e && typeof e === "object" && "issues" in e && Array.isArray((e as { issues: { message: string; path: (string | number)[] }[] }).issues)) {
      const first = (e as { issues: { message: string; path: (string | number)[] }[] }).issues[0];
      return { ok: false, message: `${first?.path?.join(".") ?? "config"}: ${first?.message ?? "invalid"}` };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Invalid configuration" };
  }
}

/** Deep-clone helper (config is plain JSON data). */
export function cloneConfig(config: PortfolioConfig): PortfolioConfig {
  return JSON.parse(JSON.stringify(config)) as PortfolioConfig;
}

// ---------------------------------------------------------------- public site DTOs

export interface SiteProjectCard {
  id: string;
  title: string;
  summary: string | null;
  category: string | null;
  coverUrl: string | null;
  publishedAt: string | null;
  skills: string[];
}

export interface SiteOwner {
  username: string;
  name: string;
  headline: string | null;
  bio: string | null;
  avatarUrl: string | null;
  location: string | null;
  availability: string | null;
  professions: string[];
  skills: string[];
  createdAt: string;
}

export interface SitePageMeta {
  id: string;
  name: string;
  slug: string;
  isHome: boolean;
  inNav: boolean;
  isPublished: boolean;
  seoTitle: string;
  seoDescription: string;
}

export interface SiteResponse {
  slug: string;
  isPublished: boolean;
  publishedAt: string | null;
  isSelf: boolean;
  owner: SiteOwner;
  config: PortfolioConfig;
  /** The pages THIS viewer may see — unpublished pages are stripped server-side for the public. */
  pages: SitePageMeta[];
  projects: SiteProjectCard[];
}
