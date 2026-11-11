/**
 * BEAN Folio — Universal Studio project templates (pure-data leaf).
 *
 * Templates are STARTING STRUCTURES, never content: a template sets the
 * project kind, shows the right profession-specific fields, drops guidance
 * into empty narrative fields and suggests skills/tools. It never writes
 * facts the user did not provide (no invented clients, metrics, titles).
 *
 * Discovery dimensions (spec §5): profession (families/professions),
 * specialization (professions), industry (the family label), project type
 * (kinds) and presentation style.
 *
 * Apply semantics live with the caller (CreateProjectFlow / ProjectEditor):
 * on an EMPTY project a template applies directly; on a project that already
 * has tags the caller MUST show a confirmation listing exactly what would
 * merge (templateMerges). Narrative content is never overwritten — guidance
 * text lands in placeholders of empty fields only.
 */

import { PROFESSION_FAMILIES } from "@/lib/professions/taxonomy";
import type { SuggestedField } from "@/lib/studio-schema";

export type TemplateNarrativeField = "brief" | "process" | "challenges" | "outcome";

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  /** Presentation-style tag for discovery, e.g. "Narrative case study". */
  style: string;
  /** Compatible families (any profession inside them matches). */
  families: string[];
  /** Optional specialization-level matches (specific profession slugs). */
  professions?: string[];
  /** Project kinds this template targets (family-profile kind slugs). */
  kinds: string[];
  /** A profession slug to preselect as the project category. */
  categoryHint?: string;
  /**
   * Guidance text per narrative field — used as PLACEHOLDER text in empty
   * fields, never saved as content by itself.
   */
  guides?: Partial<Record<TemplateNarrativeField, string>>;
  /** Skills suggested on apply (merged into empty-or-user tag inputs). */
  skills?: string[];
  /** Tools suggested on apply. */
  tools?: string[];
  /** Which profession-specific structured fields this template surfaces. */
  suggestedFieldKeys?: string[];
}

// ------------------------------------------------------------- templates

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  // -------------------------------------------------- universal
  {
    id: "universal-case-study",
    name: "Universal case study",
    description: "A four-part structure — objective, approach, decisions and results — that works for any profession.",
    style: "Narrative case study",
    families: ["*"],
    kinds: ["case-study", "portfolio-piece"],
    guides: {
      brief: "What was the goal, and who was it for?",
      process: "How did you move from the goal to the result? Key steps and decisions.",
      challenges: "What was hard, and what did you decide between?",
      outcome: "What happened in the end — reception, results, lessons?",
    },
    suggestedFieldKeys: [],
  },
  {
    id: "universal-milestone",
    name: "Milestone record",
    description: "Record a qualification, credential or achievement cleanly — with dates and evidence links.",
    style: "Evidence record",
    families: ["*"],
    kinds: ["career-milestone", "certification", "qualification", "academic-achievement", "achievement"],
    guides: {
      brief: "What was earned, from whom, and when?",
      outcome: "What it qualifies you to do — and anything official worth linking.",
    },
  },
  {
    id: "universal-freelance",
    name: "Freelance delivery",
    description: "A client-job structure: brief, delivery scope, timeline and handover.",
    style: "Client job",
    families: ["*"],
    kinds: ["freelance-work", "commission", "completed-job", "client-engagement"],
    guides: {
      brief: "What did the client need — scope, constraints, deadline?",
      process: "How you delivered it — steps, materials, coordination.",
      outcome: "Handover, feedback and aftercare — only what you can share.",
    },
  },

  // -------------------------------------------------- creative-arts
  {
    id: "arts-commission",
    name: "Commissioned artwork",
    description: "Present client or gallery work with medium, dimensions and commissioning context.",
    style: "Gallery plate",
    families: ["creative-arts"],
    kinds: ["commissioned-piece", "client-identity"],
    guides: {
      brief: "Who commissioned it and what did they ask for?",
      process: "Materials, techniques and studio decisions.",
      outcome: "Where the work now lives — collection, exhibition or client.",
    },
    skills: ["Art direction", "Composition"],
    suggestedFieldKeys: ["medium", "client", "year", "dimensions"],
  },
  {
    id: "arts-series",
    name: "Personal series",
    description: "A self-initiated body of work — concept, evolution and exhibition history.",
    style: "Curated collection",
    families: ["creative-arts"],
    kinds: ["personal-collection", "editorial-series", "exhibition-work"],
    guides: {
      brief: "The concept behind the series — what are you exploring?",
      process: "How the pieces evolved across the series.",
      outcome: "Shows, publications or where it can be seen.",
    },
    skills: ["Concept development", "Curation"],
    suggestedFieldKeys: ["medium", "year"],
  },

  // -------------------------------------------------- technology
  {
    id: "tech-product-build",
    name: "Product build",
    description: "A shipped application — problem, architecture, hard parts and verified results.",
    style: "Engineering case study",
    families: ["technology"],
    professions: ["software-dev", "frontend-dev", "backend-dev", "fullstack-dev", "mobile-dev"],
    kinds: ["web-app", "mobile-app", "api-backend"],
    guides: {
      brief: "The user problem and objective.",
      process: "Stack, architecture and the decisions that mattered.",
      challenges: "The genuinely hard problems — scaling, correctness, performance.",
      outcome: "What shipped and what it changed — only figures you can verify.",
    },
    skills: ["System design", "API design"],
    tools: ["Git", "Docker"],
    suggestedFieldKeys: ["stack", "my-contribution", "status"],
  },
  {
    id: "tech-open-source",
    name: "Open-source project",
    description: "Structure a library or tool: the gap it fills, design, adoption and contribution guide.",
    style: "Technical README",
    families: ["technology"],
    kinds: ["open-source", "ai-ml-project"],
    guides: {
      brief: "The gap in the ecosystem this fills.",
      process: "Design decisions and the public development story.",
      outcome: "Adoption and community — stars/downloads only if you can link them.",
    },
    skills: ["Open source", "Documentation"],
    suggestedFieldKeys: ["stack", "status", "metrics"],
  },

  // -------------------------------------------------- journalism-media
  {
    id: "news-published-story",
    name: "Published story",
    description: "A bylined news report — angle, reporting trail, publication and links.",
    style: "Clipping record",
    families: ["journalism-media"],
    kinds: ["news-report", "publication"],
    guides: {
      brief: "The story and why it mattered now.",
      process: "Sourcing, verification and production — no confidential material.",
      outcome: "Where it ran and the public response.",
    },
    skills: ["News writing", "Fact-checking"],
    suggestedFieldKeys: ["publication", "published-date", "format", "language"],
  },
  {
    id: "news-investigation",
    name: "Investigative report",
    description: "Long-form investigative structure — hypothesis, evidence trail, findings and impact.",
    style: "Long-form investigation",
    families: ["journalism-media"],
    professions: ["broadcast-journalist", "documentary-journalist", "business-journalist", "environment-journalist", "financial-journalist"],
    kinds: ["investigative-report", "documentary", "interview-feature"],
    guides: {
      brief: "The question the investigation set out to answer.",
      process: "Evidence, interviews and verification — describe, never expose sources.",
      challenges: "Access, legal review and editorial pushback.",
      outcome: "Findings, publication and any documented impact.",
    },
    skills: ["Investigative research", "Interviewing"],
    suggestedFieldKeys: ["publication", "published-date"],
  },

  // -------------------------------------------------- writing-publishing
  {
    id: "writing-published-piece",
    name: "Published piece",
    description: "Present an article, essay or book with outlet, length and rights.",
    style: "Typographic record",
    families: ["writing-publishing"],
    kinds: ["published-article", "book", "personal-writing"],
    guides: {
      brief: "What the piece set out to do.",
      process: "Research and drafting — how the text took shape.",
      outcome: "Where it appeared and in what form.",
    },
    skills: ["Long-form writing", "Research"],
    suggestedFieldKeys: ["publisher", "word-count", "genre"],
  },
  {
    id: "writing-copy-campaign",
    name: "Copy campaign",
    description: "Commercial copy work — the brief, voice decisions and deliverables.",
    style: "Campaign sheet",
    families: ["writing-publishing"],
    kinds: ["copy-campaign"],
    guides: {
      brief: "The client's brief — audience, message, channel.",
      process: "Voice, iterations and the lines that made the cut.",
      outcome: "Deliverables and where the copy ran.",
    },
    skills: ["Copywriting", "Brand voice"],
    suggestedFieldKeys: ["publisher", "rights"],
  },

  // -------------------------------------------------- film-audio-entertainment
  {
    id: "film-showreel",
    name: "Showreel",
    description: "A curated reel — segments, your credit on each, and where the full work lives.",
    style: "Reel-first",
    families: ["film-audio-entertainment"],
    // Specialization targets — real profession slugs from the taxonomy.
    professions: ["video-editor", "videographer", "colorist", "motion-designer", "animator"],
    kinds: ["showreel", "video-project", "advertisement"],
    guides: {
      brief: "What the reel covers — genres, formats, years.",
      process: "How it was cut and sequenced.",
      outcome: "Where each segment comes from — credits from your records.",
    },
    skills: ["Editing", "Color grading"],
    suggestedFieldKeys: ["runtime", "format", "year"],
  },
  {
    id: "film-production",
    name: "Film / production",
    description: "A full production record — format, crew credit, festivals and screenings.",
    style: "Credit roll",
    families: ["film-audio-entertainment"],
    kinds: ["film-project", "motion-graphics", "color-grading", "music-release", "live-performance"],
    guides: {
      brief: "The production — format, length, purpose.",
      process: "Production and post pipeline you ran.",
      outcome: "Screenings, releases and credits — only from your records.",
    },
    skills: ["Storytelling", "Cinematography"],
    suggestedFieldKeys: ["runtime", "production", "year"],
  },

  // -------------------------------------------------- business-practice
  {
    id: "business-venture",
    name: "Venture profile",
    description: "Present a business or product you built — mandate, execution and verified results.",
    style: "Investor brief",
    families: ["business-practice"],
    professions: ["entrepreneur", "founder", "marketing"],
    kinds: ["venture", "product-launch", "leadership-record"],
    guides: {
      brief: "The market gap and your mandate.",
      process: "Strategy and how you executed it.",
      challenges: "Constraints — capital, timing, competition.",
      outcome: "Growth and traction — only substantiated figures.",
    },
    skills: ["Strategy", "Go-to-market"],
    suggestedFieldKeys: ["organization", "timeframe", "scope"],
  },
  {
    id: "business-engagement",
    name: "Client engagement",
    description: "Consulting or agency work — scope, approach and outcome without breaking confidentiality.",
    style: "Advisory record",
    families: ["business-practice"],
    kinds: ["client-engagement", "campaign", "case-study"],
    guides: {
      brief: "The engagement scope and the client's goal (name them only if public).",
      process: "Your approach and operating cadence.",
      outcome: "The measured result — anonymized if needed.",
    },
    skills: ["Stakeholder management", "Financial planning"],
    suggestedFieldKeys: ["engagement-type", "timeframe", "scope"],
  },

  // -------------------------------------------------- architecture-engineering
  {
    id: "arch-built-project",
    name: "Built project",
    description: "A building design — site, programme, design moves and status with drawings and renders.",
    style: "Project plate",
    families: ["architecture-engineering"],
    professions: ["architect", "architecture", "interior-designer"],
    kinds: ["architectural-project", "building-design", "interior-design"],
    guides: {
      brief: "Site, programme and brief.",
      process: "Concept → development → drawings → site.",
      challenges: "Structural, climatic or regulatory constraints.",
      outcome: "Status — concept, approved, under construction or completed.",
    },
    skills: ["Spatial design", "Site analysis"],
    tools: ["AutoCAD", "Revit"],
    suggestedFieldKeys: ["location", "site-area", "typology", "stage"],
  },
  {
    id: "arch-documentation",
    name: "Plans & documentation",
    description: "Technical documentation work — plan sets, BOQs and coordination records.",
    style: "Technical set",
    families: ["architecture-engineering"],
    kinds: ["floor-plans", "project-documentation", "3d-renders", "engineering-design"],
    guides: {
      brief: "What the set covers — stage and scope.",
      process: "Drafting standards, coordination and revisions.",
      outcome: "Approvals or construction use.",
    },
    skills: ["Drafting", "Structural coordination"],
    tools: ["AutoCAD", "SketchUp"],
    suggestedFieldKeys: ["location", "stage"],
  },

  // -------------------------------------------------- education-research
  {
    id: "edu-course",
    name: "Course / curriculum",
    description: "A course you designed or taught — level, pedagogy, materials and outcomes.",
    style: "Syllabus",
    families: ["education-research"],
    professions: ["teacher", "professor", "education"],
    kinds: ["course", "teaching-record", "educational-resource", "lecture-talk"],
    guides: {
      brief: "What you taught and to whom.",
      process: "Pedagogy, materials and assessment design.",
      outcome: "Student outcomes and feedback — as documented.",
    },
    skills: ["Curriculum design", "Instruction"],
    suggestedFieldKeys: ["institution", "level", "subject", "year"],
  },
  {
    id: "edu-research",
    name: "Research record",
    description: "A study or publication — question, method, findings and citation.",
    style: "Academic abstract",
    families: ["education-research", "science-environment-agriculture"],
    professions: ["researcher", "professor", "teacher", "scientist", "field-researcher"],
    kinds: ["research", "publication", "certification", "academic-achievement"],
    guides: {
      brief: "The research question.",
      process: "Method and analysis — reproducible detail.",
      outcome: "Findings and where it is published or archived.",
    },
    skills: ["Academic writing", "Research methods"],
    suggestedFieldKeys: ["institution", "year"],
  },

  // -------------------------------------------------- health-wellness
  {
    id: "health-qualification",
    name: "Qualification & credentials",
    description: "Record degrees, registrations and certifications — with institutions and years.",
    style: "Credential record",
    families: ["health-wellness"],
    professions: ["doctor", "nurse"],
    kinds: ["qualification", "certification", "achievement"],
    guides: {
      brief: "What was earned and from which board or university.",
      outcome: "Registration status and scope of practice.",
    },
    skills: ["Clinical practice"],
    suggestedFieldKeys: ["institution", "credential-id", "year"],
  },
  {
    id: "health-program",
    name: "Healthcare program",
    description: "A camp, audit or public-education initiative — scope and aggregate reach, never patient data.",
    style: "Program record",
    families: ["health-wellness"],
    kinds: ["healthcare-project", "public-education", "clinical-experience", "research-publication"],
    guides: {
      brief: "The program's public-health purpose.",
      process: "Setting, protocols and your responsibilities — strictly non-identifiable.",
      outcome: "Aggregate reach and documented findings only.",
    },
    skills: ["Patient education", "Public health"],
    suggestedFieldKeys: ["institution", "setting", "year"],
  },

  // -------------------------------------------------- science-environment-agriculture
  {
    id: "science-field-study",
    name: "Field study",
    description: "Fieldwork with site, period, methods and honest findings.",
    style: "Field report",
    families: ["science-environment-agriculture"],
    kinds: ["field-study", "research-project", "dataset", "agronomy-trial", "conservation-program"],
    guides: {
      brief: "The question or the system being studied.",
      process: "Design, sampling and analysis — methods before claims.",
      challenges: "Field constraints — access, weather, data quality.",
      outcome: "What the data showed.",
    },
    skills: ["Field methods", "Data analysis"],
    tools: ["QGIS", "R"],
    suggestedFieldKeys: ["site", "period", "focus"],
  },

  // -------------------------------------------------- public-service-community
  {
    id: "public-community-program",
    name: "Community program",
    description: "A program or campaign — need, approach and aggregate outcomes, beneficiaries unnamed.",
    style: "Program record",
    families: ["public-service-community"],
    kinds: ["community-program", "campaign", "volunteer-initiative", "partnership-project", "policy-analysis", "public-talk"],
    guides: {
      brief: "The community need addressed.",
      process: "How it was organized and delivered.",
      outcome: "Participation and coverage in aggregate.",
    },
    skills: ["Community organizing", "Program design"],
    suggestedFieldKeys: ["organization", "beneficiaries", "location", "period"],
  },

  // -------------------------------------------------- skilled-trades-services
  {
    id: "trades-completed-job",
    name: "Completed job",
    description: "A finished job with scope, materials, duration and handover photos.",
    style: "Job sheet",
    families: ["skilled-trades-services"],
    kinds: ["completed-job", "custom-build", "installation", "restoration", "commission", "menu-program"],
    guides: {
      brief: "What the client needed — scope and site.",
      process: "Materials, method and timeline.",
      outcome: "Handover and aftercare.",
    },
    skills: ["Craftsmanship", "Client service"],
    suggestedFieldKeys: ["service-area", "duration", "materials", "warranty"],
  },

  // -------------------------------------------------- career-development
  {
    id: "career-learning-project",
    name: "Learning project",
    description: "An honest early-portfolio record — what you built, what you learned, what's next.",
    style: "Growing portfolio",
    families: ["career-development"],
    kinds: ["learning-project", "portfolio-piece", "personal-project", "internship-work"],
    guides: {
      brief: "What this project is — coursework, bootcamp build, self-directed work.",
      process: "How you approached it and what you'd do differently.",
      outcome: "Where it stands — shipped, ongoing, submitted.",
    },
    skills: ["Self-direction", "Communication"],
    suggestedFieldKeys: ["context", "next-step"],
  },
  {
    id: "career-freelance-start",
    name: "First freelance job",
    description: "A client deliverable for an independent career — scope, delivery and testimonial-ready structure.",
    style: "Client job",
    families: ["career-development"],
    kinds: ["freelance-work", "career-milestone", "portfolio-piece"],
    guides: {
      brief: "What the client needed and the agreed scope.",
      process: "How you delivered — steps, communication, revisions.",
      outcome: "Handover and what the client received.",
    },
    suggestedFieldKeys: ["context"],
  },
];

// ------------------------------------------------------------- helpers

const familyLabelCache = new Map<string, string>();
for (const f of PROFESSION_FAMILIES) familyLabelCache.set(f.slug, f.label);

/** Industry label for a family slug (the family's display label). */
export function familyIndustryLabel(familySlug: string): string {
  return familyLabelCache.get(familySlug) ?? familySlug;
}

/** Templates whose family set includes the given family (or "*" universal). */
export function templatesForFamily(familySlug: string | null | undefined): ProjectTemplate[] {
  if (!familySlug) return PROJECT_TEMPLATES.filter((t) => t.families.includes("*"));
  return PROJECT_TEMPLATES.filter((t) => t.families.includes("*") || t.families.includes(familySlug));
}

/** Templates targeting a specific project kind. */
export function templatesForKind(kindSlug: string): ProjectTemplate[] {
  return PROJECT_TEMPLATES.filter((t) => t.kinds.includes(kindSlug));
}

export function templateById(id: string): ProjectTemplate | null {
  return PROJECT_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** The structured fields a template surfaces, filtered to a family's schema. */
export function templateSuggestedFields(t: ProjectTemplate, familyFields: SuggestedField[]): SuggestedField[] {
  if (!t.suggestedFieldKeys?.length) return [];
  return familyFields.filter((f) => t.suggestedFieldKeys!.includes(f.key));
}

/**
 * Which EXISTING tag lists a template application would merge into. The only
 * values a template can ever alter: narrative fields receive guidance text
 * as PLACEHOLDERS (content untouched), kind/category are set only when
 * empty. Used by callers to decide whether a confirmation is required and
 * what it must disclose.
 */
export function templateMerges(
  t: ProjectTemplate,
  existing: {
    skills?: string[];
    tools?: string[];
  }
): ("skills" | "tools")[] {
  const merges: ("skills" | "tools")[] = [];
  if (t.skills?.length && (existing.skills?.length ?? 0) > 0) merges.push("skills");
  if (t.tools?.length && (existing.tools?.length ?? 0) > 0) merges.push("tools");
  return merges;
}

/** Case-insensitive multi-term search across every discovery dimension. */
export function searchTemplates(
  query: string,
  opts: { familySlug?: string | null; kindSlug?: string | null; professionSlug?: string | null } = {}
): ProjectTemplate[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let pool = PROJECT_TEMPLATES;

  if (opts.familySlug) {
    const familyMatched = pool.filter((t) => t.families.includes("*") || t.families.includes(opts.familySlug!));
    // Keep the family's templates in front of universals, but never empty the list.
    pool = familyMatched.length > 0 ? familyMatched : pool;
  }
  if (opts.kindSlug) {
    const kindMatched = pool.filter((t) => t.kinds.includes(opts.kindSlug!));
    pool = kindMatched.length > 0 ? kindMatched : pool;
  }
  if (opts.professionSlug) {
    // Specialization-aware RANKING, not elimination: templates that target the
    // creator's specific profession move to the front; family templates that
    // target sibling specializations stay available right behind them.
    const matches = (t: ProjectTemplate) => !t.professions || t.professions.includes(opts.professionSlug!);
    pool = [...pool.filter(matches), ...pool.filter((t) => !matches(t))];
  }

  if (terms.length === 0) return pool;
  return pool.filter((t) => {
    const haystack = [
      t.name,
      t.description,
      t.style,
      ...t.families.map(familyIndustryLabel),
      ...(t.professions ?? []),
      ...t.kinds,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
