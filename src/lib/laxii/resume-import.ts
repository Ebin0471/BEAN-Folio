/**
 * LAXII Resume Studio — M33.5-A safe structured import.
 *
 * Turns the plain text extracted from an uploaded resume (PDF/DOCX/TXT — the
 * same parsers and limits as /api/laxii/resume/parse) into a DETERMINISTIC,
 * schema-versioned extraction proposal for user review. Nothing here is AI:
 * every proposed field carries
 *   - the parsed value (reusing the resume-schema zod shapes, so accepted
 *     items merge 1:1 into the existing ResumeFacts contract),
 *   - a bounded source snippet (private, never logged),
 *   - the extraction method and a confidence bucket with a deterministic
 *     basis (label/structural anchor vs pattern guess),
 *   - explicit warnings/ambiguities.
 *
 * Honesty rules (spec §4):
 *  - The proposal is an OFFER. Nothing is saved or used until the user
 *    confirms individual fields in the review UI.
 *  - Structure that cannot be confidently detected is skipped with a
 *    warning — never filled by guessing.
 *  - Document text is untrusted data: instruction-like phrases found in a
 *    resume are flagged as content and never interpreted as commands (the
 *    whole module is pure string processing, so there is no execution path).
 *  - OCR is explicitly NOT implemented (see docs/reports/M33.5_CAPABILITY_
 *    GAP_REPORT.md §4); scanned files keep the honest parse-route failure.
 */

import { z } from "zod";

import {
  resumeWorkSchema,
  resumeEducationSchema,
  resumeProjectSchema,
  resumeCertificateSchema,
  resumeAwardSchema,
} from "./resume-schema";

export const IMPORT_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB (unchanged — no benchmark evidence for a larger cap)
export const MAX_TEXT_CHARS = 8000; // unchanged (generation prompt budget)

export const IMPORT_METHODS = ["pdf-text", "docx-text", "plain-text", "user-entered"] as const;
export type ImportMethod = (typeof IMPORT_METHODS)[number];
export type ConfidenceBucket = "high" | "review" | "low";

// ---------------------------------------------------------------- signatures

export type UploadKind = "pdf" | "docx" | "text";

/**
 * Byte-signature validation. The declared extension/MIME is never trusted on
 * its own (spec §4.1). Text files must be decodable UTF-8 without NUL bytes
 * (binary masquerading as .txt is rejected).
 */
export function verifyUploadSignature(
  bytes: Buffer,
  kind: UploadKind
): { ok: boolean; reason?: string } {
  if (kind === "pdf") {
    const head = bytes.subarray(0, 1024).toString("latin1");
    if (!head.includes("%PDF-")) {
      return { ok: false, reason: "This file is not a valid PDF (signature missing) — it may be renamed or corrupted." };
    }
    return { ok: true };
  }
  if (kind === "docx") {
    // OOXML is a ZIP container: local file header "PK\x03\x04".
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07))) {
      return { ok: false, reason: "This file is not a valid DOCX document (ZIP signature missing) — it may be renamed or corrupted." };
    }
    return { ok: true };
  }
  // text: reject NUL bytes anywhere in the first 8 KB (binary impostor) and
  // confirm the head decodes as UTF-8.
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) {
    return { ok: false, reason: "This looks like a binary file, not plain text." };
  }
  const decoded = head.toString("utf-8");
  const reencoded = Buffer.from(decoded, "utf-8");
  if (!reencoded.equals(head)) {
    return { ok: false, reason: "This file is not valid UTF-8 text." };
  }
  return { ok: true };
}

/** Resolve the upload kind from extension + MIME claim (signature checked later). */
export function resolveUploadKind(name: string, mime: string): UploadKind | null {
  const n = name.toLowerCase();
  if (mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    n.endsWith(".docx")
  ) {
    return "docx";
  }
  if (mime.startsWith("text/") || n.endsWith(".txt") || n.endsWith(".md")) return "text";
  return null;
}

// ------------------------------------------------------------------- schemas

const snippetSchema = z.string().max(240);

const proposedString = z.object({
  value: z.string().max(2000),
  confidence: z.enum(["high", "review", "low"]),
  snippet: snippetSchema.default(""),
  warnings: z.array(z.string().max(200)).max(6).default([]),
});

const proposedWork = z.object({
  value: resumeWorkSchema,
  confidence: z.enum(["high", "review", "low"]),
  snippet: snippetSchema.default(""),
  warnings: z.array(z.string().max(200)).max(6).default([]),
});

const proposedEducation = z.object({
  value: resumeEducationSchema,
  confidence: z.enum(["high", "review", "low"]),
  snippet: snippetSchema.default(""),
  warnings: z.array(z.string().max(200)).max(6).default([]),
});

const proposedSkill = z.object({
  value: z.string().max(80),
  confidence: z.enum(["high", "review", "low"]),
  snippet: snippetSchema.default(""),
  warnings: z.array(z.string().max(200)).max(6).default([]),
});

const proposedProject = z.object({
  value: resumeProjectSchema,
  confidence: z.enum(["high", "review", "low"]),
  snippet: snippetSchema.default(""),
  warnings: z.array(z.string().max(200)).max(6).default([]),
});

const proposedCertificate = z.object({
  value: resumeCertificateSchema,
  confidence: z.enum(["high", "review", "low"]),
  snippet: snippetSchema.default(""),
  warnings: z.array(z.string().max(200)).max(6).default([]),
});

const proposedAward = z.object({
  value: resumeAwardSchema,
  confidence: z.enum(["high", "review", "low"]),
  snippet: snippetSchema.default(""),
  warnings: z.array(z.string().max(200)).max(6).default([]),
});

export const resumeImportProposalSchema = z.object({
  schemaVersion: z.literal(IMPORT_PROPOSAL_SCHEMA_VERSION),
  source: z.object({
    method: z.enum(IMPORT_METHODS),
    charCount: z.number().int().nonnegative(),
    truncated: z.boolean().default(false),
    fileName: z.string().max(200).default(""),
  }),
  basics: z.object({
    name: proposedString.nullable().default(null),
    label: proposedString.nullable().default(null),
    email: proposedString.nullable().default(null),
    phone: proposedString.nullable().default(null),
    website: proposedString.nullable().default(null),
    location: proposedString.nullable().default(null),
    summary: proposedString.nullable().default(null),
  }),
  work: z.array(proposedWork).max(15).default([]),
  education: z.array(proposedEducation).max(10).default([]),
  skills: z.array(proposedSkill).max(40).default([]),
  projects: z.array(proposedProject).max(10).default([]),
  certificates: z.array(proposedCertificate).max(15).default([]),
  awards: z.array(proposedAward).max(10).default([]),
  warnings: z.array(z.string().max(220)).max(14).default([]),
});

export type ResumeImportProposal = z.infer<typeof resumeImportProposalSchema>;
export type ProposedString = z.infer<typeof proposedString>;
export type ProposedWork = z.infer<typeof proposedWork>;
export type ProposedEducation = z.infer<typeof proposedEducation>;
export type ProposedSkill = z.infer<typeof proposedSkill>;
export type ProposedProject = z.infer<typeof proposedProject>;
export type ProposedCertificate = z.infer<typeof proposedCertificate>;
export type ProposedAward = z.infer<typeof proposedAward>;

// ------------------------------------------------------------- text helpers

interface DocLine {
  text: string;
  index: number; // 0-based line number in the normalized text
}

function normalizeLines(raw: string): DocLine[] {
  return raw
    .split("\n")
    .map((l) => l.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    .map((text, index) => ({ text, index }))
    .filter((l) => l.text.length > 0);
}

function snippetOf(line: string): string {
  return line.length <= 200 ? line : `${line.slice(0, 197)}…`;
}

const EMAIL_RE = /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]{2,}/;
const URL_RE = /(?:https?:\/\/|www\.)[^\s,;"')\]]+/i;
const PHONE_LABEL_RE = /\b(?:phone|mobile|tel(?:ephone)?|contact(?:\s*no\.?| number)?)\b\s*[:\-]?\s*(\+?[\d][\d\s\-()]{6,}\d)/i;
const PHONE_BARE_RE = /(?:\+?\d{1,3}[\s-]?)?(?:\d[\d\s\-()]{7,}\d)/;
/** Lines that are clearly a date range ("Mar 2021 – Present", "2019-2022"). */
const RANGE_RE =
  /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4}|\d{1,2}\/\d{4}|\d{4})\s*(?:[-–—]|to)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4}|\d{1,2}\/\d{4}|\d{4}|present|current|now|till date|today)/i;
const SINGLE_YEAR_RE = /^\s*(?:19|20)\d{2}\s*$/;
const YEAR_ONLY_RE = /\b(?:19|20)\d{2}\b/;

const BULLET_RE = /^(?:[•▪◦*・·‣▪]|\p{Po}\s|[-–—]\s)/u;

// Section heading vocabulary → canonical bucket. A heading is a SHORT line
// that starts with one of these (label anchors give downstream fields their
// "high" confidence).
const HEADING_MAP: [RegExp, string][] = [
  [/^(professional\s+)?(summary|profile|objective|about\s*(me)?|career\s+(summary|objective|profile))/i, "summary"],
  [/^(work\s+|professional\s+|employment\s+|relevant\s+)?(experience|history|employment)/i, "work"],
  [/^(education|academic(s| background)?|qualifications?)$/i, "education"],
  [/^(technical\s+|core\s+|key\s+)?(skills|competencies|technologies|tech\s+stack|toolkit)/i, "skills"],
  [/^(projects?|selected\s+(projects|work)|portfolio)/i, "projects"],
  [/^(certifications?|certificates?|licen[cs]es?|registrations?)/i, "certificates"],
  [/^(awards?|achievements?|honou?rs|recognition|accomplishments)/i, "awards"],
  [/^(publications?|papers?|research|patents?|conferences?)/i, "custom-publications"],
  [/^(languages?|interests?|hobbies|volunteer|references?|courses?|training|activities|extracurricular)/i, "custom-other"],
];

function classifyHeading(line: string): string | null {
  if (line.length > 64) return null;
  const bare = line.replace(/[:\-–—•|]+$/g, "").trim();
  if (!bare || bare.endsWith(".")) return null;
  for (const [re, bucket] of HEADING_MAP) {
    if (re.test(bare)) return bucket;
  }
  return null;
}

interface Section {
  bucket: string;
  headingIndex: number;
  lines: DocLine[];
}

/** Split the document into anchored sections; everything before the first heading is "header". */
function splitSections(lines: DocLine[]): { header: DocLine[]; sections: Section[] } {
  const header: DocLine[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const bucket = classifyHeading(line.text);
    if (bucket) {
      current = { bucket, headingIndex: line.index, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }
  return { header, sections };
}

function sectionByBucket(sections: Section[], bucket: string): Section | null {
  return sections.find((s) => s.bucket === bucket) ?? null;
}

function joinLines(lines: DocLine[], max = 1200): string {
  const text = lines.map((l) => l.text).join("\n").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const ACTION_TITLE_RE =
  /\b(engineer|developer|manager|designer|analyst|lead|head|intern|consultant|specialist|officer|executive|associate|director|architect|administrator|coordinator|assistant|technician|nurse|teacher|professor|researcher|writer|editor|accountant|recruiter|scientist|advisor|consult|trainee|apprentice|internship|fellow|president|founder|partner|producer|photographer|journalist|reporter|anchor|attendant|chef|driver|electrician|plumber|welder|mechanic|pharmacist|therapist|advisor)\b/i;

function normSkillKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();
}

// ----------------------------------------------------------- date utilities

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse "Mar 2021", "March 2021", "2021-03", "03/2021", "2021" → {y, m?}; null when not a date. */
export function parseLooseDate(s: string): { y: number; m?: number } | null {
  const t = s.trim().toLowerCase().replace(/\.+$/, "");
  if (!t) return null;
  let m = /^(?:19|20)\d{2}$/.exec(t);
  if (m) return { y: Number(t) };
  m = /^(\d{4})-(\d{1,2})$/.exec(t);
  if (m) return { y: Number(m[1]), m: Number(m[2]) };
  m = /^(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return { y: Number(m[2]), m: Number(m[1]) };
  m = /^([a-z]{3,9})\.?\s+(\d{4})$/.exec(t);
  if (m) {
    const mm = MONTHS[m[1].slice(0, 3)];
    if (mm) return { y: Number(m[2]), m: mm };
  }
  m = /^([a-z]{3,9})\.?\s+'?(\d{2})$/.exec(t);
  if (m) {
    const mm = MONTHS[m[1].slice(0, 3)];
    if (mm) return { y: 2000 + Number(m[2]), m: mm };
  }
  return null;
}

function monthWarning(raw: string): string | null {
  const d = parseLooseDate(raw);
  if (d && !d.m) return `"${raw}" has no month — confirm the exact dates.`;
  return null;
}

// ------------------------------------------------------------ proposal build

export interface BuildProposalInput {
  text: string;
  method: ImportMethod;
  truncated: boolean;
  fileName?: string;
}

/**
 * Deterministic extraction: document text in, review proposal out. Bounded
 * work only (regex + line scans over ≤8000 chars). Never throws for odd
 * content — undetectable structure is reported in `warnings` instead.
 */
export function buildImportProposal(input: BuildProposalInput): ResumeImportProposal {
  const lines = normalizeLines(input.text);
  const { header, sections } = splitSections(lines);
  const warnings: string[] = [];

  // Raw proposal assembled in code (zod v4 object `.default()` does not parse
  // inner defaults, so every field is set explicitly) and validated once at
  // the end — the schema gate never lets a malformed proposal out.
  const proposal: ResumeImportProposal = {
    schemaVersion: IMPORT_PROPOSAL_SCHEMA_VERSION,
    source: { method: input.method, charCount: input.text.length, truncated: input.truncated, fileName: input.fileName ?? "" },
    basics: { name: null, label: null, email: null, phone: null, website: null, location: null, summary: null },
    work: [],
    education: [],
    skills: [],
    projects: [],
    certificates: [],
    awards: [],
    warnings: [],
  };

  // ---------------------------------------------------------- contact basics
  const emailMatches = Array.from(new Set(input.text.match(new RegExp(EMAIL_RE.source, "gi")) ?? []));
  if (emailMatches.length >= 1) {
    const firstLine = lines.find((l) => EMAIL_RE.test(l.text));
    proposal.basics.email = {
      value: emailMatches[0],
      confidence: emailMatches.length === 1 ? "high" : "review",
      snippet: firstLine ? snippetOf(firstLine.text) : "",
      warnings: emailMatches.length > 1 ? [`${emailMatches.length} email addresses found — confirm which one to use.`] : [],
    };
  }

  const urlMatches = Array.from(new Set((input.text.match(new RegExp(URL_RE.source, "gi")) ?? []).map((u) => u.replace(/[.,;]+$/, "")))).slice(0, 3);
  if (urlMatches.length >= 1) {
    const firstLine = lines.find((l) => URL_RE.test(l.text));
    const isProfile = /linkedin|github|gitlab|behance|dribbble|medium|dev\.to|stackoverflow/i.test(urlMatches[0]);
    proposal.basics.website = {
      value: urlMatches[0].slice(0, 240),
      confidence: urlMatches.length === 1 ? "high" : "review",
      snippet: firstLine ? snippetOf(firstLine.text) : "",
      warnings: [
        ...(urlMatches.length > 1 ? [`${urlMatches.length} links found — confirm the one to use.`] : []),
        ...(isProfile ? ["This looks like a profile/portfolio URL."] : []),
      ],
    };
  }

  // phone: labeled first (high), else bare number on its own line (review).
  const phoneLabelMatch = PHONE_LABEL_RE.exec(input.text);
  if (phoneLabelMatch) {
    const raw = phoneLabelMatch[1].trim();
    const line = lines.find((l) => PHONE_LABEL_RE.test(l.text));
    proposal.basics.phone = { value: raw.slice(0, 60), confidence: "high", snippet: line ? snippetOf(line.text) : "", warnings: [] };
  } else {
    const candidate = lines.find(
      (l) =>
        l.text.length <= 32 &&
        !RANGE_RE.test(l.text) &&
        !EMAIL_RE.test(l.text) &&
        !URL_RE.test(l.text) &&
        (l.text.match(/\d/g) ?? []).length >= 8 &&
        PHONE_BARE_RE.test(l.text)
    );
    if (candidate) {
      proposal.basics.phone = {
        value: candidate.text.slice(0, 60),
        confidence: "review",
        snippet: snippetOf(candidate.text),
        warnings: ["Detected from a bare number — confirm it is a phone number, not an ID."],
      };
    }
  }

  // name: header line before any contact/heading, 2–4 words, mostly letters.
  const nameLine = header.find((l) => {
    if (l.text.length > 60) return false;
    if (EMAIL_RE.test(l.text) || URL_RE.test(l.text) || /\d{4}/.test(l.text)) return false;
    if (/^(curriculum\s+vitae|resume|cv)\b/i.test(l.text)) return false;
    const words = l.text.split(/\s+/);
    if (words.length < 1 || words.length > 5) return false;
    const letters = (l.text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) ?? []).length;
    return letters >= l.text.replace(/\s/g, "").length * 0.7;
  });
  if (nameLine) {
    proposal.basics.name = {
      value: nameLine.text.slice(0, 120),
      confidence: "review",
      snippet: snippetOf(nameLine.text),
      warnings: ["Detected from document position — confirm this is your name as you want it shown."],
    };
  }

  // target title: a header line under the name that reads like a role.
  if (nameLine) {
    const after = header.slice(header.indexOf(nameLine) + 1);
    const titleLine = after.find(
      (l) =>
        l.text.length <= 60 &&
        !EMAIL_RE.test(l.text) &&
        !URL_RE.test(l.text) &&
        !/\d{3,}/.test(l.text) &&
        ACTION_TITLE_RE.test(l.text)
    );
    if (titleLine) {
      proposal.basics.label = { value: titleLine.text.slice(0, 120), confidence: "low", snippet: snippetOf(titleLine.text), warnings: [] };
    }
  }

  // location: labeled → high; else "City, State/Country" header pattern → review.
  const locLabel = lines.find((l) => /^(location|address|based in|city)\b\s*[:\-]/i.test(l.text));
  if (locLabel) {
    const value = locLabel.text.replace(/^(location|address|based in|city)\b\s*[:\-]\s*/i, "").slice(0, 160);
    if (value) proposal.basics.location = { value, confidence: "high", snippet: snippetOf(locLabel.text), warnings: [] };
  } else {
    const locLine = header.find((l) => /^[A-Za-zÀ-ÿ .'-]+,\s*[A-Za-zÀ-ÿ .'-]{2,}$/.test(l.text) && l.text.length <= 60 && (l.text.match(/\d/g) ?? []).length === 0);
    if (locLine) {
      proposal.basics.location = {
        value: locLine.text.slice(0, 160),
        confidence: "review",
        snippet: snippetOf(locLine.text),
        warnings: ["Detected from a 'City, Region' pattern — confirm."],
      };
    }
  }

  // summary: anchored section.
  const summarySection = sectionByBucket(sections, "summary");
  if (summarySection && summarySection.lines.length > 0) {
    const text = joinLines(summarySection.lines, 2000);
    if (text) {
      proposal.basics.summary = {
        value: text,
        confidence: "high",
        snippet: snippetOf(summarySection.lines[0].text),
        warnings: [],
      };
    }
  }

  // ------------------------------------------------------------------- work
  const workSection = sectionByBucket(sections, "work");
  if (workSection) {
    const ls = workSection.lines;
    const isAnchor = (t: string) => RANGE_RE.test(t) || (SINGLE_YEAR_RE.test(t) && YEAR_ONLY_RE.test(t));
    // 1) anchors = dated lines that split the section into entries.
    const anchors = ls.map((l, idx) => ({ idx, line: l })).filter((x) => isAnchor(x.line.text));
    // 2) header lines for each entry: up to 2 non-bullet, non-dated lines
    //    directly above the anchor (stop at bullets/prose-length lines).
    const headerStart: number[] = [];
    const headerLines: string[][] = [];
    for (const a of anchors) {
      const collected: string[] = [];
      let j = a.idx - 1;
      while (
        j >= 0 &&
        collected.length < 2 &&
        !BULLET_RE.test(ls[j].text) &&
        !isAnchor(ls[j].text) &&
        ls[j].text.length <= 100 &&
        !ls[j].text.endsWith(".")
      ) {
        collected.unshift(ls[j].text);
        j -= 1;
      }
      headerLines.push(collected);
      headerStart.push(collected.length > 0 ? j + 1 : a.idx);
    }
    // 3) each entry: anchor line + header + body (body ends where the NEXT
    //    entry's header starts, so the next role's title/company lines are
    //    never swallowed by this entry's summary).
    for (let e = 0; e < anchors.length && proposal.work.length < 15; e += 1) {
      const a = anchors[e];
      const dateLine = a.line;
      const bodyEnd = e + 1 < anchors.length ? headerStart[e + 1] : ls.length;
      const entryWarnings: string[] = [];
      let company = "";
      let position = "";
      const header = headerLines[e];
      if (header.length >= 1) {
        const joined = header.join(" ");
        const dashSplit = joined.split(/\s+[—–|]\s+|\s+\|\s+/).map((p) => p.trim()).filter(Boolean);
        const atSplit = /\s+at\s+/i.test(joined) ? joined.split(/\s+at\s+/i).map((p) => p.trim()) : null;
        if (dashSplit.length === 2) {
          if (ACTION_TITLE_RE.test(dashSplit[1]) && !ACTION_TITLE_RE.test(dashSplit[0])) {
            company = dashSplit[0];
            position = dashSplit[1];
          } else if (ACTION_TITLE_RE.test(dashSplit[0]) && !ACTION_TITLE_RE.test(dashSplit[1])) {
            position = dashSplit[0];
            company = dashSplit[1];
          } else {
            company = dashSplit[0];
            position = dashSplit[1];
          }
        } else if (atSplit && atSplit.length === 2) {
          position = atSplit[0];
          company = atSplit[1];
        } else if (header.length === 2) {
          // Two stacked lines: first reads as the role, second as the employer.
          position = header[0];
          company = header[1];
        } else if (header.length === 1) {
          position = header[0];
        }
      }
      // Body: bullets → highlights, prose → summary.
      const highlights: string[] = [];
      const prose: string[] = [];
      for (let k = a.idx + 1; k < bodyEnd; k += 1) {
        const t = ls[k].text;
        if (BULLET_RE.test(t)) highlights.push(t.replace(BULLET_RE, "").trim());
        else prose.push(t);
      }
      const cleanHighlights = highlights.filter(Boolean).slice(0, 10);
      const summary = prose.join(" ").trim().slice(0, 1200);
      const rangeMatch = RANGE_RE.exec(dateLine.text);
      const startDateRaw = rangeMatch ? rangeMatch[1] : dateLine.text.trim().slice(0, 40);
      const endRaw = rangeMatch ? rangeMatch[2] : "";
      const isCurrent = /present|current|now|till date|today/i.test(endRaw);
      const noMonth = monthWarning(startDateRaw);
      if (noMonth) entryWarnings.push(noMonth);
      if (!startDateRaw) entryWarnings.push("No start date detected — add it.");
      if (!company && !position) entryWarnings.push("Employer/role could not be separated — confirm manually.");
      const confidence: ConfidenceBucket = company && position && startDateRaw ? "high" : startDateRaw ? "review" : "low";
      proposal.work.push({
        value: {
          company: company.slice(0, 160),
          position: position.slice(0, 160),
          startDate: startDateRaw.slice(0, 40),
          endDate: isCurrent ? "" : endRaw.slice(0, 40),
          current: isCurrent,
          summary,
          highlights: cleanHighlights,
        },
        confidence,
        snippet: snippetOf([header.join(" "), dateLine.text].filter(Boolean).join(" — ").slice(0, 200)),
        warnings: entryWarnings,
      });
    }
    if (proposal.work.length === 0 && ls.length > 0) {
      warnings.push("The experience section could not be split into dated roles — add roles manually (nothing was guessed).");
    }
  }

  // --------------------------------------------------------------- education
  const eduSection = sectionByBucket(sections, "education");
  if (eduSection) {
    const ls = eduSection.lines;
    const DEGREE_RE =
      /\b(b\.?tech|b\.?e\b|b\.?sc|b\.?a\b|b\.?com|b\.?b\.?a|m\.?tech|m\.?sc|m\.?e\b|m\.?a\b|m\.?com|m\.?b\.?a|ph\.?d|doctorate|master|bachelor|diploma|certificate|high\s*school|secondary|intermediate|class\s*(x{1,3}i{0,2}|1[0-2]?)|10th|12th|hsc|ssc|cbse|icse|ib\s*diploma|associate(?:'s)?\s*degree|md\b|ms\b|mbbs|llb|b\.?ed|m\.?ed|g\.?d\.?)\b/i;
    const INST_RE = /\b(university|college|institute|school|academy|polytechnic|iit|nit|iim|iiit|iiit\b|vidyalaya|vidyalay|junior college|engineering college|medical college|law college|business school)\b/i;
    for (let li = 0; li < ls.length; li += 1) {
      if (proposal.education.length >= 10) break;
      const line = ls[li];
      const hasDegree = DEGREE_RE.test(line.text);
      const hasInst = INST_RE.test(line.text);
      if (!hasDegree && !hasInst) continue;
      const text = line.text;
      const degreeMatch = DEGREE_RE.exec(text);
      const instMatch = INST_RE.exec(text);
      const entryWarnings: string[] = [];
      const studyType = degreeMatch ? degreeMatch[0].toUpperCase().replace(/\s+/g, " ") : "";
      let area = "";
      let institution = "";
      // Attach a pure-date line directly below (common "2015 – 2019" layout).
      let dateText = "";
      const ownRange = RANGE_RE.exec(text);
      const nextLine = ls[li + 1];
      const scoreMatch = /\b((?:cgpa|gpa|percentage)\s*[:\-]?\s*[\d.]+\s*%?|[\d.]+\s*(?:cgpa|gpa|%|percent)\b)/i.exec(text);
      let score = scoreMatch ? scoreMatch[1].trim().slice(0, 40) : "";
      if (nextLine && !DEGREE_RE.test(nextLine.text) && !INST_RE.test(nextLine.text)) {
        const nextRange = RANGE_RE.exec(nextLine.text);
        if (nextRange) dateText = nextRange[0].slice(0, 80);
        const nextScore = /\b((?:cgpa|gpa|percentage)\s*[:\-]?\s*[\d.]+\s*%?|[\d.]+\s*(?:cgpa|gpa|%|percent)\b)/i.exec(nextLine.text);
        if (!score && nextScore) score = nextScore[1].trim().slice(0, 40);
      }
      if (ownRange && !dateText) dateText = ownRange[0].slice(0, 80);

      if (hasDegree && hasInst) {
        // One line carries both: keep the institution text exact and isolate
        // the field of study between the degree and the institution.
        institution = text;
        const dIdx = text.toLowerCase().indexOf(degreeMatch![0].toLowerCase());
        if (dIdx >= 0 && instMatch && instMatch.index > dIdx) {
          const between = text
            .slice(dIdx + degreeMatch![0].length, instMatch.index)
            .trim()
            .replace(/^[\s—–:,\-|]+|[\s—–:,|]+$/g, "");
          if (between.length >= 3) area = between;
        }
      } else if (hasDegree && nextLine && INST_RE.test(nextLine.text)) {
        // "B.Tech Computer Science" + next line "Visvesvaraya … University";
        // a pure date/score line may follow the institution line.
        institution = nextLine.text;
        const after = text.slice(degreeMatch ? degreeMatch[0].length + text.indexOf(degreeMatch![0]) : 0).trim();
        const cleaned = after.replace(/^[\s—–:,\-|]+\s*/, "").trim();
        if (cleaned.length >= 3 && !INST_RE.test(cleaned)) area = cleaned.slice(0, 160);
        const belowInst = ls[li + 2];
        if (belowInst && !DEGREE_RE.test(belowInst.text) && !INST_RE.test(belowInst.text)) {
          const r2 = RANGE_RE.exec(belowInst.text);
          if (r2 && !ownRange) dateText = r2[0].slice(0, 80);
          const s2 = /\b((?:cgpa|gpa|percentage)\s*[:\-]?\s*[\d.]+\s*%?|[\d.]+\s*(?:cgpa|gpa|%|percent)\b)/i.exec(belowInst.text);
          if (!score && s2) score = s2[1].trim().slice(0, 40);
          // Score sometimes sits one line below the dates ("2015 – 2019" then "CGPA 8.6").
          const belowDates = ls[li + 3];
          if (!score && r2 && belowDates && !DEGREE_RE.test(belowDates.text) && !INST_RE.test(belowDates.text)) {
            const s3 = /\b((?:cgpa|gpa|percentage)\s*[:\-]?\s*[\d.]+\s*%?|[\d.]+\s*(?:cgpa|gpa|%|percent)\b)/i.exec(belowDates.text);
            if (s3) score = s3[1].trim().slice(0, 40);
          }
        }
        li += 1; // consume the institution line
      } else if (hasInst) {
        institution = text;
      } else {
        // Degree-only line with no institution anywhere adjacent.
        const after = text.slice(text.toLowerCase().indexOf(degreeMatch![0].toLowerCase()) + degreeMatch![0].length).trim();
        const cleaned = after.replace(/^[\s—–:,\-|]+\s*/, "").trim();
        if (cleaned.length >= 3 && !INST_RE.test(cleaned)) area = cleaned.slice(0, 160);
      }
      // Dates/score are resolved AFTER the merge branches (a date line may
      // sit below the institution line that was just consumed).
      const range = ownRange ?? (dateText ? RANGE_RE.exec(dateText) : null);
      const start = range ? range[1] : "";
      const endRaw = range ? range[2] : "";
      const isCurrentEdu = /present|current|ongoing/i.test(endRaw);
      const noMonthEdu = monthWarning(start);
      if (noMonthEdu) entryWarnings.push(noMonthEdu);
      proposal.education.push({
        value: {
          institution: institution.slice(0, 200),
          area: area.slice(0, 160),
          studyType: studyType.slice(0, 120),
          startDate: start.slice(0, 40),
          endDate: isCurrentEdu ? "" : endRaw.slice(0, 40),
          score,
        },
        confidence: hasDegree && institution ? "high" : "review",
        snippet: snippetOf(text),
        warnings: entryWarnings,
      });
    }
    if (proposal.education.length === 0 && ls.length > 0) {
      warnings.push("Education entries could not be detected reliably — add them manually (nothing was guessed).");
    }
  }

  // ------------------------------------------------------------------ skills
  const skillsSection = sectionByBucket(sections, "skills");
  if (skillsSection) {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const line of skillsSection.lines) {
      const parts = line.text.split(/\s*[,;|·•]\s*|\s{2,}/).map((p) => p.replace(BULLET_RE, "").trim()).filter(Boolean);
      for (const p of parts) {
        if (proposal.skills.length >= 40) break;
        const key = normSkillKey(p);
        if (!key || key.length < 2) continue;
        if (seen.has(key)) {
          dupes.push(p.slice(0, 60));
          continue;
        }
        seen.add(key);
        proposal.skills.push({ value: p.slice(0, 80), confidence: "high", snippet: snippetOf(line.text), warnings: [] });
      }
    }
    if (dupes.length > 0) warnings.push(`Duplicate skills removed from the proposal: ${Array.from(new Set(dupes)).slice(0, 5).join(", ")}.`);
    if (proposal.skills.length === 0 && skillsSection.lines.length > 0) {
      warnings.push("Skills section found but no separable items — add skills manually.");
    }
  } else {
    const inline = lines.find((l) => /^(skills?|technologies|tech\s*stack)\b\s*[:\-]/i.test(l.text));
    if (inline) {
      const value = inline.text.replace(/^(skills?|technologies|tech\s*stack)\b\s*[:\-]\s*/i, "");
      for (const p of value.split(/\s*[,;|·•]\s*/).filter(Boolean)) {
        if (proposal.skills.length >= 40) break;
        proposal.skills.push({ value: p.trim().slice(0, 80), confidence: "review", snippet: snippetOf(inline.text), warnings: ["From an inline label — confirm." ] });
      }
    }
  }

  // ---------------------------------------------------------------- projects
  const projSection = sectionByBucket(sections, "projects");
  if (projSection) {
    const ls = projSection.lines;
    let current: (typeof proposal.projects)[number] | null = null;
    let prevWasBullet = false;
    for (const line of ls) {
      if (BULLET_RE.test(line.text)) {
        const h = line.text.replace(BULLET_RE, "").trim();
        if (current && h && current.value.highlights.length < 8) current.value.highlights.push(h.slice(0, 300));
        prevWasBullet = true;
        continue;
      }
      // A new project starts at the first line, or after a bullet run — a
      // bare prose line after the name is that project's description.
      if (!current || prevWasBullet) {
        if (current) proposal.projects.push(current);
        current = {
          value: {
            name: line.text.slice(0, 160),
            description: "",
            highlights: [],
            url: (URL_RE.exec(line.text)?.[0] ?? "").slice(0, 240),
          },
          confidence: "review",
          snippet: snippetOf(line.text),
          warnings: line.text.length > 90 ? ["Long line — the project title may include description text."] : [],
        };
      } else if (current.value.description.length < 800) {
        current.value.description = `${current.value.description}${current.value.description ? " " : ""}${line.text}`.slice(0, 800);
      }
      prevWasBullet = false;
    }
    if (current) proposal.projects.push(current);
  }

  // ------------------------------------------------------------ certificates
  const certSection = sectionByBucket(sections, "certificates");
  if (certSection) {
    for (const line of certSection.lines) {
      if (proposal.certificates.length >= 15) break;
      const t = line.text.replace(BULLET_RE, "").trim();
      if (!t) continue;
      const yearMatch = YEAR_ONLY_RE.exec(t);
      proposal.certificates.push({
        value: { name: t.slice(0, 200), issuer: "", date: yearMatch ? yearMatch[0].slice(0, 40) : "" },
        confidence: "review",
        snippet: snippetOf(line.text),
        warnings: yearMatch ? [] : ["No date detected — add the issue year if applicable."],
      });
    }
  }

  // ------------------------------------------------------------------ awards
  const awardSection = sectionByBucket(sections, "awards");
  if (awardSection) {
    for (const line of awardSection.lines) {
      if (proposal.awards.length >= 10) break;
      const t = line.text.replace(BULLET_RE, "").trim();
      if (!t) continue;
      const yearMatch = YEAR_ONLY_RE.exec(t);
      proposal.awards.push({
        value: { title: t.slice(0, 200), awarder: "", date: yearMatch ? yearMatch[0].slice(0, 40) : "", summary: "" },
        confidence: "review",
        snippet: snippetOf(line.text),
        warnings: [],
      });
    }
  }

  // ----------------------------------------------------- global review flags
  if (lines.length >= 10) {
    let run = 0;
    for (const l of lines) {
      run = l.text.length < 15 ? run + 1 : 0;
      if (run >= 6) {
        warnings.push("Many very short lines were found — the document may use columns or tables; check the reading order carefully.");
        break;
      }
    }
  }

  const parseableJobs = proposal.work
    .map((w) => ({ start: parseLooseDate(w.value.startDate), end: w.value.current ? null : parseLooseDate(w.value.endDate) }))
    .filter((r) => r.start);
  for (let a = 0; a < parseableJobs.length; a += 1) {
    for (let b = a + 1; b < parseableJobs.length; b += 1) {
      const A = parseableJobs[a];
      const B = parseableJobs[b];
      if (!A || !B || !A.start) continue;
      const aStart = A.start.y * 12 + (A.start.m ?? 6);
      const aEnd = A.end ? A.end.y * 12 + (A.end.m ?? 6) : 9999_12;
      const bStart = B.start!.y * 12 + (B.start!.m ?? 6);
      if (bStart < aEnd && bStart > aStart - 1) {
        warnings.push("Two roles overlap in time — overlapping jobs are valid, but confirm the dates are right.");
        break;
      }
    }
    if (warnings.some((w) => w.includes("overlap"))) break;
  }

  const undated = proposal.work.filter((w) => !w.value.startDate.trim()).length;
  if (undated > 0) warnings.push(`${undated} role${undated === 1 ? "" : "s"} detected without a start date.`);

  if (/ignore\s+(all\s+)?previous\s+instructions|disregard\s+\w*\s*instructions|you\s+are\s+now\s+a|system\s+prompt/i.test(input.text)) {
    warnings.push("Instruction-like text was found in the document. It is treated as content only — never as a command.");
  }

  if (proposal.basics.email === null && proposal.basics.phone === null) {
    warnings.push("No contact email or phone was detected — add at least one manually.");
  }

  proposal.warnings = warnings.slice(0, 14);
  // Final schema gate: the parsed result is what callers receive.
  return resumeImportProposalSchema.parse(proposal);
}
