import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR } from "@/lib/api-helpers";
import { DraftError, dismissEnquiryDraft, sendApprovedEnquiry } from "@/lib/riishe/drafts";
import { POST as createInquiryHandler } from "@/app/api/inquiries/route";

export const dynamic = "force-dynamic";

/**
 * POST /api/riishe/enquiries/[taskId]/send — the EXPLICIT confirmation step.
 * Sends a reviewed enquiry draft through the EXISTING POST /api/inquiries
 * handler (identical validation, rate limit, block checks and recipient
 * notification — the session cookie context carries through). One send per
 * draft, ever; duplicate and daily-limit checks apply.
 */
export const POST = handler(async (_req: NextRequest, ctx: { params: Promise<{ taskId: string }> }): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { taskId } = await ctx.params;
  try {
    const { inquiryId } = await sendApprovedEnquiry(user, taskId, (req) => createInquiryHandler(req));
    return ok({ sent: true, inquiryId });
  } catch (e) {
    if (e instanceof DraftError) {
      return err(e.message, e.reason === "not-found" ? 404 : e.reason === "already-sent" ? 409 : 400);
    }
    throw e;
  }
});

/** DELETE /api/riishe/enquiries/[taskId]/send — dismiss the draft (explicit "no"). */
export const DELETE = handler(async (_req: NextRequest, ctx: { params: Promise<{ taskId: string }> }): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { taskId } = await ctx.params;
  try {
    await dismissEnquiryDraft(user, taskId);
    return ok({ dismissed: true });
  } catch (e) {
    if (e instanceof DraftError && e.reason === "not-found") return ERR.notFound();
    throw e;
  }
});
