/**
 * GIFTZ motion/component test fixtures (M15 §12 + M16 §12 + M17 §12).
 *
 * These are TEST FIXTURES — SiteConfig presets exercising the motion engine,
 * the background engine and the component registry end to end. They are not
 * live user content; every fixture passes normalizeConfig (the same schema
 * gate the platform enforces on every save/publish).
 *
 * GSAP demo sites (M15): premium agency / photography portfolio / SaaS /
 * restaurant / interactive product showcase.
 * Vanta demo sites (M16): FOG agency / NET SaaS / WAVES travel / GLOBE
 * global business / BIRDS creative portfolio — each keeps a static fallback.
 * Component demo sites (M17): creative portfolio / SaaS landing / photography
 * / restaurant / technology agency / developer portfolio.
 */

import { blankGiftzSeedConfig, deriveTheme, makeSection, type SiteConfig, type SiteSection } from "@/lib/site-config";
import type { GsapAnimationSpec, GsapMotionBlock, BackgroundEffects } from "@/lib/giftz/motion-engine";

/** Fixture-friendly animation input — trigger/options stay partial (defaults applied). */
type AnimationInput = Omit<GsapAnimationSpec, "responsive" | "reducedMotion" | "enabled" | "trigger" | "options"> & {
  trigger?: Partial<GsapAnimationSpec["trigger"]>;
  options?: GsapAnimationSpec["options"];
};

function gsapBlock(animations: AnimationInput[], enabled = true): GsapMotionBlock {
  return {
    enabled,
    respectReducedMotion: true,
    animations: animations.map((a) => ({
      ...a,
      trigger: { type: "load", once: true, ...a.trigger },
      options: a.options ?? {},
      responsive: { mobile: "full" },
      reducedMotion: "static",
      enabled: true,
    })),
  };
}

function withSections(base: SiteConfig, sections: SiteSection[]): SiteConfig {
  return { ...base, pages: [{ id: "home", name: "Home", visible: true, sections }] };
}

function seed(): SiteConfig {
  return blankGiftzSeedConfig("Fixture site");
}

// ---------------------------------------------------------------- M15 GSAP fixtures

/** 1. Premium agency landing page — cinematic typography + staggered sections. */
export function agencyMotionFixture(): SiteConfig {
  const base = seed();
  const hero = base.pages[0].sections[0];
  const about = makeSection("about");
  const services = makeSection("services");
  const contact = makeSection("contact");
  const config = withSections(base, [hero, about, services, contact]);
  return {
    ...config,
    motion: {
      ...config.motion,
      gsap: gsapBlock([
        { id: "agency-hero-title", preset: "word-reveal", target: { kind: "section", sectionId: hero.id, element: "heading" }, trigger: { type: "scroll", start: "top 80%" }, options: { duration: 900, stagger: 70, easing: "power3.out" } },
        { id: "agency-hero-layers", preset: "layered-hero", target: { kind: "section", sectionId: hero.id, element: "container" }, trigger: { type: "load" }, options: { duration: 1000, stagger: 120, parallax: true } },
        { id: "about-blur", preset: "blur-reveal", target: { kind: "section", sectionId: about.id, element: "heading" }, trigger: { type: "scroll" }, options: { duration: 900, blur: 12 } },
        { id: "services-stagger", preset: "stagger-cards", target: { kind: "section", sectionId: services.id, element: "container" }, trigger: { type: "scroll" }, options: { duration: 700, stagger: 80 } },
        { id: "cta-hover", preset: "hover-lift", target: { kind: "section", sectionId: contact.id, element: "buttons" }, trigger: { type: "interaction" }, options: { duration: 350, lift: 8 } },
      ]),
    },
  };
}

/** 2. Creative photography portfolio — parallax gallery + horizontal story. */
export function photographyMotionFixture(): SiteConfig {
  const base = seed();
  const hero = base.pages[0].sections[0];
  const gallery = makeSection("gallery");
  const projects = makeSection("projects");
  const config = withSections(base, [hero, gallery, projects]);
  return {
    ...config,
    motion: {
      ...config.motion,
      gsap: gsapBlock([
        { id: "gallery-parallax", preset: "parallax-image", target: { kind: "section", sectionId: gallery.id, element: "images" }, trigger: { type: "scroll" }, options: { amount: 24 } },
        { id: "story-pin", preset: "horizontal-story", target: { kind: "section", sectionId: projects.id, element: "container" }, trigger: { type: "scroll" }, options: { end: "+=160%" } },
        { id: "headings-clip", preset: "clip-reveal", target: { kind: "section", sectionId: gallery.id, element: "heading" }, trigger: { type: "scroll" }, options: { duration: 900 } },
        { id: "hero-lines", preset: "line-reveal", target: { kind: "section", sectionId: hero.id, element: "heading" }, trigger: { type: "scroll" }, options: { duration: 800, stagger: 120 } },
      ]),
    },
  };
}

/** 3. SaaS product landing page — counters, staggered pricing, progress bar. */
export function saasMotionFixture(): SiteConfig {
  const base = seed();
  const hero = base.pages[0].sections[0];
  const stats = makeSection("stats");
  const pricing = makeSection("pricing");
  const config = withSections(base, [hero, stats, pricing]);
  return {
    ...config,
    motion: {
      ...config.motion,
      gsap: gsapBlock([
        { id: "metrics-count", preset: "number-counter", target: { kind: "section", sectionId: stats.id, element: "stats" }, trigger: { type: "scroll" }, options: { duration: 1400, decimals: 0, suffix: "+" } },
        { id: "pricing-stagger", preset: "stagger-cards", target: { kind: "section", sectionId: pricing.id, element: "cards" }, trigger: { type: "scroll" }, options: { duration: 700, stagger: 90 } },
        { id: "headline-gradient", preset: "gradient-text", target: { kind: "section", sectionId: hero.id, element: "heading" }, trigger: { type: "scroll" }, options: { duration: 1100 } },
        { id: "reading-progress", preset: "scroll-progress", target: { kind: "selector", selector: ".bs-progress" }, trigger: { type: "scroll", start: "top top", end: "bottom bottom" }, options: {} },
      ]),
    },
  };
}

/** 4. Restaurant website — warm restrained motion + decorative SVG drawing. */
export function restaurantMotionFixture(): SiteConfig {
  const base = seed();
  const hero = base.pages[0].sections[0];
  const about = makeSection("about");
  const contact = makeSection("contact");
  const config = withSections(base, [hero, about, contact]);
  return {
    ...config,
    motion: {
      ...config.motion,
      gsap: gsapBlock([
        { id: "welcome-type", preset: "typewriter", target: { kind: "section", sectionId: hero.id, element: "heading" }, trigger: { type: "load" }, options: { speed: 40 } },
        { id: "menu-fade", preset: "scroll-reveal", target: { kind: "section", sectionId: about.id, element: "container" }, trigger: { type: "scroll" }, options: { duration: 700, distance: 24 } },
        { id: "divider-draw", preset: "svg-draw", target: { kind: "selector", selector: ".gz-ornament svg path" }, trigger: { type: "scroll" }, options: { duration: 1600 } },
        { id: "visit-lift", preset: "hover-lift", target: { kind: "section", sectionId: contact.id, element: "buttons" }, trigger: { type: "interaction" }, options: { lift: 6 } },
      ]),
    },
  };
}

/** 5. Interactive product showcase — motion path, tilt, pinned storytelling. */
export function showcaseMotionFixture(): SiteConfig {
  const base = seed();
  const hero = base.pages[0].sections[0];
  const projects = makeSection("projects");
  const about = makeSection("about");
  const config = withSections(base, [hero, projects, about]);
  return {
    ...config,
    motion: {
      ...config.motion,
      gsap: gsapBlock([
        { id: "product-path", preset: "motion-path", target: { kind: "section", sectionId: hero.id, element: "images" }, trigger: { type: "load" }, options: { duration: 4000, points: [{ x: 0, y: 0 }, { x: 40, y: -24 }, { x: 90, y: -10 }, { x: 120, y: -40 }], loop: true } },
        { id: "cards-tilt", preset: "card-tilt", target: { kind: "section", sectionId: projects.id, element: "cards" }, trigger: { type: "interaction" }, options: { max: 8, scale: 1.03 } },
        { id: "story-pin", preset: "pinned-section", target: { kind: "section", sectionId: about.id, element: "container" }, trigger: { type: "scroll" }, options: { end: "+=140%" } },
        { id: "cta-magnet", preset: "magnetic-button", target: { kind: "section", sectionId: hero.id, element: "buttons" }, trigger: { type: "interaction" }, options: { strength: 0.3 } },
      ]),
    },
  };
}

// ---------------------------------------------------------------- M16 Vanta fixtures

function vantaBackground(effect: BackgroundEffects["effect"], settings: BackgroundEffects["settings"]): BackgroundEffects {
  return {
    enabled: true,
    engine: "vanta",
    effect,
    target: { kind: "hero" },
    settings,
    responsive: { mobile: "reduced" },
    accessibility: { respectReducedMotion: true },
    fallback: { kind: "color", value: "#101014" },
  };
}

export const vantaFixtures: { name: string; effect: string; build: () => SiteConfig }[] = [
  { name: "luxury-agency-fog", effect: "FOG", build: () => ({ ...seed(), backgroundEffects: vantaBackground("FOG", { speed: 1.2, highlightColor: "#d4af6a", baseColor: "#101014" }) }) },
  { name: "saas-net", effect: "NET", build: () => ({ ...seed(), backgroundEffects: vantaBackground("NET", { color: "#7dd3fc", backgroundColor: "#0b1220", points: 12 }) }) },
  { name: "travel-waves", effect: "WAVES", build: () => ({ ...seed(), backgroundEffects: vantaBackground("WAVES", { color: "#0ea5e9", waveHeight: 18, waveSpeed: 1 }) }) },
  { name: "global-business-globe", effect: "GLOBE", build: () => ({ ...seed(), backgroundEffects: vantaBackground("GLOBE", { color: "#d4af6a", backgroundColor: "#0a0a0f", size: 1 }) }) },
  { name: "creative-birds", effect: "BIRDS", build: () => ({ ...seed(), backgroundEffects: vantaBackground("BIRDS", { quantity: 4, backgroundColor: "#111318" }) }) },
];

// ---------------------------------------------------------------- M17 component fixtures

export const componentFixtures: { name: string; brief: { category: string; visualDirection: string[]; sections: string[]; constraints?: string[] }; build: () => SiteConfig }[] = [
  {
    name: "premium-creative-portfolio",
    brief: { category: "creative-portfolio", visualDirection: ["cinematic", "premium"], sections: ["hero", "projects", "gallery", "contact"] },
    build: agencyMotionFixture,
  },
  {
    name: "modern-saas-landing",
    brief: { category: "saas", visualDirection: ["tech", "minimal"], sections: ["hero", "stats", "pricing", "contact"] },
    build: saasMotionFixture,
  },
  {
    name: "photography-website",
    brief: { category: "photography", visualDirection: ["editorial", "quiet"], sections: ["hero", "gallery"], constraints: ["no-heavy-webgl"] },
    build: photographyMotionFixture,
  },
  {
    name: "restaurant-website",
    brief: { category: "restaurant", visualDirection: ["warm", "elegant"], sections: ["hero", "about", "contact"] },
    build: restaurantMotionFixture,
  },
  {
    name: "technology-agency",
    brief: { category: "technology-agency", visualDirection: ["bold", "interactive"], sections: ["hero", "services", "stats"] },
    build: showcaseMotionFixture,
  },
  {
    name: "developer-portfolio",
    brief: { category: "developer", visualDirection: ["minimal", "clean"], sections: ["hero", "about", "projects"] },
    build: () => {
      const base = seed();
      const hero = base.pages[0].sections[0];
      const about = makeSection("about");
      const projects = makeSection("projects");
      const config = withSections(base, [hero, about, projects]);
      return {
        ...config,
        theme: deriveTheme({ background: "#0a0a0c", foreground: "#e7e7ea", accent: "#4ade80", font: "mono" }),
        motion: {
          ...config.motion,
          gsap: gsapBlock([
            { id: "dev-type", preset: "typewriter", target: { kind: "section", sectionId: hero.id, element: "heading" }, trigger: { type: "load" }, options: { speed: 55 } },
            { id: "grid-stagger", preset: "stagger-entrance", target: { kind: "section", sectionId: projects.id, element: "container" }, trigger: { type: "scroll" }, options: { stagger: 60 } },
          ]),
        },
      };
    },
  },
];
