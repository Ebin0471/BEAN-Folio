import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";

import { resumeDataSchema } from "@/lib/laxii/resume-schema";
import { renderResumePdf, renderResumeDocx } from "@/lib/laxii/resume-export";
import { verifyExportBytes } from "@/lib/laxii/resume-analysis";
import type { ResumeTemplateId } from "@/lib/laxii/resume-schema";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  conversationId: z.string().min(1),
  format: z.enum(["pdf", "docx"]).default("pdf"),
  template: z.enum(["classic", "modern", "minimal", "creative"]).optional(),
});

/**
 * POST /api/laxii/resume/export/verify — M33.5-B export round-trip check.
 *
 * Renders the SAVED resume with the same exporters as the real download,
 * then DECODES the produced bytes and compares key facts + reading order
 * against the saved document (spec §5.2 check 12). Nothing is downloaded;
 * no file is stored. This verifies OUR export pipeline only — it is not an
 * employer ATS simulation.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-resume-export-verify:${user.id}`, 10, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, bodySchema);
  if (r.response) return r.response;
  const { conversationId, format, template } = r.data;

  const row = await db.laxiiResume.findFirst({
    where: { conversationId, userId: user.id },
  });
  if (!row) return ERR.notFound();

  let data;
  try {
    data = resumeDataSchema.parse(JSON.parse(row.dataJson || "{}"));
  } catch {
    return err("The saved resume could not be read. Re-generate or re-save it first.", 400);
  }
  const empty =
    !data.basics.name.trim() && data.work.length === 0 && data.education.length === 0 && data.skills.length === 0;
  if (empty) return err("This resume is empty — generate or fill in content first.", 400);

  try {
    const effectiveTemplate = (template ?? row.template) as ResumeTemplateId;
    const bytes = format === "pdf" ? await renderResumePdf(data, effectiveTemplate) : await renderResumeDocx(data, effectiveTemplate);
    if (bytes.length < 500) return err("The document renderer produced an unexpectedly small file. Please try again.", 500);
    const verification = await verifyExportBytes(bytes, format, data);
    return ok({ verification });
  } catch {
    return err("Export verification failed. Please try again.", 500);
  }
});
