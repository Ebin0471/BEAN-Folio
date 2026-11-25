import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit } from "@/lib/api-helpers";

import {
  buildImportProposal,
  resolveUploadKind,
  verifyUploadSignature,
  MAX_UPLOAD_BYTES,
  MAX_TEXT_CHARS,
  type ImportMethod,
} from "@/lib/laxii/resume-import";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function capText(raw: string): { text: string; truncated: boolean } {
  const t = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (t.length <= MAX_TEXT_CHARS) return { text: t, truncated: false };
  return { text: `${t.slice(0, Math.floor(MAX_TEXT_CHARS * 0.9))}\n…[text truncated]…`, truncated: true };
}

/**
 * POST /api/laxii/resume/import — M33.5-A structured import proposal.
 *
 * Same intake contract as /parse (PDF/DOCX/TXT/MD, 10 MB, non-persistent,
 * owner-gated, rate-limited) plus byte-signature validation and a
 * deterministic, schema-versioned extraction PROPOSAL. The endpoint stores
 * nothing; extracted text and snippets exist only in this response until the
 * user explicitly confirms fields in the review UI. Scanned/image-only PDFs
 * keep the honest unsupported message — no OCR is claimed (M33.5 decision
 * recorded in docs/reports/M33.5_CAPABILITY_GAP_REPORT.md §4).
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-resume-import:${user.id}`, 6, 60_000)) return ERR.rateLimited();

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return err("Attach a resume file (PDF, DOCX or TXT).", 400);
  if (file.size > MAX_UPLOAD_BYTES) return err("The file is too large (max 10 MB).", 400);
  if (file.size === 0) return err("The file is empty.", 400);

  const bytes = Buffer.from(await file.arrayBuffer());
  const kind = resolveUploadKind(file.name, file.type);
  if (!kind) return err("Unsupported file type — upload a PDF, DOCX or TXT resume.", 400);

  const signature = verifyUploadSignature(bytes, kind);
  if (!signature.ok) return err(signature.reason ?? "The file content does not match its type.", 400);

  let full = "";
  let method: ImportMethod;
  try {
    if (kind === "pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      try {
        const result = await parser.getText();
        full = (result.text ?? "").trim();
      } finally {
        await parser.destroy().catch(() => {});
      }
      if (!full) {
        return err(
          "No machine-readable text found in this PDF (scanned/image-only resumes can't be read as text). Enter your details manually instead.",
          400
        );
      }
      method = "pdf-text";
    } else if (kind === "docx") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: bytes });
      full = (result.value ?? "").trim();
      if (!full) return err("No readable text found in this DOCX file.", 400);
      method = "docx-text";
    } else {
      full = bytes.toString("utf-8").trim();
      if (!full) return err("The text file is empty.", 400);
      method = "plain-text";
    }
  } catch (e) {
    // Metadata-only diagnostics — never the document body.
    console.error("[laxii-resume-import] extraction failure:", e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
    return err("The file could not be read — it may be corrupted or password-protected.", 400);
  }

  const capped = capText(full);
  const proposal = buildImportProposal({
    text: capped.text,
    method,
    truncated: capped.truncated,
    fileName: file.name.slice(0, 200),
  });

  return ok({
    text: capped.text,
    truncated: capped.truncated,
    source: method,
    proposal,
  });
});
