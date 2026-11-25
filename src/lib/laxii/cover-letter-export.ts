/**
 * LAXII Cover Letter Studio — M33.5-D exporters.
 *
 * Reuses the SAME document stacks as the resume exporters (pdfkit MIT /
 * docx MIT — no new dependencies, spec §6.4) with LETTER-appropriate layout:
 * sender block, date, addressee block (only user-supplied lines), salutation,
 * paragraphs, closing and signature. Text is always selectable; page breaks
 * never split the closing/signature block; no blank trailing pages.
 *
 * Exports render the SAVED letter verbatim — no AI, no content changes.
 */

import PDFDocument from "pdfkit";
import { AlignmentType, Document, Packer, Paragraph, TextRun } from "docx";

import type { CoverLetterData } from "./cover-letter-schema";

const INK = "#1A1A1A";
const MUTED = "#555555";
const GOLD = "A8842C";

function formatLetterDate(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  // ISO yyyy-mm-dd → "25 November 2026"; anything else renders verbatim.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
  }
  return t;
}

// --------------------------------------------------------------------- PDF

export async function renderCoverLetterPdf(letter: CoverLetterData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 64, bottom: 64, left: 72, right: 72 },
    info: {
      Title: `${letter.targetRole || "Cover letter"}${letter.companyName ? ` — ${letter.companyName}` : ""}`,
      Author: letter.basics.name || undefined,
    },
    pdfVersion: "1.7",
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  // Sender block
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#000000").text(letter.basics.name || "", { width: W });
  const contact = [letter.basics.email, letter.basics.phone, letter.basics.location, letter.basics.website].map((s) => s.trim()).filter(Boolean).join("  ·  ");
  if (contact) {
    doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(contact, { width: W });
  }
  doc.moveDown(1.4);

  // Date
  const dateLine = formatLetterDate(letter.date);
  if (dateLine) {
    doc.font("Helvetica").fontSize(10).fillColor(INK).text(dateLine, { width: W });
    doc.moveDown(1.2);
  }

  // Addressee block — only user-supplied lines, never invented
  const addressee = [letter.hiringContactName.trim(), letter.companyName.trim()].filter(Boolean);
  if (addressee.length > 0) {
    doc.font("Helvetica").fontSize(10).fillColor(INK).text(addressee.join("\n"), { width: W });
    doc.moveDown(1.2);
  }

  // Salutation
  if (letter.salutation.trim()) {
    doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(letter.salutation.trim() + ",", { width: W });
    doc.moveDown(0.8);
  }

  // Body
  const paragraph = (text: string) => {
    doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(text, { width: W, paragraphGap: 10, lineGap: 1.5 });
  };
  if (letter.opening.trim()) paragraph(letter.opening.trim());
  for (const p of letter.bodyParagraphs) if (p.trim()) paragraph(p.trim());

  // Closing + signature — never split across pages
  const signatureBlockHeight = 90;
  if (doc.y + signatureBlockHeight > bottom()) {
    doc.addPage();
  }
  doc.moveDown(0.8);
  if (letter.closing.trim()) paragraph(letter.closing.trim());
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#000000").text(letter.signatureName || letter.basics.name || "", { width: W });

  doc.end();
  return done;
}

// -------------------------------------------------------------------- DOCX

export async function renderCoverLetterDocx(letter: CoverLetterData): Promise<Buffer> {
  const children: Paragraph[] = [];
  const P = (text: string, o: { bold?: boolean; size?: number; color?: string; spacing?: number; center?: boolean } = {}) =>
    new Paragraph({
      alignment: o.center ? AlignmentType.CENTER : undefined,
      spacing: { after: o.spacing ?? 120 },
      children: [
        new TextRun({ text, bold: o.bold, size: o.size ?? 21, color: o.color ?? "1A1A1A", font: "Calibri" }),
      ],
    });

  children.push(P(letter.basics.name || "", { bold: true, size: 30, spacing: 40 }));
  const contact = [letter.basics.email, letter.basics.phone, letter.basics.location, letter.basics.website].map((s) => s.trim()).filter(Boolean).join("  ·  ");
  if (contact) children.push(P(contact, { size: 19, color: MUTED, spacing: 240 }));

  const dateLine = formatLetterDate(letter.date);
  if (dateLine) children.push(P(dateLine, { spacing: 200 }));

  const addressee = [letter.hiringContactName.trim(), letter.companyName.trim()].filter(Boolean).join("\n");
  if (addressee) children.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: addressee, size: 21, color: "1A1A1A", font: "Calibri", break: 0 })] }));

  if (letter.salutation.trim()) children.push(P(`${letter.salutation.trim()},`, { spacing: 160 }));

  const body = [letter.opening, ...letter.bodyParagraphs].map((p) => p.trim()).filter(Boolean);
  for (const p of body) children.push(P(p, { spacing: 160 }));

  if (letter.closing.trim()) children.push(P(letter.closing.trim(), { spacing: 240 }));
  children.push(P(letter.signatureName || letter.basics.name || "", { bold: true }));

  const doc = new Document({
    creator: "BEAN Folio LAXII",
    title: `${letter.targetRole || "Cover letter"}${letter.companyName ? ` — ${letter.companyName}` : ""}`,
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children }],
  });
  return Packer.toBuffer(doc) as unknown as Promise<Buffer>;
}

/** Re-extract selectable text from produced bytes (round-trip verification). */
export async function extractLetterText(bytes: Buffer, format: "pdf" | "docx"): Promise<string> {
  if (format === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const result = await parser.getText();
      return (result.text ?? "").replace(/\r\n?/g, "\n");
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: bytes });
  return (result.value ?? "").replace(/\r\n?/g, "\n");
}
