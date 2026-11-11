/**
 * BEAN Folio — profession-aware CODE GIFTZ playbooks (server-safe module).
 *
 * A playbook is per-family design guidance that grounds the Code Giftz
 * planner: which content types a journalist vs. a nurse actually produces,
 * which section order tends to serve their work, and — critically — which
 * facts must NEVER be fabricated (publications, patient data, clients…).
 *
 * Rules of the module:
 *  - Suggestions, never requirements. The planner is told the user's REAL
 *    profile data is authoritative; playbooks only shape structure and tone.
 *  - Anti-fabrication is data, not prose: each family lists the concrete
 *    fact categories it forbids inventing, so multi-family merges can union
 *    them into a single honest statement.
 *  - `templateIds` is computed at CALL TIME from templatePresets() by
 *    intersecting a preset's `professions` with the family's professions —
 *    ids are never hardcoded here, so they cannot drift from site-config.
 *
 * Import graph safety: taxonomy.ts is a pure leaf; site-config.ts (and its
 * site-templates/* dependencies) never imports ai-design/*, so importing
 * templatePresets here — with playbooks imported by ai-design/context.ts —
 * creates no cycle. (site-config ↔ site-templates/professions is the one
 * pre-existing cycle, resolved by their factory functions.)
 */
import type { SiteSectionType } from "@/lib/site-config";
import { templatePresets } from "@/lib/site-config";
import { PROFESSION_FAMILIES, flattenTaxonomy } from "@/lib/professions/taxonomy";

/** The guidance shape consumed by prompt grounding and tests. */
export interface ProfessionPlaybook {
  /** Must be a slug of PROFESSION_FAMILIES (13 families). */
  familySlug: string;
  /** Ordered section-type guidance — a subset of the 11 valid SiteSectionTypes. */
  sectionOrderPreference: SiteSectionType[];
  /** The kind of work this family portfolios ("News report", "Case study"…). */
  projectTypes: string[];
  /** Visual/media emphasis for section and layout choices. */
  mediaGuidance: string;
  /** What counts as legitimate evidence in project/content descriptions. */
  evidenceGuidance: string;
  /** Derived single sentence: "Never invent A, B or C." */
  antiFabrication: string;
  /** Recommended template ids — computed from templatePresets() at call time. */
  templateIds: string[];
}

/** Internal seed: everything except the derived fields, plus raw prohibitions. */
interface PlaybookSeed {
  sectionOrderPreference: SiteSectionType[];
  projectTypes: string[];
  mediaGuidance: string;
  evidenceGuidance: string;
  /** Concrete fact categories that must never be fabricated for this family. */
  fabricationProhibitions: string[];
}

/**
 * The 13 family playbooks, keyed by the EXACT slugs in taxonomy.ts.
 * Order of sections reads hero-first everywhere; media families put a
 * gallery/reel before or right after projects; service families put
 * services + contact early; nobody gets a family-mismatched structure
 * (the journalist's reporting reel, not a developer's stats wall).
 */
const FAMILY_PLAYBOOKS: Record<string, PlaybookSeed> = {
  // ------------------------------------------------ 1. creative-arts
  "creative-arts": {
    sectionOrderPreference: ["hero", "gallery", "projects", "about", "skills", "contact"],
    projectTypes: [
      "Commissioned piece",
      "Client identity project",
      "Editorial series",
      "Personal collection",
      "Exhibition work",
      "Process case study",
    ],
    mediaGuidance:
      "Lead with strong stills — gallery/masonry layouts of finished work before long text; process shots and detail crops only from the user's own uploads.",
    evidenceGuidance:
      "Label each piece with year, medium or scope, and client/commission context ONLY when the user's profile or materials name them.",
    fabricationProhibitions: [
      "clients or commissions",
      "galleries or exhibitions",
      "awards or prizes",
      "prices or sales",
      "press features",
    ],
  },

  // ------------------------------------------------ 2. technology
  technology: {
    sectionOrderPreference: ["hero", "projects", "skills", "experience", "stats", "contact"],
    projectTypes: [
      "Case study",
      "Open-source project",
      "Product build",
      "Tool or library",
      "Technical writing",
      "Data or automation project",
    ],
    mediaGuidance:
      "Concise case-study layouts over image spectacle; screenshots and repo links only from the user's own materials.",
    evidenceGuidance:
      "Structure case studies with stack, role and outcome slots; link repositories or demos only when the profile or materials include them.",
    fabricationProhibitions: [
      "employment history",
      "performance metrics",
      "open-source stars or downloads",
      "certifications",
      "clients",
    ],
  },

  // ------------------------------------------------ 3. journalism-media
  "journalism-media": {
    sectionOrderPreference: ["hero", "gallery", "projects", "experience", "skills", "contact"],
    projectTypes: [
      "News report",
      "Field assignment",
      "Investigation",
      "Showreel segment",
      "Podcast episode",
      "Photo story",
    ],
    mediaGuidance:
      "Video, photo and audio clips emphasized — reporting reels, clip galleries and bylined stories above decorative design.",
    evidenceGuidance:
      "Project descriptions may carry byline/publication/date/source-link conventions for published work — only where the user's own materials record them.",
    fabricationProhibitions: [
      "publications",
      "bylines",
      "broadcast appearances",
      "audience metrics",
      "interviews or sources",
    ],
  },

  // ------------------------------------------------ 4. writing-publishing
  "writing-publishing": {
    sectionOrderPreference: ["hero", "projects", "about", "skills", "contact"],
    projectTypes: [
      "Published article",
      "Book or long-form work",
      "Essay",
      "Copy campaign",
      "Translation",
      "Edited volume",
    ],
    mediaGuidance:
      "Typographic, reading-first layouts — lists of titles and excerpts over image grids.",
    evidenceGuidance:
      "List titles, outlets and dates exactly as the user's materials record them; quote excerpts only from uploaded text.",
    fabricationProhibitions: [
      "publications",
      "outlets or publishers",
      "sales figures",
      "literary awards",
      "bestseller claims",
    ],
  },

  // ------------------------------------------------ 5. film-audio-entertainment
  "film-audio-entertainment": {
    sectionOrderPreference: ["hero", "gallery", "projects", "experience", "skills", "contact"],
    projectTypes: [
      "Film or short",
      "Showreel",
      "Music track or album",
      "Sound design reel",
      "Score or composition",
      "Live performance",
    ],
    mediaGuidance:
      "Reel-first: strip/featured galleries for video stills and audio work described in the user's materials; credits over decoration.",
    evidenceGuidance:
      "Credit lists (role, production, year) only from the user's own materials and profile; describe unreleased work as the materials do.",
    fabricationProhibitions: [
      "credits",
      "productions",
      "festival selections",
      "award nominations",
      "streaming numbers",
      "client rosters",
    ],
  },

  // ------------------------------------------------ 6. business-practice
  "business-practice": {
    sectionOrderPreference: ["hero", "services", "stats", "projects", "experience", "contact"],
    projectTypes: [
      "Client engagement",
      "Strategy project",
      "Campaign",
      "Workshop or training",
      "Advisory engagement",
      "Operations project",
    ],
    mediaGuidance:
      "Clean, structured service cards and stats sections; restrained imagery — credibility over spectacle.",
    evidenceGuidance:
      "Describe engagements by scope, role and approach without naming clients or figures unless the user's materials do.",
    fabricationProhibitions: [
      "client names",
      "revenue or growth metrics",
      "certifications",
      "partnerships",
      "testimonials",
    ],
  },

  // ------------------------------------------------ 7. architecture-engineering
  "architecture-engineering": {
    sectionOrderPreference: ["hero", "projects", "gallery", "experience", "skills", "contact"],
    projectTypes: [
      "Built project",
      "Design competition entry",
      "Planning study",
      "Engineering design",
      "Restoration project",
      "Feasibility study",
    ],
    mediaGuidance:
      "Structured project grids with drawings, renders and site photography from the user's own materials.",
    evidenceGuidance:
      "Pair each project with location, scope and the user's actual role — as recorded in their materials.",
    fabricationProhibitions: [
      "built works",
      "clients or developers",
      "planning approvals",
      "professional licenses",
      "awards",
    ],
  },

  // ------------------------------------------------ 8. education-research
  "education-research": {
    sectionOrderPreference: ["hero", "about", "projects", "experience", "services", "contact"],
    projectTypes: [
      "Course or curriculum",
      "Research paper",
      "Teaching resource",
      "Lecture or workshop",
      "Academic project",
      "Learning program",
    ],
    mediaGuidance:
      "Readable, calm layouts; lists of courses, talks and papers over visual spectacle.",
    evidenceGuidance:
      "Cite courses, institutions and publications only as the user's materials record them; describe teaching by subject and level.",
    fabricationProhibitions: [
      "institutional affiliations",
      "publications or citations",
      "degrees",
      "student outcomes",
    ],
  },

  // ------------------------------------------------ 9. health-wellness
  "health-wellness": {
    sectionOrderPreference: ["hero", "services", "about", "skills", "contact"],
    projectTypes: [
      "Public education content",
      "Wellness program",
      "Community workshop",
      "Professional program",
      "Practice overview",
    ],
    mediaGuidance:
      "Calm, trust-building layouts — service cards and public education content; never clinical imagery of identifiable people.",
    evidenceGuidance:
      "Strict confidentiality: no patient details, records or identifiable clinical cases anywhere. Evidence means programs, public education content and certifications shown only as EMPTY placeholders the user fills.",
    fabricationProhibitions: [
      "patient data or identifiable clinical cases",
      "licenses or certifications",
      "clinical outcomes",
      "treatment claims",
      "client health information",
    ],
  },

  // ------------------------------------------------ 10. science-environment-agriculture
  "science-environment-agriculture": {
    sectionOrderPreference: ["hero", "projects", "gallery", "about", "skills", "contact"],
    projectTypes: [
      "Field study",
      "Research project",
      "Conservation program",
      "Survey or dataset",
      "Farm or agronomy trial",
      "Monitoring program",
    ],
    mediaGuidance:
      "Fieldwork photography and maps from the user's own materials; data visuals kept honest and sourced.",
    evidenceGuidance:
      "Reference studies, datasets and field sites only as the user's materials record them; describe methods before claims.",
    fabricationProhibitions: [
      "publications",
      "field sites or permits",
      "species data",
      "funders",
      "impact metrics",
    ],
  },

  // ------------------------------------------------ 11. public-service-community
  "public-service-community": {
    sectionOrderPreference: ["hero", "about", "projects", "services", "experience", "contact"],
    projectTypes: [
      "Community program",
      "Campaign",
      "Policy analysis",
      "Public talk",
      "Volunteer initiative",
      "Partnership project",
    ],
    mediaGuidance:
      "Human, documentary tone; program descriptions and outcomes-in-context above design flourishes.",
    evidenceGuidance:
      "Describe programs and the user's role without naming beneficiaries or partners unless the user's materials do.",
    fabricationProhibitions: [
      "beneficiary identities",
      "partners or funders",
      "impact metrics",
      "government endorsements",
    ],
  },

  // ------------------------------------------------ 12. skilled-trades-services
  "skilled-trades-services": {
    sectionOrderPreference: ["hero", "services", "gallery", "projects", "contact"],
    projectTypes: [
      "Completed job",
      "Custom build",
      "Installation",
      "Menu or seasonal program",
      "Restoration",
      "Commission",
    ],
    mediaGuidance:
      "Photo galleries of completed work, clear service cards and a prominent contact section.",
    evidenceGuidance:
      "Show real jobs and craft only from the user's own photos and descriptions; keep service lists to what they actually offer.",
    fabricationProhibitions: [
      "client reviews",
      "job counts",
      "certifications or licenses",
      "before/after claims",
    ],
  },

  // ------------------------------------------------ 13. career-development
  "career-development": {
    sectionOrderPreference: ["hero", "about", "projects", "skills", "stats", "contact"],
    projectTypes: [
      "Portfolio project",
      "Learning project",
      "Internship work",
      "Freelance deliverable",
      "Personal brand site",
      "Career transition story",
    ],
    mediaGuidance:
      "Honest, growing-portfolio framing — skills and projects sections before claims of scale.",
    evidenceGuidance:
      "Frame early work as learning; keep only what the user's profile and materials actually contain.",
    fabricationProhibitions: [
      "employment history",
      "credentials",
      "clients",
      "metrics",
      "awards",
    ],
  },
};

/** "A, B or C." — reads naturally for 1..n items. */
function prohibitionsSentence(items: string[]): string {
  if (items.length === 0) return "Never invent facts the user's materials do not contain.";
  if (items.length === 1) return `Never invent ${items[0]}.`;
  return `Never invent ${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}.`;
}

/** Memoized template ids per family — computed from the real template library. */
const templateIdCache = new Map<string, string[]>();

function templateIdsForFamily(familySlug: string): string[] {
  const cached = templateIdCache.get(familySlug);
  if (cached) return cached;
  const family = PROFESSION_FAMILIES.find((f) => f.slug === familySlug);
  if (!family) {
    templateIdCache.set(familySlug, []);
    return [];
  }
  const familyProfessions = new Set(family.professions.map((p) => p.slug));
  const ids = templatePresets()
    .filter((preset) => preset.professions.some((slug) => familyProfessions.has(slug)))
    .map((preset) => preset.id as string);
  templateIdCache.set(familySlug, ids);
  return ids;
}

/** The playbook for one family slug — null when the slug is not a family. */
export function playbookForFamily(familySlug: string): ProfessionPlaybook | null {
  const seed = FAMILY_PLAYBOOKS[familySlug];
  if (!seed) return null;
  return {
    familySlug,
    sectionOrderPreference: seed.sectionOrderPreference,
    projectTypes: seed.projectTypes,
    mediaGuidance: seed.mediaGuidance,
    evidenceGuidance: seed.evidenceGuidance,
    antiFabrication: prohibitionsSentence(seed.fabricationProhibitions),
    templateIds: templateIdsForFamily(familySlug),
  };
}

/**
 * Playbooks for the user's declared profession slugs: each profession maps
 * to its family via the taxonomy, families are deduped (first occurrence
 * wins, preserving the user's profession order) and the result is capped
 * at 3 so grounding stays bounded. Unknown slugs are skipped.
 */
export function playbooksForProfessions(slugs: string[]): ProfessionPlaybook[] {
  const familyByProfession = new Map<string, string>();
  for (const p of flattenTaxonomy()) familyByProfession.set(p.slug, p.familySlug);

  const out: ProfessionPlaybook[] = [];
  const seenFamilies = new Set<string>();
  for (const slug of slugs) {
    if (out.length >= 3) break;
    const familySlug = familyByProfession.get(slug);
    if (!familySlug || seenFamilies.has(familySlug)) continue;
    seenFamilies.add(familySlug);
    const playbook = playbookForFamily(familySlug);
    if (playbook) out.push(playbook);
  }
  return out;
}

const MAX_CONTENT_TYPES = 12;
const MAX_PROHIBITIONS = 12;

/**
 * Human-readable merged guidance block for prompt grounding — the exact text
 * appended to the portfolio context after the Professions line. Returns null
 * when the user has no resolvable professions (current behavior preserved).
 *
 * Merging rules: content types are a deduped union in playbook order (capped);
 * section order is first-occurrence-wins across families; evidence and media
 * guidance are combined per family; ONE anti-fabrication statement unions the
 * concrete prohibitions. Everything is phrased as suggestions — the user's
 * real data stays authoritative.
 */
export function mergedPlaybookGuidance(slugs: string[]): string | null {
  const playbooks = playbooksForProfessions(slugs);
  if (playbooks.length === 0) return null;

  const contentTypes: string[] = [];
  for (const pb of playbooks) {
    for (const t of pb.projectTypes) {
      if (!contentTypes.includes(t) && contentTypes.length < MAX_CONTENT_TYPES) contentTypes.push(t);
    }
  }

  const sectionOrder: string[] = [];
  for (const pb of playbooks) {
    for (const s of pb.sectionOrderPreference) {
      if (!sectionOrder.includes(s)) sectionOrder.push(s);
    }
  }

  const media = playbooks.map((pb) => pb.mediaGuidance).join(" ");
  const evidence = playbooks.map((pb) => pb.evidenceGuidance).join(" ");

  const prohibitions: string[] = [];
  for (const pb of playbooks) {
    const seed = FAMILY_PLAYBOOKS[pb.familySlug];
    for (const item of seed?.fabricationProhibitions ?? []) {
      if (!prohibitions.includes(item) && prohibitions.length < MAX_PROHIBITIONS) {
        prohibitions.push(item);
      }
    }
  }

  return [
    "- Profession guidance (from their declared professions — suggestions, not requirements; the user's real data and materials are always authoritative):",
    `  - Likely content types: ${contentTypes.join(", ")}`,
    `  - Suggested section order: ${sectionOrder.join(", ")}`,
    `  - Media emphasis: ${media}`,
    `  - Evidence conventions: ${evidence}`,
    `  - Never fabricate: ${prohibitions.join(", ")}.`,
  ].join("\n");
}
