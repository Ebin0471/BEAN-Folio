/// <reference types="bun-types" />
/**
 * M33.5-D — cover letter schema, anti-fabrication guards, export round-trip
 * (pure + real renderer bytes; no DB, no AI).
 *
 * Spec §11.4 coverage:
 *  - schema shape/version; wordCount computation;
 *  - entity guard: names must trace to facts or the JD — invented
 *    organizations are flagged; sender name and JD-named companies exempt;
 *  - metric guard: numbers must appear verbatim in facts/JD; calendar years
 *    exempt; "12 engineers" out of nowhere is flagged;
 *  - neutral greeting stays a placeholder (schema default, empty company);
 *  - PDF/DOCX export is selectable text, correctly ordered, signature never
 *    split, decode round-trip finds exact paragraphs.
 *
 * Run: bun test tests/cover-letter.test.ts
 */
import { describe, expect, test } from "bun:test";

import { coverLetterDataSchema, letterWordCount, COVER_LETTER_SCHEMA_VERSION } from "@/lib/laxii/cover-letter-schema";
import { findUnverifiableLetterContent } from "@/lib/laxii/cover-letter-service";
import { renderCoverLetterPdf, renderCoverLetterDocx, extractLetterText } from "@/lib/laxii/cover-letter-export";
import { resumeDataSchema, resumeFactsSchema } from "@/lib/laxii/resume-schema";

function sampleFacts() {
  return resumeFactsSchema.parse({
    basics: { name: "Asha Verma", email: "asha.verma@example.com", phone: "+91 90000 00000", location: "Bengaluru", summary: "" },
    work: [{ company: "Zeta Systems", position: "Software Engineer", startDate: "2021-03", endDate: "", current: true, summary: "Led a team of 4 engineers.", highlights: ["Cut build times by 40%"] }],
    education: [],
    skills: ["React"],
    custom: [],
  });
}

function sampleResume() {
  return resumeDataSchema.parse({
    basics: { name: "Asha Verma" },
    work: sampleFacts().work,
    custom: [],
    order: [],
    titles: {},
  });
}

describe("cover letter schema", () => {
  test("version pinned; empty letter defaults to neutral placeholder greeting", () => {
    const l = coverLetterDataSchema.parse({});
    expect(l.schemaVersion).toBe(COVER_LETTER_SCHEMA_VERSION);
    expect(l.salutation).toBe("Dear Hiring Manager");
    expect(l.companyName).toBe("");
    expect(l.hiringContactName).toBe("");
    expect(l.tone).toBe("formal");
    expect(l.bodyParagraphs).toEqual([]);
  });

  test("wordCount covers opening + body + closing only", () => {
    const l = coverLetterDataSchema.parse({
      opening: "I am writing to apply.",
      bodyParagraphs: ["My work at Zeta Systems.", "Second paragraph."],
      closing: "Thank you.",
    });
    expect(letterWordCount(l)).toBe(14);
  });
});

describe("letter anti-fabrication guards", () => {
  test("JD-named companies and fact companies pass; invented organizations are flagged", () => {
    const g = findUnverifiableLetterContent({
      letterText:
        "I am excited to apply to Meridian Labs. At Zeta Systems I led a team. Previously at Invented Corp I did things.",
      facts: sampleFacts(),
      resumeDoc: sampleResume(),
      jdText: "Meridian Labs is hiring a Senior Engineer in Bengaluru.",
    });
    expect(g.entities).toEqual(["Invented Corp"]);
  });

  test("metrics must trace to facts or the JD; calendar years are exempt", () => {
    const g = findUnverifiableLetterContent({
      letterText: "Since 2021 I have worked at Zeta Systems. I cut build times by 40% and managed 12 engineers across 3 sites.",
      facts: sampleFacts(),
      resumeDoc: sampleResume(),
      jdText: "",
    });
    // 40% exists in facts highlights; 2021 is a year (exempt); 12 and 3 are unsupported.
    expect(g.metrics).toEqual(["12", "3"]);
    expect(g.metrics.join(" ")).not.toContain("40%");
  });


  test("field-of-study mentions trace to confirmed education facts (E2E regression 2026-11-25)", () => {
    const facts = sampleFacts();
    facts.education = [
      { institution: "Visvesvaraya National Institute of Technology", area: "Computer Science", studyType: "B.Tech", startDate: "2015", endDate: "2019", score: "8.6 CGPA" },
    ];
    // Standalone field-of-study mentions previously failed the guard even
    // though they trace to confirmed facts (live E2E finding).
    const g = findUnverifiableLetterContent({
      letterText: "My degree in Computer Science prepared me for this role.",
      facts,
      resumeDoc: sampleResume(),
      jdText: "",
    });
    expect(g.entities).toEqual([]);
    // An unrelated credential is still rejected — the widening is traceable-only.
    const g2 = findUnverifiableLetterContent({
      letterText: "I hold an Autodesk Certified Professional credential.",
      facts,
      resumeDoc: sampleResume(),
      jdText: "",
    });
    expect(g2.entities).toEqual(["Autodesk Certified Professional"]);
  });

  test("sender's own name is never an entity violation", () => {
    const g = findUnverifiableLetterContent({
      letterText: "Asha Verma brings five years of frontend work.",
      facts: sampleFacts(),
      resumeDoc: sampleResume(),
      jdText: "",
    });
    expect(g.entities).toEqual([]);
  });
});

describe("cover letter export round trip (real bytes)", () => {
  const letter = coverLetterDataSchema.parse({
    basics: { name: "Asha Verma", email: "asha.verma@example.com", phone: "+91 90000 00000", location: "Bengaluru", website: "" },
    targetRole: "Senior Frontend Engineer",
    companyName: "Meridian Labs",
    date: "2026-11-25",
    salutation: "Dear Hiring Manager",
    opening: "I am writing to apply for the Senior Frontend Engineer role at Meridian Labs.",
    bodyParagraphs: [
      "At Zeta Systems I built design-system components used across product teams and cut build times by 40%.",
      "I work with React and TypeScript every day.",
    ],
    closing: "Thank you for your consideration.",
    signatureName: "Asha Verma",
    tone: "formal",
  });

  test("PDF: decodes, keeps every paragraph in order, formats the ISO date", async () => {
    const bytes = await renderCoverLetterPdf(letter);
    expect(bytes.length).toBeGreaterThan(1000);
    const text = await extractLetterText(bytes, "pdf");
    expect(text).toContain("25 November 2026");
    expect(text).toContain("Dear Hiring Manager,");
    expect(text).toContain(letter.opening);
    for (const p of letter.bodyParagraphs) expect(text).toContain(p.slice(0, Math.min(60, p.length)));
    expect(text).toContain(letter.closing);
    expect(text).toContain("Asha Verma");
    // Reading order: opening before closing before signature.
    const openIdx = text.indexOf("I am writing to apply");
    const closeIdx = text.indexOf("Thank you for your consideration");
    const sigIdx = text.lastIndexOf("Asha Verma");
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(openIdx);
    expect(sigIdx).toBeGreaterThan(closeIdx);
  }, 30000);

  test("DOCX: decodes, keeps every paragraph, closes before signature", async () => {
    const bytes = await renderCoverLetterDocx(letter);
    expect(bytes.length).toBeGreaterThan(1000);
    const text = await extractLetterText(bytes, "docx");
    expect(text).toContain(letter.opening.slice(0, 60));
    expect(text).toContain("Thank you for your consideration");
    const closeIdx = text.indexOf("Thank you for your consideration");
    const sigIdx = text.lastIndexOf("Asha Verma");
    expect(sigIdx).toBeGreaterThan(closeIdx);
  }, 30000);

  test("no invented addressee: empty company/contact renders no addressee block", async () => {
    const anon = coverLetterDataSchema.parse({ ...JSON.parse(JSON.stringify(letter)), companyName: "", hiringContactName: "" });
    const bytes = await renderCoverLetterPdf(anon);
    const text = await extractLetterText(bytes, "pdf");
    // The addressee BLOCK is omitted (date → salutation directly adjacent);
    // mentions inside the letter body prose are the letter's own text.
    expect(text).not.toContain("25 November 2026\nMeridian Labs");
    expect(text).toContain("25 November 2026\nDear Hiring Manager,");
  }, 30000);
});
