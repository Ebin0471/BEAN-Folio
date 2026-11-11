import type { PortfolioConfig, PageConfig, SectionConfig, WidgetConfig } from "@/lib/portfolio-schema";

/**
 * Build the starting portfolio configuration from a user's REAL profile and
 * REAL published projects. Sections without real content are created hidden —
 * the public site never fabricates testimonials, stats or credentials, and the
 * studio shows them as "empty — hidden from visitors" until the owner fills
 * them in.
 *
 * v2: the config is multi-page. The seed is a single Home page; extra pages
 * are created in the studio.
 */

export interface DefaultSeedUser {
  name: string;
  username: string | null;
  headline: string | null;
  bio: string | null;
  location: string | null;
  availability: string | null;
  avatarMediaId: string | null;
  coverMediaId: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
  skills: string[];
  professions: string[];
}

export interface DefaultSeedProject {
  id: string;
  title: string;
  summary: string | null;
  category: string | null;
  coverMediaId: string | null;
}

let uid = 0;
function newId(prefix: string): string {
  uid += 1;
  return `${prefix}-${Date.now().toString(36)}${uid.toString(36)}`;
}

function section(
  type: SectionConfig["type"],
  title: string,
  data: Record<string, unknown>,
  visible: boolean
): SectionConfig {
  return { id: newId("sec"), type, title, data, visible };
}

export function buildDefaultConfig(user: DefaultSeedUser, projects: DefaultSeedProject[]): PortfolioConfig {
  const skills = [...user.skills];
  const projectIds = projects.map((p) => p.id);
  const hasProjects = projectIds.length > 0;

  const sections: SectionConfig[] = [
    section("current", "Currently", { projectId: null, note: "" }, true),
    section("stats", "By the numbers", { items: [] }, false),
    section("services", "What I do", { items: [] }, false),
    section("featured", "Featured work", { projectIds: projectIds.slice(0, 3) }, hasProjects),
    section("gallery", "Selected work", { filterable: true }, hasProjects),
    section("about", "About", { body: user.bio ?? "" }, Boolean(user.bio)),
    section("skills", "Skills & tools", { items: skills }, skills.length > 0),
    section("experience", "Experience", { items: [] }, false),
    section("testimonials", "Kind words", { items: [] }, false),
    section("writing", "Writing", { items: [] }, false),
    section("resume", "Resume", { mediaId: null, note: "" }, false),
    section("contact", "Contact", {
      sub: "",
      email: user.contactEmail ?? "",
      links: [
        ...(user.websiteUrl ? [{ label: "Website", url: user.websiteUrl, icon: "website" }] : []),
      ],
    }, true),
    section("footer", "Footer", { text: `© ${new Date().getFullYear()} ${user.name}`, availability: user.availability ?? "" }, true),
  ];

  const widgets: WidgetConfig[] = [];

  const home: PageConfig = {
    id: newId("page"),
    name: "Home",
    slug: "home",
    isHome: true,
    inNav: true,
    isPublished: true,
    seoTitle: "",
    seoDescription: "",
    hero: {
      name: user.name,
      title: user.headline ?? user.professions[0] ?? "",
      intro: user.bio ? user.bio.split("\n")[0].slice(0, 400) : "",
      location: user.location ?? "",
      availability: user.availability ?? "",
      avatarMediaId: user.avatarMediaId,
      coverMediaId: user.coverMediaId,
      metrics: [],
      currentProjectId: hasProjects ? projectIds[0] : null,
      showCursorGlow: false,
      primaryCtaLabel: "View my work",
      secondaryCtaLabel: "Contact me",
    },
    sections,
    widgets,
  };

  return {
    version: 2,
    templateId: "editorial",
    theme: {
      mode: "dark",
      accent: "#E8BC51",
      background: "#090A0C",
      surface: "#17191D",
      text: "#F7F5EF",
      muted: "#A5A6A8",
      fontPairing: "editorial",
      fontScale: 1,
      contentWidth: "regular",
      radius: 12,
      density: "regular",
      shadows: true,
      glass: true,
      grain: false,
    },
    layout: {
      nav: "top",
      heroLayout: "centered",
      projectGrid: "grid",
      cardAspect: "landscape",
      columns: 3,
      sectionSpacing: "regular",
      align: "left",
    },
    motion: { enabled: true, entrance: "rise" },
    pages: [home],
    advanced: { customCssEnabled: false, customCss: "" },
  };
}

/** Fresh unique ids for a config that was imported (avoids collisions). */
export function reIdConfig(config: PortfolioConfig): PortfolioConfig {
  config.pages = config.pages.map((p) => ({
    ...p,
    id: newId("page"),
    sections: p.sections.map((s) => ({ ...s, id: newId("sec") })),
    widgets: p.widgets.map((w) => ({ ...w, id: newId("w") })),
  }));
  return config;
}
