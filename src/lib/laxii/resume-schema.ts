/**
 * LAXII Resume Studio — document schema and presets.
 *
 * Data model follows the JSON Resume schema (jsonresume.org, MIT —
 * @jsonresume/schema v1.7.0) structure: basics / work / education / skills /
 * projects / certificates / awards. It is deliberately kept as a typed
 * internal contract (zod-validated) rather than pulling in the npm validator
 * package, so the schema can evolve with product needs while staying
 * wire-compatible with the open standard.
 *
 * Anti-fabrication contract: AI-generated wording may only rephrase and
 * organize content the user supplied. `assertNoInventedEntities` (resume-
 * service.ts) cross-checks organizations/institutions against the facts
 * snapshot before any draft is accepted.
 */

import { z } from "zod";

// ------------------------------------------------------------------ schema

export const resumeBasicsSchema = z.object({
  name: z.string().max(120).default(""),
  label: z.string().max(120).default(""), // target job title
  email: z.string().max(160).default(""),
  phone: z.string().max(60).default(""),
  website: z.string().max(240).default(""),
  location: z.string().max(160).default(""),
  summary: z.string().max(2000).default(""),
});

export const resumeWorkSchema = z.object({
  company: z.string().max(160).default(""),
  position: z.string().max(160).default(""),
  startDate: z.string().max(40).default(""), // "2021-03" or "March 2021"
  endDate: z.string().max(40).default(""), // empty + current = present
  current: z.boolean().default(false),
  summary: z.string().max(1200).default(""),
  highlights: z.array(z.string().max(400)).max(10).default([]),
});

export const resumeEducationSchema = z.object({
  institution: z.string().max(200).default(""),
  area: z.string().max(160).default(""), // field of study
  studyType: z.string().max(120).default(""), // degree
  startDate: z.string().max(40).default(""),
  endDate: z.string().max(40).default(""),
  score: z.string().max(40).default(""), // GPA / percentage
});

export const resumeSkillSchema = z.object({
  name: z.string().max(80).default(""),
  level: z.string().max(60).default(""),
});

export const resumeProjectSchema = z.object({
  name: z.string().max(160).default(""),
  description: z.string().max(800).default(""),
  highlights: z.array(z.string().max(300)).max(8).default([]),
  url: z.string().max(240).default(""),
});

export const resumeCertificateSchema = z.object({
  name: z.string().max(200).default(""),
  issuer: z.string().max(160).default(""),
  date: z.string().max(40).default(""),
});

export const resumeAwardSchema = z.object({
  title: z.string().max(200).default(""),
  awarder: z.string().max(160).default(""),
  date: z.string().max(40).default(""),
  summary: z.string().max(400).default(""),
});

/**
 * Profession-adaptable custom sections (publications, licences, showreels,
 * clinical rotations…). Entries are generic so one renderer serves them all.
 * Custom content is USER-supplied fact material — the AI never invents or
 * edits it (enforced in resume-service.ts, which only generates core
 * sections and merges custom sections through untouched).
 */
export const resumeCustomEntrySchema = z.object({
  title: z.string().max(200).default(""),
  subtitle: z.string().max(200).default(""), // outlet/venue/issuer, role…
  meta: z.string().max(120).default(""), // date, location, reference
  summary: z.string().max(800).default(""),
  highlights: z.array(z.string().max(300)).max(8).default([]),
  url: z.string().max(240).default(""),
});

export const resumeCustomSectionSchema = z.object({
  /** Stable slug (e.g. "publications"). Document refs are "custom:<key>". */
  key: z
    .string()
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Section key must be a lowercase slug"),
  /** Display title — user-renameable, defaults from the profession preset. */
  title: z.string().max(80).default(""),
  entries: z.array(resumeCustomEntrySchema).max(20).default([]),
});

export type ResumeCustomSection = z.infer<typeof resumeCustomSectionSchema>;

export const resumeDataSchema = z.object({
  basics: resumeBasicsSchema.default({
    name: "",
    label: "",
    email: "",
    phone: "",
    website: "",
    location: "",
    summary: "",
  }),
  work: z.array(resumeWorkSchema).max(15).default([]),
  education: z.array(resumeEducationSchema).max(10).default([]),
  skills: z.array(resumeSkillSchema).max(40).default([]),
  projects: z.array(resumeProjectSchema).max(10).default([]),
  certificates: z.array(resumeCertificateSchema).max(15).default([]),
  awards: z.array(resumeAwardSchema).max(10).default([]),
  custom: z.array(resumeCustomSectionSchema).max(8).default([]),
  /**
   * Document section order — core section keys plus the "custom:*" wildcard
   * (all custom sections render at that position in their stored order).
   * Empty list = legacy fixed order (summary → … → awards → custom:*).
   */
  order: z.array(z.string().max(40)).max(16).default([]),
  /** Section heading overrides (rename). Missing keys use default headings. */
  titles: z.record(z.string().max(40), z.string().max(80)).default({}),
});

export type ResumeData = z.infer<typeof resumeDataSchema>;
export type ResumeBasics = z.infer<typeof resumeBasicsSchema>;

/** Section keys used for provenance marking (aiTouched) and UI grouping. */
export const RESUME_SECTIONS = [
  "basics",
  "summary",
  "work",
  "education",
  "skills",
  "projects",
  "certificates",
  "awards",
] as const;
export type ResumeSectionKey = (typeof RESUME_SECTIONS)[number];

export function emptyResumeData(): ResumeData {
  return resumeDataSchema.parse({});
}

// ------------------------------------------------------------- resume types

export interface LaxiiResumeType {
  slug: string;
  label: string;
  blurb: string;
  /** Default template applied when this type is chosen. */
  template: ResumeTemplateId;
  /**
   * Document structure: the section order this format produces. Core keys
   * render when they hold content; "custom:*" renders the user's custom
   * sections at that position. This is what makes formats genuinely
   * different documents — not just different colours.
   */
  order: string[];
  /** Generation guidance appended to the system prompt. */
  guidance: string;
}

export const RESUME_TEMPLATES = ["classic", "modern", "minimal", "creative"] as const;
export type ResumeTemplateId = (typeof RESUME_TEMPLATES)[number];

/** Legacy fixed order (documents saved before formats existed). */
export const RESUME_DEFAULT_ORDER = ["summary", "work", "education", "skills", "projects", "certificates", "awards", "custom:*"];

export const RESUME_TYPES: LaxiiResumeType[] = [
  {
    slug: "ats",
    label: "ATS-friendly professional",
    blurb: "Single column, standard headings, parser-safe.",
    template: "classic",
    order: ["summary", "work", "education", "skills", "projects", "certificates", "awards", "custom:*"],
    guidance:
      "Produce a strictly ATS-safe resume: standard section headings (Summary, Experience, Education, Skills, Projects, Certifications, Awards), single-column structure, no references to graphics, plain professional language.",
  },
  {
    slug: "modern",
    label: "Modern professional",
    blurb: "Contemporary typography, crisp accent styling.",
    template: "modern",
    order: ["summary", "work", "skills", "education", "projects", "certificates", "awards", "custom:*"],
    guidance:
      "Modern professional tone: concise confident phrasing, quantified achievements where the facts support them, crisp section summaries.",
  },
  {
    slug: "minimal",
    label: "Minimal",
    blurb: "Quiet layout, essential content only.",
    template: "minimal",
    order: ["summary", "work", "skills", "education"],
    guidance:
      "Minimalist tone: short sentences, ruthless brevity, only the strongest content kept prominent, generous use of compact bullet lines. Omit sections the facts barely fill.",
  },
  {
    slug: "creative",
    label: "Creative",
    blurb: "Distinctive voice for design-forward roles.",
    template: "creative",
    order: ["summary", "projects", "work", "education", "skills", "custom:*"],
    guidance:
      "Creative-professional tone: a memorable personal-summary voice, still factual and ATS-parseable — creative phrasing, never invented content. Work and projects lead the narrative.",
  },
  {
    slug: "technical",
    label: "Technical",
    blurb: "Engineering-focused with a tight skills matrix.",
    template: "modern",
    order: ["summary", "skills", "work", "projects", "education", "certificates", "custom:*"],
    guidance:
      "Technical tone: lead with concrete technologies, systems and measurable outcomes; group skills logically (languages, frameworks, tools, platforms); keep bullets implementation-specific.",
  },
  {
    slug: "fresher",
    label: "Fresh graduate",
    blurb: "Education-first structure for early careers.",
    template: "classic",
    order: ["education", "projects", "work", "skills", "certificates", "awards", "custom:*"],
    guidance:
      "Entry-level ordering: place Education and Projects before Work Experience; emphasize coursework, internships, academic projects and potential; keep the summary forward-looking but grounded in provided facts only.",
  },
  {
    slug: "experienced",
    label: "Experienced professional",
    blurb: "Impact-led senior career narrative.",
    template: "modern",
    order: ["summary", "work", "skills", "education", "certificates", "awards", "custom:*"],
    guidance:
      "Senior tone: lead each role with scope and impact, quantify results where the facts include numbers, show progression across roles, keep the summary executive-grade.",
  },
  {
    slug: "executive",
    label: "Executive",
    blurb: "Board-ready leadership and outcomes summary.",
    template: "classic",
    order: ["summary", "work", "education", "skills", "awards", "custom:*"],
    guidance:
      "Executive framing: an authoritative summary of scope (team size, P&L, mandate), then leadership roles emphasizing strategy and outcomes the facts actually support, then board/venture involvement. Dignified, measured language — no buzzword inflation.",
  },
  {
    slug: "academic-cv",
    label: "Academic CV",
    blurb: "Teaching + research dossier with publications.",
    template: "classic",
    order: ["summary", "education", "work", "custom:*", "projects", "skills"],
    guidance:
      "Academic CV structure: open with research/teaching interests as the summary, then Education in full detail, followed by teaching and research appointments. Publications, conference papers and grants arrive via the candidate's custom sections — render them prominently and never fabricate citations, venues or years.",
  },
  {
    slug: "research-cv",
    label: "Research CV",
    blurb: "Research-first: projects, funding, outputs.",
    template: "minimal",
    order: ["summary", "education", "projects", "custom:*", "work", "skills"],
    guidance:
      "Research CV: lead with research focus, then education, then research projects with methods and findings strictly as provided. Publications/grants/conferences come from the candidate's custom sections — never invented.",
  },
  {
    slug: "journalism-cv",
    label: "Journalism & media CV",
    blurb: "Bylines, beats and broadcast credits up front.",
    template: "modern",
    order: ["summary", "work", "custom:*", "education", "skills"],
    guidance:
      "Journalism & media structure: after the summary, newsroom/broadcast experience leads, followed by the candidate's clips, bylines, beats and showreel sections. Skills highlight languages and delivery. Every byline, outlet and date must come from the candidate's input.",
  },
  {
    slug: "healthcare-cv",
    label: "Healthcare professional CV",
    blurb: "Registration, qualifications, clinical roles.",
    template: "classic",
    order: ["summary", "education", "certificates", "work", "custom:*", "skills"],
    guidance:
      "Healthcare structure: qualifications and professional registration before employment, then clinical experience by setting/seniority. NEVER include patient identifiers or case details — describe scope, settings and procedures the candidate is trained for. Licences/registration come from the candidate's custom sections.",
  },
  {
    slug: "engineering-cv",
    label: "Engineering CV",
    blurb: "Disciplines, standards and technical projects.",
    template: "modern",
    order: ["summary", "work", "projects", "skills", "education", "certificates", "custom:*"],
    guidance:
      "Engineering structure: roles with the systems/standards involved, then technical projects, then the tools-and-standards matrix. Licences and compliance experience arrive via custom sections — never fabricated.",
  },
  {
    slug: "portfolio-cv",
    label: "Portfolio-led creative CV",
    blurb: "Work samples and case studies first.",
    template: "creative",
    order: ["projects", "work", "custom:*", "skills", "education", "summary"],
    guidance:
      "Portfolio-led structure: selected work/case studies open the document (the summary becomes a closing profile), then client/studio experience, then the candidate's portfolio and exhibition sections. Keep project descriptions vivid but strictly factual.",
  },
  {
    slug: "freelance-cv",
    label: "Freelance & consultant CV",
    blurb: "Engagements, clients and outcomes.",
    template: "modern",
    order: ["summary", "work", "projects", "custom:*", "skills", "education"],
    guidance:
      "Freelance/consultant structure: a positioning summary, then engagements framed as client work (scope, duration, outcome as evidenced), then selected clients and testimonials from the candidate's custom sections. Never invent client names or results.",
  },
  {
    slug: "international-cv",
    label: "International professional CV",
    blurb: "Globally portable, details diplomatic roles expect.",
    template: "classic",
    order: ["summary", "work", "education", "skills", "custom:*", "certificates"],
    guidance:
      "International CV: globally understood headings, full education detail with institutions and dates spelled out, work without country-specific jargon. Languages and international exposure from custom sections are welcome. Keep personal data limited to what the candidate provided.",
  },
  {
    slug: "role-specific",
    label: "Role-specific tailored",
    blurb: "Tuned to a supplied job description.",
    template: "modern",
    order: ["summary", "work", "skills", "projects", "education", "certificates", "awards", "custom:*"],
    guidance:
      "Role-targeted framing: align the summary, skill ordering and achievement emphasis with the supplied job description wording — using ONLY the candidate's real experience.",
  },
];

export function findResumeType(slug: string): LaxiiResumeType | null {
  return RESUME_TYPES.find((t) => t.slug === slug) ?? null;
}

/** Section order for a type slug, falling back to the legacy fixed order. */
export function resumeTypeOrder(slug: string): string[] {
  return findResumeType(slug)?.order ?? RESUME_DEFAULT_ORDER;
}

// ------------------------------------------------------- document rendering

/** Default display headings for the core sections (before renames). */
export const RESUME_CORE_TITLES: Record<string, string> = {
  summary: "Summary",
  work: "Experience",
  education: "Education",
  skills: "Skills",
  projects: "Projects",
  certificates: "Certifications",
  awards: "Awards",
};

export type ResolvedResumeSection =
  | { kind: "summary" | "work" | "education" | "skills" | "projects" | "certificates" | "awards"; title: string }
  | { kind: "custom"; title: string; section: ResumeCustomSection };

function sectionHasContent(data: ResumeData, key: string): boolean {
  switch (key) {
    case "summary":
      return Boolean(data.basics.summary.trim());
    case "work":
      return data.work.length > 0;
    case "education":
      return data.education.length > 0;
    case "skills":
      return data.skills.some((s) => s.name.trim());
    case "projects":
      return data.projects.length > 0;
    case "certificates":
      return data.certificates.length > 0;
    case "awards":
      return data.awards.length > 0;
    default:
      return false;
  }
}

/**
 * Resolve the document's display sections in order. Honors `data.order`
 * (core keys + "custom:*" + "custom:<key>"), `data.titles` renames, and
 * skips sections with no content. Exporters and the live preview both use
 * this, so the paper output always matches what the user arranged.
 */
export function orderedResumeSections(data: ResumeData): ResolvedResumeSection[] {
  const order = data.order.length > 0 ? data.order : RESUME_DEFAULT_ORDER;
  const out: ResolvedResumeSection[] = [];
  let wildcardAt = -1;
  const placedCustomKeys = new Set<string>();
  for (const ref of order) {
    if (ref === "custom:*") {
      wildcardAt = out.length;
      for (const c of data.custom) {
        if (c.entries.length > 0) {
          out.push({ kind: "custom", title: c.title || c.key, section: c });
          placedCustomKeys.add(c.key);
        }
      }
      continue;
    }
    if (ref.startsWith("custom:")) {
      const c = data.custom.find((x) => x.key === ref.slice("custom:".length));
      if (c && c.entries.length > 0) {
        out.push({ kind: "custom", title: c.title || c.key, section: c });
        placedCustomKeys.add(c.key);
      }
      continue;
    }
    if (sectionHasContent(data, ref)) {
      out.push({
        kind: ref as "summary" | "work" | "education" | "skills" | "projects" | "certificates" | "awards",
        title: data.titles[ref]?.trim() || RESUME_CORE_TITLES[ref],
      });
    }
  }
  // Legacy documents: custom sections exist but the order has no wildcard —
  // append any unplaced sections at the end rather than dropping content.
  if (wildcardAt === -1) {
    for (const c of data.custom) {
      if (c.entries.length > 0 && !placedCustomKeys.has(c.key)) {
        out.push({ kind: "custom", title: c.title || c.key, section: c });
      }
    }
  }
  return out;
}

// -------------------------------------------------------- fact input schema

/** What the user provides before generation. Everything optional except a name. */
export const resumeFactsSchema = z.object({
  basics: resumeBasicsSchema.extend({ name: z.string().min(1, "Name is required").max(120) }),
  work: z.array(resumeWorkSchema).max(15).default([]),
  education: z.array(resumeEducationSchema).max(10).default([]),
  skills: z.array(z.union([z.string().max(80), resumeSkillSchema])).max(40).default([]),
  projects: z.array(resumeProjectSchema).max(10).default([]),
  certificates: z.array(resumeCertificateSchema).max(15).default([]),
  awards: z.array(resumeAwardSchema).max(10).default([]),
  /** Profession-specific sections supplied by the user (publications, licences…). */
  custom: z.array(resumeCustomSectionSchema).max(8).default([]),
});

export type ResumeFacts = z.infer<typeof resumeFactsSchema>;

/** Normalize loose skill strings into {name} entries. */
export function normalizeSkills(facts: ResumeFacts): { name: string; level: string }[] {
  return facts.skills.map((s) => (typeof s === "string" ? { name: s, level: "" } : { name: s.name, level: s.level ?? "" }));
}
