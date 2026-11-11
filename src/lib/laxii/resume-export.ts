/**
 * LAXII Resume Studio — document exporters.
 *
 * PDF  : pdfkit (MIT) — real selectable text on standard-14 fonts, so every
 *        template stays ATS-parseable (no rasterized text, no columns).
 * DOCX : docx (MIT) — proper Word paragraph/heading/bullet structure.
 *
 * Both renderers consume the SAME validated ResumeData that is stored in the
 * LaxiiResume row — exports can never contain content the user did not save.
 * Template selection changes typography and accents only, never content.
 *
 * Universal formats: sections render in the document's own order
 * (orderedResumeSections — honors the format structure, the user's custom
 * sections and heading renames), so a journalism CV, an academic CV and an
 * ATS resume are genuinely different documents, not recoloured clones.
 */

import PDFDocument from "pdfkit";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

import {
  orderedResumeSections,
  type ResumeCustomSection,
  type ResumeData,
  type ResumeTemplateId,
} from "./resume-schema";

const GOLD = { r: 168, g: 132, b: 44 } as const;
const DARK = { r: 24, g: 24, b: 28 } as const;
const GREY = { r: 90, g: 90, b: 96 } as const;

function joinNonEmpty(parts: (string | undefined | null)[], sep = " · "): string {
  return parts.map((p) => (p ?? "").trim()).filter(Boolean).join(sep);
}

function dateRange(start: string, end: string, current: boolean): string {
  const right = current ? "Present" : end.trim();
  return joinNonEmpty([start.trim(), right], " – ");
}

// --------------------------------------------------------------------- PDF

class PdfCursor {
  constructor(public doc: PDFKit.PDFDocument) {}
  get pageBottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }
  ensure(space: number) {
    if (this.doc.y + space > this.pageBottom) this.doc.addPage();
  }
}

type PdfTheme = {
  nameFont: string;
  nameSize: number;
  bodyFont: string;
  bodySize: number;
  headingFont: string;
  headingSize: number;
  headingColor: { readonly r: number; readonly g: number; readonly b: number };
  accentLine: boolean;
  centerName: boolean;
  darkBand: boolean;
  gap: number;
};

const PDF_THEMES: Record<ResumeTemplateId, PdfTheme> = {
  classic: {
    nameFont: "Times-Bold",
    nameSize: 22,
    bodyFont: "Times-Roman",
    bodySize: 10.5,
    headingFont: "Times-Bold",
    headingSize: 11.5,
    headingColor: DARK,
    accentLine: true,
    centerName: true,
    darkBand: false,
    gap: 8,
  },
  modern: {
    nameFont: "Helvetica-Bold",
    nameSize: 23,
    bodyFont: "Helvetica",
    bodySize: 9.8,
    headingFont: "Helvetica-Bold",
    headingSize: 10.5,
    headingColor: GOLD,
    accentLine: true,
    centerName: false,
    darkBand: false,
    gap: 9,
  },
  minimal: {
    nameFont: "Helvetica",
    nameSize: 18,
    bodyFont: "Helvetica",
    bodySize: 9.6,
    headingFont: "Helvetica",
    headingSize: 10,
    headingColor: GREY,
    accentLine: false,
    centerName: false,
    darkBand: false,
    gap: 12,
  },
  creative: {
    nameFont: "Helvetica-Bold",
    nameSize: 24,
    bodyFont: "Helvetica",
    bodySize: 9.8,
    headingFont: "Helvetica-Bold",
    headingSize: 10.5,
    headingColor: GOLD,
    accentLine: false,
    centerName: false,
    darkBand: true,
    gap: 9,
  },
};

export async function renderResumePdf(data: ResumeData, template: ResumeTemplateId): Promise<Buffer> {
  const theme = PDF_THEMES[template] ?? PDF_THEMES.classic;
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 46, bottom: 46, left: 48, right: 48 },
    info: { Title: `${data.basics.name || "Resume"} — Resume`, Author: data.basics.name || undefined },
    pdfVersion: "1.7",
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const cur = new PdfCursor(doc);
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // -- header
  if (theme.darkBand) {
    const bandH = 92;
    doc.save();
    doc.rect(0, 0, doc.page.width, bandH).fill([DARK.r, DARK.g, DARK.b]);
    doc.fillColor("#FFFFFF").font(theme.nameFont).fontSize(theme.nameSize);
    doc.text(data.basics.name || "", doc.page.margins.left, 30, { width: contentWidth });
    doc.font(theme.bodyFont).fontSize(9.5).fillColor("#D8C48A");
    const contact = joinNonEmpty([data.basics.label, data.basics.email, data.basics.phone, data.basics.location, data.basics.website]);
    if (contact) doc.text(contact, { width: contentWidth });
    doc.restore();
    doc.y = bandH + 24;
  } else {
    if (theme.centerName) {
      doc.font(theme.nameFont).fontSize(theme.nameSize).fillColor("#000000");
      doc.text(data.basics.name || "", { align: AlignmentType.CENTER, width: contentWidth });
      doc.font(theme.bodyFont).fontSize(theme.bodySize).fillColor("#333333");
      const contact = joinNonEmpty([data.basics.email, data.basics.phone, data.basics.location, data.basics.website]);
      if (contact) doc.text(contact, { align: AlignmentType.CENTER, width: contentWidth });
      if (data.basics.label) {
        doc.moveDown(0.2);
        doc.font(theme.bodyFont).fontSize(theme.bodySize + 0.5).fillColor("#333333");
        doc.text(data.basics.label, { align: AlignmentType.CENTER, width: contentWidth });
      }
    } else {
      doc.font(theme.nameFont).fontSize(theme.nameSize).fillColor("#000000");
      doc.text(data.basics.name || "", { width: contentWidth });
      doc.font(theme.bodyFont).fontSize(theme.bodySize).fillColor("#333333");
      const contact = joinNonEmpty([data.basics.label, data.basics.email, data.basics.phone, data.basics.location, data.basics.website]);
      if (contact) doc.text(contact, { width: contentWidth });
    }
    if (theme.accentLine) {
      doc.moveDown(0.4);
      doc.save();
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(1.1)
        .strokeColor(theme.headingColor === GOLD ? `rgb(${GOLD.r},${GOLD.g},${GOLD.b})` : "#222222").stroke();
      doc.restore();
    }
    doc.moveDown(0.6);
  }

  const heading = (title: string) => {
    cur.ensure(56);
    doc.moveDown(0.5);
    doc.font(theme.headingFont).fontSize(theme.headingSize).fillColor(`rgb(${theme.headingColor.r},${theme.headingColor.g},${theme.headingColor.b})`);
    doc.text(title.toUpperCase(), { width: contentWidth, characterSpacing: 0.8 });
    if (theme.accentLine) {
      doc.save();
      doc.moveTo(doc.page.margins.left, doc.y + 1).lineTo(doc.page.margins.left + 46, doc.y + 1).lineWidth(1.4)
        .strokeColor(`rgb(${GOLD.r},${GOLD.g},${GOLD.b})`).stroke();
      doc.restore();
    }
    doc.moveDown(0.35);
  };

  // Standard-14 font families: Helvetica uses -Oblique, Times uses -Italic.
  const familyBase = theme.bodyFont.includes("Times") ? "Times" : "Helvetica";
  const italicSuffix = familyBase === "Times" ? "-Italic" : "-Oblique";
  const fontFor = (o: { bold?: boolean; italic?: boolean }): string => {
    if (o.bold && o.italic) return `${familyBase}-Bold${familyBase === "Times" ? "Italic" : "Oblique"}`;
    if (o.bold) return `${familyBase}-Bold`;
    if (o.italic) return `${familyBase}${italicSuffix}`;
    return theme.bodyFont;
  };

  const body = (text: string, opts: { bold?: boolean; italic?: boolean; size?: number; color?: string } = {}) => {
    doc.font(fontFor(opts))
      .fontSize(opts.size ?? theme.bodySize)
      .fillColor(opts.color ?? "#1A1A1A");
    doc.text(text, { width: contentWidth });
  };

  const bullet = (text: string) => {
    cur.ensure(30);
    doc.font(theme.bodyFont).fontSize(theme.bodySize).fillColor("#1A1A1A");
    // pdfkit supports list bullets at runtime (bullet/bulletIndent options);
    // the bundled @types omit them, so the options are cast deliberately.
    const bulletOpts = {
      width: contentWidth - 14,
      indent: 14,
      bullet: { color: `rgb(${GOLD.r},${GOLD.g},${GOLD.b})` },
    } as unknown as PDFKit.Mixins.TextOptions;
    doc.text(text, bulletOpts);
  };

  // -- sections in document order (format structure + custom sections)
  for (const s of orderedResumeSections(data)) {
    heading(s.title);
    switch (s.kind) {
      case "summary":
        body(data.basics.summary.trim());
        break;
      case "work":
        for (const w of data.work) {
          cur.ensure(70);
          body(w.position || w.company, { bold: true, size: theme.bodySize + 0.7 });
          const meta = joinNonEmpty([w.company !== w.position ? w.company : "", dateRange(w.startDate, w.endDate, w.current)]);
          if (meta) body(meta, { italic: true, color: "#555555", size: theme.bodySize - 0.4 });
          if (w.summary.trim()) body(w.summary.trim());
          for (const h of w.highlights.filter(Boolean)) bullet(h);
          doc.moveDown(0.35);
        }
        break;
      case "education":
        for (const e of data.education) {
          cur.ensure(56);
          body(joinNonEmpty([e.studyType, e.area]) || e.institution, { bold: true, size: theme.bodySize + 0.7 });
          const meta = joinNonEmpty([e.institution, joinNonEmpty([e.startDate, e.endDate], " – "), e.score ? `Score: ${e.score}` : ""]);
          if (meta) body(meta, { italic: true, color: "#555555", size: theme.bodySize - 0.4 });
          doc.moveDown(0.3);
        }
        break;
      case "skills": {
        const skills = data.skills.map((sk) => sk.name.trim()).filter(Boolean);
        if (skills.length > 0) body(skills.join("  ·  "));
        break;
      }
      case "projects":
        for (const p of data.projects) {
          cur.ensure(56);
          body(joinNonEmpty([p.name, p.url]), { bold: true, size: theme.bodySize + 0.7 });
          if (p.description.trim()) body(p.description.trim());
          for (const h of p.highlights.filter(Boolean)) bullet(h);
          doc.moveDown(0.3);
        }
        break;
      case "certificates":
        for (const c of data.certificates) {
          cur.ensure(30);
          bullet(joinNonEmpty([c.name, c.issuer, c.date]));
        }
        break;
      case "awards":
        for (const a of data.awards) {
          cur.ensure(30);
          bullet(joinNonEmpty([a.title, a.awarder, a.date, a.summary]));
        }
        break;
      case "custom":
        renderCustomPdf(s.section, { cur, body, bullet, ensure: 40, gapAfter: 0.3 });
        break;
    }
  }

  doc.end();
  return done;
}

function renderCustomPdf(
  section: ResumeCustomSection,
  io: {
    cur: PdfCursor;
    body: (text: string, opts?: { bold?: boolean; italic?: boolean; size?: number; color?: string }) => void;
    bullet: (text: string) => void;
    ensure: number;
    gapAfter: number;
  }
) {
  const { cur, body, bullet } = io;
  for (const e of section.entries) {
    cur.ensure(io.ensure);
    body(joinNonEmpty([e.title, e.url]), { bold: true });
    if (e.subtitle.trim()) body(joinNonEmpty([e.subtitle, e.meta]), { italic: true, color: "#555555" });
    else if (e.meta.trim()) body(e.meta, { italic: true, color: "#555555" });
    if (e.summary.trim()) body(e.summary.trim());
    for (const h of e.highlights.filter(Boolean)) bullet(h);
    cur.doc.moveDown(io.gapAfter);
  }
}

// -------------------------------------------------------------------- DOCX

const DOCX_THEMES: Record<ResumeTemplateId, { font: string; accent: string; nameSize: number; headingShade: boolean; centerName: boolean }> = {
  classic: { font: "Times New Roman", accent: "181818", nameSize: 44, headingShade: false, centerName: true },
  modern: { font: "Calibri", accent: "A8842C", nameSize: 46, headingShade: false, centerName: false },
  minimal: { font: "Calibri", accent: "5A5A60", nameSize: 36, headingShade: false, centerName: false },
  creative: { font: "Calibri", accent: "A8842C", nameSize: 48, headingShade: true, centerName: false },
};

export async function renderResumeDocx(data: ResumeData, template: ResumeTemplateId): Promise<Buffer> {
  const theme = DOCX_THEMES[template] ?? DOCX_THEMES.classic;
  const children: Paragraph[] = [];

  const P = (text: string, o: { bold?: boolean; italics?: boolean; size?: number; color?: string; heading?: boolean; bullet?: boolean; center?: boolean; spacing?: number; allCaps?: boolean } = {}) =>
    new Paragraph({
      alignment: o.center ? AlignmentType.CENTER : undefined,
      bullet: o.bullet ? { level: 0 } : undefined,
      spacing: { after: o.spacing ?? 40 },
      children: [
        new TextRun({
          text,
          bold: o.bold,
          italics: o.italics,
          size: o.size ?? 20, // half-points: 20 = 10pt
          color: o.color ?? "1A1A1A",
          font: theme.font,
          allCaps: o.allCaps,
        }),
      ],
      ...(o.heading
        ? {
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: theme.accent, space: 2 } },
            spacing: { after: 80, before: 160 },
          }
        : {}),
    });

  const heading = (title: string) =>
    children.push(P(title.toUpperCase(), { bold: true, size: 22, color: theme.accent, heading: true, allCaps: true }));

  // Header
  children.push(P(data.basics.name || "", { bold: true, size: theme.nameSize, center: theme.centerName, spacing: 60 }));
  const contact = joinNonEmpty([data.basics.label, data.basics.email, data.basics.phone, data.basics.location, data.basics.website]);
  if (contact) children.push(P(contact, { size: 19, color: "555555", center: theme.centerName, spacing: 120 }));

  // -- sections in document order (format structure + custom sections)
  for (const s of orderedResumeSections(data)) {
    heading(s.title);
    switch (s.kind) {
      case "summary":
        children.push(P(data.basics.summary.trim()));
        break;
      case "work":
        for (const w of data.work) {
          children.push(P(w.position || w.company, { bold: true, size: 21 }));
          children.push(P(joinNonEmpty([w.company !== w.position ? w.company : "", dateRange(w.startDate, w.endDate, w.current)]), { italics: true, color: "555555" }));
          if (w.summary.trim()) children.push(P(w.summary.trim()));
          for (const h of w.highlights.filter(Boolean)) children.push(P(h, { bullet: true }));
        }
        break;
      case "education":
        for (const e of data.education) {
          children.push(P(joinNonEmpty([e.studyType, e.area]) || e.institution, { bold: true, size: 21 }));
          children.push(P(joinNonEmpty([e.institution, joinNonEmpty([e.startDate, e.endDate], " – "), e.score ? `Score: ${e.score}` : ""]), { italics: true, color: "555555" }));
        }
        break;
      case "skills": {
        const skills = data.skills.map((sk) => sk.name.trim()).filter(Boolean);
        if (skills.length > 0) children.push(P(skills.join("  ·  ")));
        break;
      }
      case "projects":
        for (const p of data.projects) {
          children.push(P(joinNonEmpty([p.name, p.url]), { bold: true, size: 21 }));
          if (p.description.trim()) children.push(P(p.description.trim()));
          for (const h of p.highlights.filter(Boolean)) children.push(P(h, { bullet: true }));
        }
        break;
      case "certificates":
        for (const c of data.certificates) children.push(P(joinNonEmpty([c.name, c.issuer, c.date]), { bullet: true }));
        break;
      case "awards":
        for (const a of data.awards) children.push(P(joinNonEmpty([a.title, a.awarder, a.date, a.summary]), { bullet: true }));
        break;
      case "custom":
        for (const e of s.section.entries) {
          children.push(P(joinNonEmpty([e.title, e.url]), { bold: true, size: 21 }));
          if (e.subtitle.trim()) children.push(P(joinNonEmpty([e.subtitle, e.meta]), { italics: true, color: "555555" }));
          if (e.summary.trim()) children.push(P(e.summary.trim()));
          for (const h of e.highlights.filter(Boolean)) children.push(P(h, { bullet: true }));
        }
        break;
    }
  }

  const doc = new Document({
    creator: "BEAN Folio LAXII",
    title: `${data.basics.name || "Resume"} — Resume`,
    sections: [{ properties: { page: { margin: { top: 640, bottom: 640, left: 720, right: 720 } } }, children }],
  });
  return Packer.toBuffer(doc) as unknown as Promise<Buffer>;
}
