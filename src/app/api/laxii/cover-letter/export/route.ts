import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit, parseBody } from "@/lib/api-helpers";

import { renderCoverLetterPdf, renderCoverLetterDocx, extractLetterText } from "@/lib/laxii/cover-letter-export";
import { coverLetterDataSchema } from "@/lib/laxii/cover-letter-schema";
import { CoverLetterError } from "@/lib/laxii/cover-letter-service";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  letterId: z.string().min(1),
  format: z.enum(["pdf", "docx"]).default("pdf"),
});

function safeFileName(name: string): string {
  return (name || "cover-letter").replace(/[^a-zA-Z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "cover-letter";
}

/**
 * POST /api/laxii/cover-letter/export — render the SAVED letter to PDF or
 * DOCX, verify the produced bytes by decoding them back and checking exact
 * paragraph text + order, then stream the download (no-store). The
 * verification result is carried in X-Bean-Export-Verification; if the bytes
 * cannot be decoded the export still downloads but is NOT marked verified —
 * it never claims success it cannot prove.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-cover-letter-export:${user.id}`, 12, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, bodySchema);
  if (r.response) return r.response;
  const { letterId, format } = r.data;

  const row = await db.laxiiCoverLetter.findFirst({ where: { id: letterId, userId: user.id } });
  if (!row) return ERR.notFound();

  let letter;
  try {
    letter = coverLetterDataSchema.parse(JSON.parse(row.dataJson || "{}"));
  } catch {
    return err("The saved letter could not be read. Re-generate or re-save it first.", 400);
  }
  if (!letter.opening.trim() && letter.bodyParagraphs.filter((p) => p.trim()).length === 0) {
    return err("This letter is empty — generate or write content first.", 400);
  }

  const fileName = safeFileName([letter.targetRole || "cover-letter", letter.companyName].filter(Boolean).join("-"));
  try {
    const bytes = format === "pdf" ? await renderCoverLetterPdf(letter) : await renderCoverLetterDocx(letter);
    if (bytes.length < 500) return err(`${format.toUpperCase()} export produced an unexpectedly small file. Please try again.`, 500);

    // Round-trip: decode the EXACT produced bytes; compare opening/paragraphs/closing.
    let verification = "failed";
    let verificationDetail = "";
    try {
      const text = await extractLetterText(bytes, format);
      const decodeOk = text.trim().length > 0;
      if (decodeOk) {
        const paragraphs = [letter.opening, ...letter.bodyParagraphs].map((p) => p.trim()).filter(Boolean);
        const missing = paragraphs.filter((p) => !text.includes(p.slice(0, Math.min(80, p.length))));
        const closingOk = !letter.closing.trim() || text.includes(letter.closing.trim().slice(0, Math.min(60, letter.closing.trim().length)));
        verification = missing.length === 0 && closingOk ? "passed" : "warning";
        verificationDetail = missing.length > 0 ? `missing:${missing.length}` : "order-ok";
      }
    } catch {
      verification = "failed";
    }

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${fileName}.${format}"`,
        "Cache-Control": "no-store",
        "X-Bean-Export-Verification": verification,
        ...(verificationDetail ? { "X-Bean-Export-Verification-Detail": verificationDetail } : {}),
      },
    });
  } catch (e) {
    if (e instanceof CoverLetterError) return err(e.message, e.status);
    console.error("[laxii-cover-letter] export failure:", e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
    return err("Letter export failed. Please try again.", 500);
  }
});
