import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { serializeInvitationForCandidate, type StoredInvitationRow } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * M-O6 — candidate invitation inbox = history (plan §9.2, RD-15/override B).
 *
 * Returns ALL of the authenticated candidate's own invitations — every
 * status, truthful badges, `unreadCount` (SENT rows with viewedAt = null,
 * RD-18) — newest first, bounded pagination. Recipient-only: the WHERE binds
 * candidateUserId to the session user; another candidate's invitation is
 * 404-invisible (existence-hiding). Override B: this surface NEVER consults
 * discovery consent — response rights survive revocation; it also never
 * serializes private profile content (there is none on this shape by
 * construction). Employer identity is limited to public fields (D12).
 */
const querySchema = z
  .object({
    status: z
      .enum(["SENT", "VIEWED", "ACCEPTED", "DECLINED", "NEGOTIATION_REQUESTED", "EXPIRED", "WITHDRAWN"])
      .optional(),
    page: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

const INBOX_PAGE_SIZE = 25;

export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const limited = await rateLimitShared(`ox:me-invitations:${user.id}`, 60, 3600_000);
  if (limited) return limited;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) return err("Invalid inbox query", 400, "OX_INVITATION_INVALID_PAYLOAD");
  const query = parsed.data;
  const page = query.page ?? 1;

  const [rows, unreadCount, total] = await Promise.all([
    db.opportunityInvitation.findMany({
      where: {
        candidateUserId: user.id,
        // RD-17: DRAFT rows are employer-private working artifacts — they are
        // structurally invisible to candidates. (The candidateUserId binding
        // alone would surface drafts of which this candidate is the intended
        // recipient; the status filter removes them.)
        status: { in: ["SENT", "VIEWED", "ACCEPTED", "DECLINED", "NEGOTIATION_REQUESTED", "EXPIRED", "WITHDRAWN"] },
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * INBOX_PAGE_SIZE,
      take: INBOX_PAGE_SIZE + 1,
    }),
    db.opportunityInvitation.count({
      where: { candidateUserId: user.id, status: "SENT", viewedAt: null },
    }),
    db.opportunityInvitation.count({
      where: {
        candidateUserId: user.id,
        status: { in: ["SENT", "VIEWED", "ACCEPTED", "DECLINED", "NEGOTIATION_REQUESTED", "EXPIRED", "WITHDRAWN"] },
      },
    }),
  ]);

  const hasMore = rows.length > INBOX_PAGE_SIZE;
  const items: Record<string, unknown>[] = [];
  for (const row of rows.slice(0, INBOX_PAGE_SIZE) as StoredInvitationRow[]) {
    const [organization, opportunity] = await Promise.all([
      db.employerOrganization.findUnique({
        where: { id: row.organizationId },
        select: { id: true, displayName: true, slug: true },
      }),
      db.opportunity.findUnique({
        where: { id: row.opportunityId },
        select: { id: true, title: true, status: true },
      }),
    ]);
    items.push(
      serializeInvitationForCandidate(row, {
        organization: organization ?? { id: row.organizationId, displayName: "Unknown organization", slug: "unknown" },
        opportunity: opportunity ?? { id: row.opportunityId, title: "Unknown opportunity", status: "UNKNOWN" },
      })
    );
  }

  return ok({
    page,
    pageSize: INBOX_PAGE_SIZE,
    hasMore,
    total,
    unreadCount,
    invitations: items,
  });
});
