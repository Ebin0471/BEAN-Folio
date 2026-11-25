import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, err, ERR, rateLimit, parseBody } from "@/lib/api-helpers";

import { resumeDataSchema, type ResumeTemplateId } from "@/lib/laxii/resume-schema";
import { renderResumePdf, renderResumeDocx } from "@/lib/laxii/resume-export";
import { verifyExportBytes } from "@/lib/laxii/resume-analysis";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  conversationId: z.string().min(1),
  format: z.enum(["pdf", "docx"]).default("pdf"),
  template: z.enum(["classic", "modern", "minimal", "creative"]).optional(),
});

function safeFileName(name: string): string {
  return (name || "resume").replace(/[^a-zA-Z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "resume";
}

/**
 * POST /api/laxii/resume/export — render the SAVED resume document to PDF or
 * DOCX and stream it as a direct download. The export renders the stored,
 * user-editable ResumeData verbatim — no AI involvement, no content changes.
 * PDF output uses real selectable text (standard-14 fonts), so the file stays
 * machine-readable. No ATS pass is ever guaranteed or claimed.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-resume-export:${user.id}`, 12, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, bodySchema);
  if (r.response) return r.response;
  const { conversationId, format, template } = r.data;

  const row = await db.laxiiResume.findFirst({
    where: { conversationId, userId: user.id },
    include: { conversation: { select: { title: true } } },
  });
  if (!row) return ERR.notFound();

  let data;
  try {
    data = resumeDataSchema.parse(JSON.parse(row.dataJson || "{}"));
  } catch {
    return err("The saved resume could not be read. Re-generate or re-save it first.", 400);
  }
  const empty =
    !data.basics.name.trim() &&
    data.work.length === 0 &&
    data.education.length === 0 &&
    data.skills.length === 0;
  if (empty) return err("This resume is empty — generate or fill in content first.", 400);

  const effectiveTemplate = (template ?? row.template) as ResumeTemplateId;
  try {
    if (format === "pdf") {
      const bytes = await renderResumePdf(data, effectiveTemplate);
      if (bytes.length < 500) return err("PDF export produced an unexpectedly small file. Please try again.", 500);
      // M33.5-B: verify the EXACT produced bytes by decoding them back —
      // the header carries the honest outcome (passed/warning/failed).
      let verification = "failed";
      try {
        const rt = await verifyExportBytes(bytes, "pdf", data);
        verification = !rt.decodeOk ? "failed" : rt.missingFacts.length === 0 && rt.readingOrderOk ? "passed" : "warning";
      } catch {
        verification = "failed";
      }
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(bytes.length),
          "Content-Disposition": `attachment; filename="${safeFileName(data.basics.name)}-resume.pdf"`,
          "Cache-Control": "no-store",
          "X-Bean-Export-Verification": verification,
        },
      });
    }
    const bytes = await renderResumeDocx(data, effectiveTemplate);
    if (bytes.length < 500) return err("DOCX export produced an unexpectedly small file. Please try again.", 500);
    let docxVerification = "failed";
    try {
      const rt = await verifyExportBytes(bytes, "docx", data);
      docxVerification = !rt.decodeOk ? "failed" : rt.missingFacts.length === 0 && rt.readingOrderOk ? "passed" : "warning";
    } catch {
      docxVerification = "failed";
    }
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${safeFileName(data.basics.name)}-resume.docx"`,
        "Cache-Control": "no-store",
        "X-Bean-Export-Verification": docxVerification,
      },
    });
  } catch (e) {
    console.error("[laxii-resume] export failure:", e);
    return err("Document export failed. Please try again.", 500);
  }
});
