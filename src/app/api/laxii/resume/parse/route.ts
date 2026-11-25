import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit } from "@/lib/api-helpers";
import { resolveUploadKind, verifyUploadSignature } from "@/lib/laxii/resume-import";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT_CHARS = 8000;

function capText(raw: string): { text: string; truncated: boolean } {
  const t = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (t.length <= MAX_TEXT_CHARS) return { text: t, truncated: false };
  return { text: `${t.slice(0, Math.floor(MAX_TEXT_CHARS * 0.9))}\n…[text truncated]…`, truncated: true };
}

/**
 * POST /api/laxii/resume/parse — extract plain text from an uploaded existing
 * resume (PDF via pdf-parse, DOCX via mammoth, TXT/MD directly). The text is
 * returned to the studio as user-provided SOURCE MATERIAL for generation —
 * it is stored nowhere by this endpoint and the generation pipeline treats it
 * exactly like typed facts (anti-fabrication guard included).
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-resume-parse:${user.id}`, 6, 60_000)) return ERR.rateLimited();

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return err("Attach a resume file (PDF, DOCX or TXT).", 400);
  if (file.size > MAX_UPLOAD_BYTES) return err("The file is too large (max 10 MB).", 400);

  const bytes = Buffer.from(await file.arrayBuffer());

  // M33.5-A: validate actual file bytes against the claimed type — a renamed
  // or corrupted upload is rejected with a precise message.
  const uploadKind = resolveUploadKind(file.name, file.type);
  if (!uploadKind) return err("Unsupported file type — upload a PDF, DOCX or TXT resume.", 400);
  const signature = verifyUploadSignature(bytes, uploadKind);
  if (!signature.ok) return err(signature.reason ?? "The file content does not match its type.", 400);

  const name = file.name.toLowerCase();

  try {
    if (file.type === "application/pdf" || name.endsWith(".pdf")) {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      try {
        const result = await parser.getText();
        const full = (result.text ?? "").trim();
        if (!full) {
          return err("No machine-readable text found in this PDF (scanned resumes can't be read as text).", 400);
        }
        const capped = capText(full);
        return ok({ text: capped.text, truncated: capped.truncated, source: "pdf" });
      } finally {
        await parser.destroy().catch(() => {});
      }
    }

    if (
      file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      name.endsWith(".docx")
    ) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: bytes });
      const full = (result.value ?? "").trim();
      if (!full) return err("No readable text found in this DOCX file.", 400);
      const capped = capText(full);
      return ok({ text: capped.text, truncated: capped.truncated, source: "docx" });
    }

    if (file.type.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".md")) {
      const full = bytes.toString("utf-8").trim();
      if (!full) return err("The text file is empty.", 400);
      const capped = capText(full);
      return ok({ text: capped.text, truncated: capped.truncated, source: "text" });
    }

    return err("Unsupported file type — upload a PDF, DOCX or TXT resume.", 400);
  } catch (e) {
    console.error("[laxii-resume] parse failure:", e);
    return err("The file could not be read — it may be corrupted or password-protected.", 400);
  }
});
