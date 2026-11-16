import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { serializeVerification } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/ox/verifications — list verification submissions for the
 * admin review queue (O1 pilot: manual admin review).
 *
 * Authorization: ADMIN session required (requireAdmin; anonymous and
 * non-admin callers are indistinguishable 403s). Supports ?status=
 * (PENDING default | VERIFIED | REJECTED | ALL), newest first, 50 rows.
 *
 * The list carries the org display triple and the SECURE evidence reference
 * (never document content — no such content exists in OX). Decisions happen
 * through PATCH /api/admin/ox/verifications/[id] and are always audited.
 */

const VALID_STATUSES = ["PENDING", "VERIFIED", "REJECTED", "ALL"] as const;

export const GET = handler(async (req: NextRequest) => {
  const admin = await requireAdmin();
  if (!admin) return ERR.forbidden();

  const url = new URL(req.url);
  const statusParam = (url.searchParams.get("status") ?? "PENDING").toUpperCase();
  const status = (VALID_STATUSES as readonly string[]).includes(statusParam) ? statusParam : "PENDING";

  const verifications = await db.employerVerification.findMany({
    where: status === "ALL" ? {} : { status },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      organization: {
        select: {
          id: true,
          displayName: true,
          legalName: true,
          slug: true,
          industry: true,
          companySize: true,
          headquarters: true,
          verificationStatus: true,
          createdAt: true,
        },
      },
    },
  });

  return ok({
    verifications: verifications.map((v) => ({
      ...serializeVerification(v),
      organization: {
        id: v.organization.id,
        displayName: v.organization.displayName,
        legalName: v.organization.legalName,
        slug: v.organization.slug,
        industry: v.organization.industry,
        companySize: v.organization.companySize,
        headquarters: v.organization.headquarters,
        verificationStatus: v.organization.verificationStatus,
        createdAt: v.organization.createdAt.toISOString(),
      },
    })),
  });
});
