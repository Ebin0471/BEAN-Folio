/**
 * LAXII Resume Studio — M33.5-B deterministic document analysis.
 *
 * Two SEPARATE reports, never one mysterious score (spec §5.1):
 *
 *  A. Document Readability Report — measurable structural risk factors of
 *     the resume DOCUMENT (contact presence, recognizable headings, date
 *     consistency, fragmented text, URL readability, length advisory).
 *     Versioned schema with stable check ids and an explicit `untested`
 *     list: vendor ATS behaviour is NEVER emulated or predicted.
 *
 *  B. Job Requirement Evidence Map — compares the (user-pasted) job
 *     description with explicit user-confirmed facts and shows which
 *     requirements have evidence: supported / partial / missing /
 *     not_assessable, each citing the resume fact(s) behind the verdict.
 *
 * Honesty rules enforced here:
 *  - No "ATS score", no pass-rate, no hiring probability. Weighted coverage
 *    is a descriptive calculation with a PUBLISHED formula (§5.3) and no
 *    probability interpretation.
 *  - Matching is exact-normalized phrase/alias matching with word
 *    boundaries — never substrings (Java must not match JavaScript), with a
 *    curated alias table and preserved negation/proficiency context.
 *  - Years-of-experience claims come only from transparent date math on
 *    parseable ranges; gaps are never bridged.
 *  - The report names its evaluator version and says it is a practical
 *    diagnostic, not an employer ATS simulation (§9.1).
 */

import { z } from "zod";

import { orderedResumeSections, resumeDataSchema, type ResumeData, type ResumeFacts } from "./resume-schema";
import { normalizeSkills } from "./resume-schema";

export const READABILITY_REPORT_VERSION = 1 as const;
export const EVIDENCE_MAP_VERSION = 1 as const;
export const EVALUATOR_VERSION = "m33.5-readability-1" as const;

// ------------------------------------------------------------------ schemas

const readabilityCheckSchema = z.object({
  id: z.string().max(60),
  category: z.enum(["text", "structure", "contact", "dates", "links", "layout", "length", "round-trip"]),
  status: z.enum(["pass", "warning", "fail", "not-run"]),
  severity: z.enum(["info", "minor", "major", "critical"]),
  /** Measured evidence — bounded, fact-citing, PII-safe by construction. */
  detail: z.string().max(400),
  remediation: z.string().max(300).default(""),
});

const fileFactsSchema = z.object({
  documentKind: z.enum(["resume"]),
  template: z.string().max(40),
  sectionCount: z.number().int().nonnegative(),
  workEntries: z.number().int().nonnegative(),
  educationEntries: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  extractedChars: z.number().int().nonnegative(),
  longestParagraphChars: z.number().int().nonnegative(),
});

export const readabilityReportSchema = z.object({
  reportVersion: z.literal(READABILITY_REPORT_VERSION),
  evaluator: z.literal(EVALUATOR_VERSION),
  evaluatedAt: z.string(),
  status: z.enum(["good", "review", "problem", "not-run"]),
  checks: z.array(readabilityCheckSchema).max(40),
  untested: z.array(z.string().max(300)),
  fileFacts: fileFactsSchema,
});

export type ReadabilityReport = z.infer<typeof readabilityReportSchema>;
export type ReadabilityCheck = z.infer<typeof readabilityCheckSchema>;

const requirementSchema = z.object({
  kind: z.enum(["skill", "qualification", "responsibility", "education", "licence", "seniority", "language", "location", "work-mode", "other"]),
  importance: z.enum(["required", "preferred"]),
  text: z.string().max(200),
  /** Bounded source span from the pasted job description (evidence). */
  sourcePhrase: z.string().max(200),
});

export const jobRequirementProfileSchema = z.object({
  profileVersion: z.literal(EVIDENCE_MAP_VERSION),
  roleTitle: z.string().max(160).default(""),
  organization: z.string().max(160).default(""),
  requirements: z.array(requirementSchema).max(60),
  parseWarnings: z.array(z.string().max(200)).max(8),
});

export type JobRequirementProfile = z.infer<typeof jobRequirementProfileSchema>;
export type JobRequirement = z.infer<typeof requirementSchema>;

const evidenceCitationSchema = z.object({
  /** Where in the resume the evidence lives (section + entity, PII-safe). */
  section: z.string().max(40),
  fact: z.string().max(200),
});

export const requirementEvidenceSchema = z.object({
  requirement: requirementSchema,
  verdict: z.enum(["supported", "partial", "missing", "not_assessable"]),
  citations: z.array(evidenceCitationSchema).max(4),
  /** Question for the user when evidence is partial/missing — never a claim. */
  followUp: z.string().max(240).default(""),
});

export const jobEvidenceMapSchema = z.object({
  mapVersion: z.literal(EVIDENCE_MAP_VERSION),
  profile: jobRequirementProfileSchema,
  evidence: z.array(requirementEvidenceSchema).max(60),
  /**
   * Descriptive weighted coverage. Published formula (§5.3):
   *   coverage = Σ(weight · verdictScore) / Σ(weight)
   *   weight: required = 1, preferred = 0.5
   *   verdictScore: supported = 1, partial = 0.5, missing = 0,
   *                 not_assessable = excluded from Σ(weight)
   * NO probability interpretation — it says nothing about any employer's
   * screening outcome.
   */
  weightedCoverage: z.object({
    formula: z.literal("Σ(weight·score)/Σ(weight); required=1, preferred=0.5; supported=1, partial=0.5, missing=0; not_assessable excluded"),
    value: z.number().min(0).max(1),
    assessedRequirements: z.number().int().nonnegative(),
    excludedNotAssessable: z.number().int().nonnegative(),
  }),
  matchWarnings: z.array(z.string().max(220)).max(8),
});

export type JobEvidenceMap = z.infer<typeof jobEvidenceMapSchema>;
export type RequirementEvidence = z.infer<typeof requirementEvidenceSchema>;

// ------------------------------------------------------------- text helpers

function normToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();
}

function tokensOf(s: string): string[] {
  return normToken(s).split(" ").filter((t) => t.length > 0);
}

/** Whole-phrase word-boundary match on normalized token sequences. */
function phraseInText(phrase: string, textTokens: string[]): boolean {
  const p = tokensOf(phrase);
  if (p.length === 0 || p.length > 12) return false;
  for (let i = 0; i <= textTokens.length - p.length; i += 1) {
    let ok = true;
    for (let j = 0; j < p.length; j += 1) {
      if (textTokens[i + j] !== p[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Curated alias map — every alias is a controlled expansion, applied with
 * word boundaries so `java` never matches inside `javascript`. Extending
 * this table is a code change with tests (explainable, per spec §5.3).
 */
const SKILL_ALIASES: [canonical: string, aliases: string[]][] = [
  ["javascript", ["javascript", "js", "es6", "ecmascript"]],
  ["typescript", ["typescript", "ts"]],
  ["react", ["react", "react.js", "reactjs"]],
  ["react native", ["react native", "react-native", "rn"]],
  ["node.js", ["node.js", "node", "nodejs"]],
  ["postgresql", ["postgresql", "postgres", "psql"]],
  ["kubernetes", ["kubernetes", "k8s"]],
  ["aws", ["aws", "amazon web services"]],
  ["gcp", ["gcp", "google cloud"]],
  ["c", ["c"]],
  ["c++", ["c++", "cpp"]],
  ["c#", ["c#", "csharp", "c sharp"]],
  ["figma", ["figma"]],
  ["photoshop", ["photoshop", "ps"]],
  ["seo", ["seo", "search engine optimization"]],
  ["machine learning", ["machine learning", "ml"]],
  ["llm", ["llm", "large language model", "large language models"]],
  ["graphql", ["graphql"]],
  ["kafka", ["kafka"]],
];

/** alias (normalized) → canonical, longest-first so specific aliases win. */
const ALIAS_LOOKUP: [aliasNorm: string, canonical: string][] = SKILL_ALIASES.flatMap(([canonical, aliases]) =>
  aliases.map((a) => [normToken(a), canonical] as [string, string])
).sort((a, b) => b[0].length - a[0].length);

/** Map a skill-ish string to its controlled canonical name (or null). */
function canonicalSkill(s: string): string | null {
  const t = tokensOf(s);
  if (t.length === 0) return null;
  for (const [alias, canonical] of ALIAS_LOOKUP) {
    if (phraseInText(alias, t)) return canonical;
  }
  return null;
}

function skillMatches(requirement: string, haystackTokens: string[]): boolean {
  const reqCanon = canonicalSkill(requirement);
  if (reqCanon) {
    // The requirement names a controlled skill: evidence must resolve to the
    // SAME canonical skill (alias-expansion on both sides).
    const hayCanon = canonicalSkill(haystackTokens.join(" "));
    if (hayCanon === reqCanon) return true;
    return phraseInText(normToken(reqCanon), haystackTokens);
  }
  return phraseInText(normToken(requirement), haystackTokens);
}

/** Proficiency context: "basic exposure to X" is NOT evidence of expert X. */
function isDiminishedContext(sentence: string, phrase: string): boolean {
  const idx = sentence.toLowerCase().indexOf(phrase.toLowerCase());
  if (idx < 0) return false;
  const before = sentence.slice(Math.max(0, idx - 60), idx);
  return /\b(basic|fundamental|familiar|no|not|little|some|awareness|exposure)\b/i.test(before);
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ------------------------------------------------- A. readability report

export interface ReadabilityInput {
  data: ResumeData;
  template: string;
  /** Optional extracted text of the EXPORTED file (round-trip mode). */
  exportedText?: string;
  /** Export metadata when verifying produced bytes. */
  roundTrip?: {
    format: "pdf" | "docx";
    byteLength: number;
    decodeOk: boolean;
    missingFacts: string[];
    charCount: number;
  };
  /** Configurable advisory (spec §5.2 check 10): pages, per document kind. */
  pageAdvisory?: { pages: number; softLimit: number };
}

const HEADING_WORDS = [
  "summary", "profile", "objective", "experience", "employment", "work history",
  "education", "skills", "projects", "certifications", "certificates", "awards",
  "achievements", "publications", "languages", "interests", "volunteer", "references",
];

/** Extract comparable key facts from the saved document (round-trip + contact checks). */
export function documentKeyFacts(data: ResumeData): string[] {
  const facts: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t) facts.push(t);
  };
  push(data.basics.name);
  push(data.basics.email);
  push(data.basics.phone);
  push(data.basics.location);
  push(data.basics.website);
  for (const w of data.work) {
    push(w.company);
    push(w.position);
  }
  for (const e of data.education) push(e.institution);
  for (const s of data.skills) push(s.name);
  for (const s of orderedResumeSections(data)) if (s.kind === "custom") for (const e of s.section.entries) push(e.title);
  return facts.filter((f) => f.length >= 3);
}

function fragmentScore(text: string): { fragmented: boolean; sample: string } {
  // Word-level fragmentation: many 1–2 char "words" separated by single spaces.
  const chunks = text.split(/\s+/).filter(Boolean);
  if (chunks.length < 40) return { fragmented: false, sample: "" };
  const shortish = chunks.filter((c) => c.length <= 2).length;
  const ratio = shortish / chunks.length;
  return {
    fragmented: ratio > 0.35,
    sample: chunks.slice(0, 12).join(" "),
  };
}

function dateMonthKey(s: string): { y: number; m: number } | null {
  const t = s.trim().toLowerCase();
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  let m = /^(\d{4})-(\d{1,2})$/.exec(t);
  if (m) return { y: Number(m[1]), m: Number(m[2]) };
  m = /^(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return { y: Number(m[2]), m: Number(m[1]) };
  m = /^([a-z]{3,9})\.?\s+(\d{4})$/.exec(t);
  if (m) {
    const mi = months.indexOf(m[1].slice(0, 3));
    if (mi >= 0) return { y: Number(m[2]), m: mi + 1 };
  }
  m = /^(\d{4})$/.exec(t);
  if (m) return { y: Number(m[1]), m: 0 };
  return null;
}

/**
 * A. Document Readability Report. Deterministic over the SAVED ResumeData
 * (the same object the preview and exporters consume) plus optional
 * round-trip results from the produced export bytes.
 */
export function analyzeReadability(input: ReadabilityInput): ReadabilityReport {
  const { data } = input;
  const checks: ReadabilityCheck[] = [];
  const add = (c: ReadabilityCheck) => checks.push(c);

  const sections = orderedResumeSections(data);
  const skills = data.skills.map((s) => s.name.trim()).filter(Boolean);
  const exported = input.exportedText ?? "";
  const facts = documentKeyFacts(data);

  // -- contact ------------------------------------------------------------
  const hasContact = Boolean(data.basics.email.trim() || data.basics.phone.trim());
  add({
    id: "contact.present",
    category: "contact",
    status: hasContact ? "pass" : "warning",
    severity: hasContact ? "info" : "major",
    detail: hasContact
      ? "At least one contact channel (email or phone) is present in the document."
      : "No email or phone in the document — recruiters and parsers expect at least one.",
    remediation: hasContact ? "" : "Add an email address or phone number to Personal details.",
  });

  if (data.basics.name.trim()) {
    const inExport = !exported || exported.includes(data.basics.name.trim());
    add({
      id: "contact.name-extractable",
      category: "contact",
      status: inExport ? "pass" : "fail",
      severity: "critical",
      detail: inExport
        ? "The name appears as extractable text (checked against the exported file when provided)."
        : "The name is MISSING from the extracted export text — the export may not be machine-readable.",
      remediation: inExport ? "" : "Re-export; if it persists, use the ATS-friendly layout template.",
    });
  }

  // -- structure ------------------------------------------------------------
  const headingTitles = sections.map((s) => s.title.toLowerCase().replace(/[^a-z ]+/g, " ").trim());
  const recognized = headingTitles.filter((t) => HEADING_WORDS.some((w) => t === w || t.startsWith(w))).length;
  const sectionStatus = sections.length === 0 ? "fail" : recognized === sections.length ? "pass" : recognized > 0 ? "warning" : "fail";
  add({
    id: "structure.headings-recognizable",
    category: "structure",
    status: sectionStatus,
    severity: sectionStatus === "fail" ? "critical" : sectionStatus === "warning" ? "minor" : "info",
    detail:
      sections.length === 0
        ? "The document has no renderable sections."
        : `${recognized}/${sections.length} section headings match conventional resume vocabulary (${sections.map((s) => s.title).slice(0, 6).join(", ")}${sections.length > 6 ? ", …" : ""}).`,
    remediation: sectionStatus === "pass" ? "" : "Prefer standard headings (Experience, Education, Skills…) — renamed headings stay but unusual words can confuse parsers.",
  });

  const orderKeys = data.order.length > 0 ? data.order : [];
  add({
    id: "structure.order-coherent",
    category: "structure",
    status: "pass",
    severity: "info",
    detail:
      orderKeys.length > 0
        ? `Explicit section order stored (${orderKeys.length} refs); preview and both exporters render the same order.`
        : "Legacy fixed order in use (Summary → Experience → …); consistent across preview and exports.",
    remediation: "",
  });

  // -- text ---------------------------------------------------------------
  const prose = [
    data.basics.summary,
    ...data.work.map((w) => `${w.summary} ${w.highlights.join(" ")}`),
    ...data.projects.map((p) => `${p.description} ${p.highlights.join(" ")}`),
    ...data.awards.map((a) => a.summary),
  ]
    .join(" ")
    .trim();
  // Fragmentation shows up in the EXTRACTED bytes when available (broken
  // PDFs, textbox soup); the document model is the fallback.
  const frag = fragmentScore(exported || prose);
  add({
    id: "text.not-fragmented",
    category: "text",
    status: frag.fragmented ? "warning" : "pass",
    severity: frag.fragmented ? "major" : "info",
    detail: frag.fragmented
      ? `Text shows word-fragmentation patterns (>35% single characters) — typical of textboxes or broken PDFs. Sample: "${frag.sample.slice(0, 80)}"`
      : "Text reads as whole words and sentences in the document model.",
    remediation: frag.fragmented ? "Avoid textboxes/columns; regenerate the export from the standard templates." : "",
  });

  const replacementGlyphs = /[\uFFFD]/.test(exported);
  if (exported) {
    add({
      id: "text.no-replacement-glyphs",
      category: "text",
      status: replacementGlyphs ? "fail" : "pass",
      severity: replacementGlyphs ? "critical" : "info",
      detail: replacementGlyphs
        ? "The extracted export text contains U+FFFD replacement characters — some characters did not survive encoding."
        : "No replacement glyphs in the extracted export text.",
      remediation: replacementGlyphs ? "Check for uncommon characters/emoji in the document and re-export." : "",
    });
  }

  // -- dates ----------------------------------------------------------------
  const dated = data.work.filter((w) => w.startDate.trim() || w.endDate.trim() || w.current);
  const undated = data.work.length - dated.length;
  add({
    id: "dates.work-dated",
    category: "dates",
    status: data.work.length === 0 ? "not-run" : undated === 0 ? "pass" : "warning",
    severity: undated > 0 ? "minor" : "info",
    detail:
      data.work.length === 0
        ? "No work entries — date checks do not apply."
        : undated === 0
          ? `All ${data.work.length} roles carry dates.`
          : `${undated} of ${data.work.length} roles have no dates at all.`,
    remediation: undated > 0 ? "Add start (and end) dates — parsers and recruiters expect them." : "",
  });

  const parsedRanges = data.work
    .map((w) => ({ start: dateMonthKey(w.startDate), end: w.current ? null : dateMonthKey(w.endDate), w }))
    .filter((r) => r.start);
  const malformedDates = data.work.filter((w) => (w.startDate.trim() && !dateMonthKey(w.startDate)) || (!w.current && w.endDate.trim() && !dateMonthKey(w.endDate))).length;
  add({
    id: "dates.parseable",
    category: "dates",
    status: data.work.length === 0 ? "not-run" : malformedDates === 0 ? "pass" : "warning",
    severity: malformedDates > 0 ? "minor" : "info",
    detail:
      data.work.length === 0
        ? "No work entries."
        : malformedDates === 0
          ? `${parsedRanges.length} date ranges parse to year/month values.`
          : `${malformedDates} date(s) could not be parsed (e.g. "early 2021") — parsers prefer "2021-03" or "Mar 2021" formats.`,
    remediation: malformedDates > 0 ? 'Use "YYYY-MM" or "Mon YYYY" date formats.' : "",
  });

  let overlap = false;
  for (let a = 0; a < parsedRanges.length; a += 1) {
    for (let b = a + 1; b < parsedRanges.length; b += 1) {
      const A = parsedRanges[a];
      const B = parsedRanges[b];
      if (!A.start || !B.start || !A.start.m || !B.start.m) continue; // year-only → skip
      const aEnd = A.end ? A.end.y * 12 + A.end.m : 9000 * 12;
      const bStart = B.start.y * 12 + B.start.m;
      const aStart = A.start.y * 12 + A.start.m;
      if (bStart < aEnd && bStart >= aStart) overlap = true;
    }
  }
  if (data.work.length > 1) {
    add({
      id: "dates.overlap-flagged",
      category: "dates",
      status: overlap ? "warning" : "pass",
      severity: "minor",
      detail: overlap
        ? "Two roles overlap in time. Overlapping jobs are legitimate (contract + staff, promotion spans) — confirm the dates are intentional."
        : "No unexpected date overlaps among month-precise roles.",
      remediation: "",
    });
  }

  // -- links ----------------------------------------------------------------
  const urlsInDocument = [
    data.basics.website,
    ...data.projects.map((p) => p.url),
    ...data.custom.flatMap((c) => c.entries.map((e) => e.url)),
  ]
    .map((u) => u.trim())
    .filter(Boolean);
  add({
    id: "links.text-readable",
    category: "links",
    status: urlsInDocument.length === 0 ? "not-run" : "pass",
    severity: "info",
    detail:
      urlsInDocument.length === 0
        ? "No URLs in the document."
        : `${urlsInDocument.length} URL(s) stored as plain text (never icon-only): ${urlsInDocument[0].slice(0, 60)}${urlsInDocument.length > 1 ? "…" : ""}`,
    remediation: "",
  });

  // -- layout ----------------------------------------------------------------
  add({
    id: "layout.single-column",
    category: "layout",
    status: "pass",
    severity: "info",
    detail:
      "The BEAN exporters render a single-column flow with semantic text (no layout tables, no text boxes, no header/footer-only content). Creative templates restyle typography only.",
    remediation: "",
  });

  // -- length advisory (configurable, never a fixed rule — §5.2 check 10) ----
  if (input.pageAdvisory) {
    const { pages, softLimit } = input.pageAdvisory;
    add({
      id: "length.page-advisory",
      category: "length",
      status: pages <= softLimit ? "pass" : "warning",
      severity: "minor",
      detail: pages <= softLimit
        ? `${pages} page(s) — within the configured advisory limit of ${softLimit} for this document.`
        : `${pages} page(s) exceed the configured advisory of ${softLimit}. This is NOT a rule: academic CVs and detailed research dossiers are legitimately long.`,
      remediation: "",
    });
  } else {
    add({
      id: "length.page-advisory",
      category: "length",
      status: "not-run",
      severity: "info",
      detail: "Page count not provided — length advisory not evaluated.",
      remediation: "",
    });
  }

  // -- round trip ------------------------------------------------------------
  if (input.roundTrip) {
    const rt = input.roundTrip;
    const missingCount = rt.missingFacts.length;
    add({
      id: "round-trip.text-integrity",
      category: "round-trip",
      status: !rt.decodeOk ? "fail" : missingCount === 0 ? "pass" : "warning",
      severity: !rt.decodeOk ? "critical" : missingCount > 0 ? "major" : "info",
      detail: !rt.decodeOk
        ? `The exported ${rt.format.toUpperCase()} could not be decoded/re-read — it cannot be verified.`
        : missingCount === 0
          ? `Re-extracted ${rt.charCount} characters from the produced ${rt.format.toUpperCase()} (${rt.byteLength} bytes); all checked key facts survived in order.`
          : `Re-extracted text is missing ${missingCount} key fact(s): ${rt.missingFacts.slice(0, 3).join(", ")}${missingCount > 3 ? "…" : ""}.`,
      remediation: missingCount > 0 ? "Review the missing items — if they matter, re-export or switch template." : "",
    });
  }

  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warning").length;
  const status = failCount > 0 ? "problem" : warnCount > 0 ? "review" : "good";

  return readabilityReportSchema.parse({
    reportVersion: READABILITY_REPORT_VERSION,
    evaluator: EVALUATOR_VERSION,
    evaluatedAt: new Date().toISOString(),
    status,
    checks,
    untested: [
      "Vendor ATS behaviour is not emulated: real systems (Lever, Greenhouse, Workable, Taleo, iCIMS…) differ in supported formats, column handling, header/footer parsing and ranking rules, and each employer configures them differently.",
      "Recruiter preferences and human screening outcomes are unknowable from the document.",
      "Proprietary keyword-ranking or AI-screening weights of any employer cannot be observed.",
      "This report is a practical structural diagnostic (evaluator version above), not an employer ATS simulation or a compatibility guarantee.",
    ],
    fileFacts: {
      documentKind: "resume",
      template: input.template.slice(0, 40),
      sectionCount: sections.length,
      workEntries: data.work.length,
      educationEntries: data.education.length,
      skills: skills.length,
      extractedChars: (exported || prose).length,
      longestParagraphChars: Math.max(0, ...[data.basics.summary, ...data.work.map((w) => w.summary)].map((s) => s.length)),
    },
  });
}

// --------------------------------------------- B. job description parsing

const SKILL_HINT_RE =
  /\b(react|angular|vue|next\.?js|node\.?js|typescript|javascript|python|java(?!script)|kotlin|swift|go(?:lang)?|rust|ruby|rails|php|c\+\+|c#|\.net|sql|mysql|postgres(?:ql)?|mongodb|redis|graphql|rest|grpc|docker|kubernetes|terraform|aws|gcp|azure|ci\/cd|git|jira|figma|sketch|adobe|photoshop|illustrator|indesign|after effects|premiere|blender|unity|unreal|excel|power ?bi|tableau|sap|salesforce|hubspot|seo|sem|google analytics|copywriting|content writing|technical writing|project management|agile|scrum|kanban|stakeholder|communication|leadership|mentoring|testing|selenium|cypress|jest|playwright|storybook|tailwind|django|flask|spring|laravel|flutter|dart|bash|linux|devops|sre|nlp|machine learning|deep learning|pytorch|tensorflow|pandas|spark|airflow|dbt|etl|data visuali[sz]ation|accounting|bookkeeping|payroll|recruitment|sourcing|onboarding|triage|phlebotomy|patient care|clinical|medication|ehr|hipaa|infection control|curriculum|lesson planning|classroom|pedagogy|welding|plumbing|hvac|electrical|autocad|solidworks|revit|surveying|quality assurance|regulatory|gmp|glp|clinical research|pharmacovigilance|medical coding|billing|zoning|litigation|contract drafting|compliance|audit)\b/gi;

const SENIORITY_RE =
  /\b(\d{1,2}\+?\s*(?:to|-|–)?\s*\d{0,2}\s*years?|(\d{1,2})\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+(?:relevant|professional|proven|demonstrated|hands-on))?\s*(?:experience)?|senior|junior|entry[- ]level|mid[- ]level|lead|principal|staff|director|head of|vp|vice president|chief|intern(?:ship)?|fresher|graduate)\b/gi;

const QUALIFICATION_RE =
  /\b(bachelor(?:'s)?|master(?:'s)?|mba|ph\.?d|doctorate|b\.?tech|m\.?tech|b\.?sc|m\.?sc|degree|diploma|certification|certified|licence|license|registered|accredited)\b/gi;

const WORK_MODE_RE =
  /\b(remote|hybrid|on[- ]site|in[- ]office|work from (?:home|office)|relocat\w+|willing to (?:relocate|travel))\b/gi;

const LOCATION_HINT_RE = /\b(?:based in|location:|located in|must be (?:based )?in|in)\s+([A-Z][A-Za-z .'-]{2,40})/g;

function pushRequirement(
  list: JobRequirement[],
  kind: JobRequirement["kind"],
  importance: JobRequirement["importance"],
  text: string,
  sourcePhrase: string,
  seen: Set<string>
) {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 200);
  const src = sourcePhrase.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!clean || clean.length < 2) return;
  const key = `${kind}:${normToken(clean).slice(0, 60)}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ kind, importance, text: clean, sourcePhrase: src });
}

function isPreferredSentence(sentence: string): boolean {
  return /\b(preferred|nice to have|plus|desirable|bonus|advantageous)\b/i.test(sentence);
}

function isNegatedRequirement(sentence: string): boolean {
  return /\b(no need|not required|unnecessary|don'?t need|without requiring)\b/i.test(sentence);
}

/**
 * Deterministic JD parse: role title, organization (only when actually
 * present), requirements with bounded source phrases. Untrusted content is
 * treated as DATA only — nothing here executes or reformats policy.
 */
export function parseJobDescription(jd: string): JobRequirementProfile {
  const warnings: string[] = [];
  const requirements: JobRequirement[] = [];
  const seen = new Set<string>();
  const text = jd.replace(/\r\n?/g, "\n").trim();

  // Role title: "Job Title:"/"Role:" label, or the first short non-bullet line.
  let roleTitle = "";
  const roleLabel = /^(?:job\s*title|role|position|opening|vacancy)\s*[:\-]\s*(.{2,120})$/im.exec(text);
  if (roleLabel) {
    roleTitle = roleLabel[1].trim();
  } else {
    const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length >= 4 && l.length <= 90 && !/^https?:/i.test(l));
    if (firstLine && /\b(engineer|developer|manager|designer|analyst|specialist|consultant|associate|executive|lead|intern|architect|scientist|writer|editor|nurse|teacher|accountant|recruiter|technician|officer|director|advisor|producer|coordinator|assistant|chef|driver|electrician|plumber|mechanic|pharmacist|therapist|researcher|professor)\b/i.test(firstLine)) {
      roleTitle = firstLine.slice(0, 160);
    }
  }

  // Organization: explicit labels only — never guessed.
  let organization = "";
  const orgLabel = /^(?:company|organization|organisation|employer|about\s+(?:us|the\s+company))\s*[:\-]\s*(.{2,120})$/im.exec(text);
  if (orgLabel) organization = orgLabel[1].replace(/\s*[.,|]+\s*$/, "").trim();

  const sentenceList = sentencesOf(text);
  for (const sentence of sentenceList) {
    if (isNegatedRequirement(sentence)) continue;
    const preferred = isPreferredSentence(sentence);

    // skills: known-vocabulary matches. Negated/bare mentions are kept —
    // proficiency context ("basic exposure") is resolved by the evidence
    // map (partial, never supported), not by dropping the requirement.
    const skillMatchesInSentence = sentence.match(SKILL_HINT_RE) ?? [];
    for (const s of skillMatchesInSentence) {
      pushRequirement(requirements, "skill", preferred ? "preferred" : "required", s, sentence, seen);
    }

    // seniority/experience only when explicitly stated.
    const seniority = sentence.match(SENIORITY_RE) ?? [];
    for (const s of seniority) {
      pushRequirement(requirements, "seniority", preferred ? "preferred" : "required", s, sentence, seen);
    }

    // education/licence
    const quals = sentence.match(QUALIFICATION_RE) ?? [];
    for (const q of quals) {
      pushRequirement(requirements, sentence.match(/\b(licen[cs]e|registered|certified|certification)\b/i) ? "licence" : "education", preferred ? "preferred" : "required", q, sentence, seen);
    }

    // work mode
    const modes = sentence.match(WORK_MODE_RE) ?? [];
    for (const m of modes) {
      pushRequirement(requirements, "work-mode", "required", m, sentence, seen);
    }
  }

  // Location: labeled patterns only.
  let locMatch: RegExpExecArray | null;
  const locRe = new RegExp(LOCATION_HINT_RE.source, "g");
  while ((locMatch = locRe.exec(text)) !== null) {
    const candidate = locMatch[1].trim();
    if (candidate.length >= 3 && !/^(the|a|an|our|this)\b/i.test(candidate)) {
      pushRequirement(requirements, "location", "required", candidate, locMatch[0], seen);
      break;
    }
  }

  // Responsibilities: bullet lines with action verbs (bounded set).
  const bulletLines = text.split("\n").filter((l) => /^\s*(?:[-•*·▪]|\d+[.)])\s+/.test(l));
  for (const line of bulletLines.slice(0, 25)) {
    const bare = line.replace(/^\s*(?:[-•*·▪]|\d+[.)])\s+/, "").trim();
    if (bare.length >= 15 && bare.length <= 200 && !isNegatedRequirement(bare)) {
      pushRequirement(requirements, "responsibility", "required", bare, line, seen);
    }
  }

  if (text.length > 4000) warnings.push("The job description was longer than 4,000 characters — only the first portion influences deterministic parsing.");
  if (requirements.length === 0) warnings.push("No requirements could be parsed deterministically — read the posting manually and use the tailor action with judgement.");
  if (!roleTitle) warnings.push("No explicit role title found — set the target role yourself before comparing.");
  if (/ignore\s+(all\s+)?previous\s+instructions|system\s+prompt/i.test(jd)) {
    warnings.push("Instruction-like text was found in the job description. It is treated as content only — never as a command.");
  }

  return jobRequirementProfileSchema.parse({
    profileVersion: EVIDENCE_MAP_VERSION,
    roleTitle: roleTitle.slice(0, 160),
    organization: organization.slice(0, 160),
    requirements: requirements.slice(0, 60),
    parseWarnings: warnings.slice(0, 8),
  });
}

// ------------------------------------------------------- B. evidence map

interface FactPool {
  tokens: string[];
  citations: { section: string; fact: string }[];
  skillNames: string[];
  metrics: { text: string; section: string }[];
}

function buildFactPool(facts: ResumeFacts, data: ResumeData): FactPool {
  const citations: { section: string; fact: string }[] = [];
  const pushFact = (section: string, fact: string) => {
    const t = fact.trim();
    if (t.length >= 2) citations.push({ section, fact: t.slice(0, 200) });
  };
  pushFact("basics", facts.basics.label || data.basics.label);
  for (const w of facts.work) {
    pushFact("work", `${w.position} at ${w.company}`.replace(/\s+at\s+$/, ""));
    pushFact("work", w.summary);
    for (const h of w.highlights) pushFact("work", h);
  }
  for (const e of facts.education) pushFact("education", `${e.studyType} ${e.area} ${e.institution}`.trim());
  for (const s of normalizeSkills(facts)) pushFact("skills", s.name);
  for (const p of facts.projects) {
    pushFact("projects", p.name);
    pushFact("projects", p.description);
    for (const h of p.highlights) pushFact("projects", h);
  }
  for (const c of facts.certificates) pushFact("certificates", `${c.name} ${c.issuer}`.trim());
  for (const a of facts.awards) pushFact("awards", `${a.title} ${a.awarder}`.trim());
  for (const c of facts.custom) for (const e of c.entries) {
    pushFact(`custom:${c.key}`, e.title);
    pushFact(`custom:${c.key}`, e.summary);
    for (const h of e.highlights) pushFact(`custom:${c.key}`, h);
  }
  return {
    tokens: tokensOf(citations.map((c) => c.fact).join(" ")),
    citations,
    skillNames: normalizeSkills(facts).map((s) => s.name),
    metrics: [],
  };
}

const EXP_MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "2021-03" | "Mar 2021" | "2021" → month index; null when unparseable. */
function parseYearMonth(s: string): number | null {
  const t = s.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})$/.exec(t);
  if (m) return Number(m[1]) * 12 + Number(m[2]);
  m = /^([a-z]{3,9})[a-z]*\.?\s+(\d{4})$/.exec(t);
  if (m && EXP_MONTHS[m[1].slice(0, 3)]) return Number(m[2]) * 12 + EXP_MONTHS[m[1].slice(0, 3)];
  m = /^(\d{4})$/.exec(t);
  if (m) return Number(m[1]) * 12 + 6;
  return null;
}

function yearsFromFacts(facts: ResumeFacts): { years: number; transparent: boolean } {
  // Transparent arithmetic over parseable ranges only — never bridging gaps.
  const now = new Date();
  let totalMonths = 0;
  const ranges: { start: number; end: number }[] = [];
  for (const w of facts.work) {
    const start = parseYearMonth(w.startDate);
    if (start === null) continue;
    const end = w.current ? now.getFullYear() * 12 + (now.getMonth() + 1) : parseYearMonth(w.endDate);
    if (end === null) continue;
    if (end < start) continue;
    ranges.push({ start, end });
  }
  // Merge overlaps (concurrent roles must not double-count).
  ranges.sort((a, b) => a.start - b.start);
  let cursor: { start: number; end: number } | null = null;
  for (const r of ranges) {
    if (cursor && r.start <= cursor.end) cursor.end = Math.max(cursor.end, r.end);
    else {
      if (cursor) totalMonths += cursor.end - cursor.start;
      cursor = { ...r };
    }
  }
  if (cursor) totalMonths += cursor.end - cursor.start;
  const years = Math.floor(totalMonths / 12);
  const allRangesParseable = facts.work.every((w) => w.startDate.trim() === "" || parseYearMonth(w.startDate) !== null);
  return { years, transparent: allRangesParseable && ranges.length > 0 };
}

function numIn(s: string): number | null {
  const m = /(\d{1,2})/.exec(s);
  return m ? Number(m[1]) : null;
}

/**
 * B. Job Requirement Evidence Map — every verdict cites the resume fact(s)
 * supporting it; partial/missing produce a QUESTION, never a claim.
 */
export function mapJobRequirements(
  jd: string,
  facts: ResumeFacts,
  data: ResumeData,
  preParsed?: JobRequirementProfile
): JobEvidenceMap {
  const profile = preParsed ?? parseJobDescription(jd);
  const pool = buildFactPool(facts, data);
  const evidence: RequirementEvidence[] = [];
  const matchWarnings: string[] = [];
  const exp = yearsFromFacts(facts);

  for (const req of profile.requirements) {
    const reqTokens = tokensOf(req.text);
    const matching = pool.citations.filter((c) => {
      const cTokens = tokensOf(c.fact);
      if (cTokens.length === 0) return false;
      if (req.kind === "skill") {
        if (skillMatches(req.text, cTokens)) return true;
        return false;
      }
      return phraseInText(req.text, cTokens);
    });
    // Seniority: transparent arithmetic vs the stated number.
    let seniorityVerdict: RequirementEvidence["verdict"] | null = null;
    let seniorityFollowUp = "";
    if (req.kind === "seniority") {
      const stated = numIn(req.text);
      if (stated === null) {
        seniorityVerdict = "not_assessable";
        seniorityFollowUp = `"${req.text}" is qualitative — compare it to your own experience manually.`;
      } else if (!exp.transparent) {
        seniorityVerdict = "not_assessable";
        seniorityFollowUp = "Your resume roles lack parseable dates, so years of experience cannot be calculated transparently.";
      } else if (exp.years >= stated) {
        seniorityVerdict = "supported";
      } else if (exp.years >= Math.max(1, stated - 1)) {
        seniorityVerdict = "partial";
        seniorityFollowUp = `Your parseable history covers ${exp.years} year(s); the posting asks for about ${stated}. Decide yourself how to present it — nothing is added automatically.`;
      } else {
        seniorityVerdict = "missing";
        seniorityFollowUp = `Your parseable history covers ${exp.years} year(s); the posting asks for about ${stated}.`;
      }
    }

    let verdict: RequirementEvidence["verdict"];
    let citations: { section: string; fact: string }[] = [];
    let followUp = "";

    if (seniorityVerdict) {
      verdict = seniorityVerdict;
      followUp = seniorityFollowUp;
    } else if (matching.length > 0) {
      const dimmed = matching.some((c) => isDiminishedContext(c.fact, req.text));
      const strong = matching.filter((c) => !isDiminishedContext(c.fact, req.text));
      if (strong.length > 0) {
        verdict = "supported";
        citations = strong.slice(0, 4);
      } else {
        verdict = "partial";
        citations = matching.slice(0, 2);
        followUp = `Only diminished context found for "${req.text.slice(0, 60)}" (e.g. basic exposure) — confirm your real level before claiming it.`;
      }
    } else if (req.kind === "location" || req.kind === "work-mode") {
      verdict = "not_assessable";
      followUp = `The posting mentions "${req.text.slice(0, 60)}" — your resume does not state this; decide and add it explicitly if true.`;
    } else {
      verdict = "missing";
      followUp =
        req.kind === "skill"
          ? `No evidence for "${req.text.slice(0, 60)}" in your confirmed facts. If you genuinely have it, add it to your skills — do not let the resume invent it.`
          : `No evidence for "${req.text.slice(0, 60)}" in your confirmed facts.`;
    }
    evidence.push(
      requirementEvidenceSchema.parse({
        requirement: req,
        verdict,
        citations,
        followUp,
      })
    );
  }

  // Descriptive weighted coverage (published formula; no probability claim).
  let weightSum = 0;
  let scoreSum = 0;
  let excluded = 0;
  for (const e of evidence) {
    if (e.verdict === "not_assessable") {
      excluded += 1;
      continue;
    }
    const weight = e.requirement.importance === "required" ? 1 : 0.5;
    const score = e.verdict === "supported" ? 1 : e.verdict === "partial" ? 0.5 : 0;
    weightSum += weight;
    scoreSum += weight * score;
  }
  const coverage = weightSum === 0 ? 0 : scoreSum / weightSum;

  if (pool.skillNames.length === 0) matchWarnings.push("The resume has no skills listed — every skill requirement will read as missing.");
  if (profile.requirements.length > 40) matchWarnings.push(`${profile.requirements.length} requirements parsed — the map is long; focus on required items first.`);

  return jobEvidenceMapSchema.parse({
    mapVersion: EVIDENCE_MAP_VERSION,
    profile,
    evidence: evidence.slice(0, 60),
    weightedCoverage: {
      formula: "Σ(weight·score)/Σ(weight); required=1, preferred=0.5; supported=1, partial=0.5, missing=0; not_assessable excluded",
      value: Number(coverage.toFixed(4)),
      assessedRequirements: evidence.length - excluded,
      excludedNotAssessable: excluded,
    },
    matchWarnings: matchWarnings.slice(0, 8),
  });
}

// ------------------------------------------------- C. export round trip

export interface ExportRoundTripResult {
  format: "pdf" | "docx";
  byteLength: number;
  decodeOk: boolean;
  extractedChars: number;
  missingFacts: string[];
  checkedFacts: number;
  readingOrderOk: boolean;
}

/**
 * Decode produced export bytes and compare key facts against the saved
 * document (§5.2 check 12 / §6.4). PII stays in-memory; only counts and
 * MISSING (non-PII-safe) names are surfaced to callers.
 */
export async function verifyExportBytes(
  bytes: Buffer,
  format: "pdf" | "docx",
  data: ResumeData
): Promise<ExportRoundTripResult> {
  const checkedFacts = documentKeyFacts(data).filter((f) => f.length >= 4).slice(0, 40);
  let text = "";
  let decodeOk = false;
  try {
    if (format === "pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      try {
        const result = await parser.getText();
        text = (result.text ?? "").replace(/\r\n?/g, "\n");
        decodeOk = text.trim().length > 0;
      } finally {
        await parser.destroy().catch(() => {});
      }
    } else {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: bytes });
      text = (result.value ?? "").replace(/\r\n?/g, "\n");
      decodeOk = text.trim().length > 0;
    }
  } catch {
    decodeOk = false;
  }

  const missingFacts = decodeOk
    ? checkedFacts.filter((f) => !text.includes(f))
    : checkedFacts.slice(0, 5);

  // Reading order: the name (when present) must appear before the first work
  // company, which must appear before the education institution — a coarse
  // but real ordering check over the re-extracted text.
  let readingOrderOk = decodeOk;
  if (decodeOk) {
    const nameIdx = data.basics.name.trim() ? text.indexOf(data.basics.name.trim()) : 0;
    const firstCompany = data.work.map((w) => w.company.trim()).find(Boolean);
    const firstInst = data.education.map((e) => e.institution.trim()).find(Boolean);
    if (firstCompany) {
      const idx = text.indexOf(firstCompany);
      if (idx < 0 || idx < nameIdx) readingOrderOk = false;
    }
    if (readingOrderOk && firstInst) {
      const idx = text.indexOf(firstInst);
      const companyIdx = data.work.map((w) => w.company.trim()).find(Boolean) ? text.indexOf(data.work.map((w) => w.company.trim()).find(Boolean)!) : 0;
      if (idx >= 0 && idx < companyIdx) readingOrderOk = false;
    }
  }

  return {
    format,
    byteLength: bytes.length,
    decodeOk,
    extractedChars: text.length,
    missingFacts: missingFacts.slice(0, 10),
    checkedFacts: checkedFacts.length,
    readingOrderOk,
  };
}

// ------------------------------------------------- shared validation helper

export function parseResumeDataForAnalysis(raw: unknown): ResumeData {
  return resumeDataSchema.parse(raw);
}
