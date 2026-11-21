import { NextRequest } from "next/server";

import { handler, ok, err, ERR, rateLimitShared } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { DOMAIN_ROUTING_NOTE, serializeDomain, verifyGiftzDomain } from "@/lib/giftz/project-domains";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; domainId: string }> };

/**
 * POST /api/giftz/sites/[id]/domains/[domainId]/verify — run the REAL DNS
 * verification check (contract §7.3): a TXT record
 * "bean-giftz-verification=<token>" or an A/CNAME resolution to the serving
 * host from resolveShareOrigin(). Outcomes are honest:
 *   VERIFIED + verifiedAt       — proof found in public DNS
 *   PENDING  + lastError        — NXDOMAIN / lookup failure ("not found yet")
 *   FAILED   + lastError        — records exist but do not match
 * Never auto-VERIFIED, and verification is NOT routing — the response carries
 * the honest routingNote.
 */
export const POST = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const limited = await rateLimitShared(`giftz-domain-verify:${user.id}`, 10, 60_000);
  if (limited) return limited;

  const { id, domainId } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const domain = await db.giftzDomain.findFirst({ where: { id: domainId, siteId: site.id } });
  if (!domain) return ERR.notFound();

  const result = await verifyGiftzDomain(domain, user.id);
  if (!result.ok) return err(result.message, result.status);

  return ok({ domain: serializeDomain(result.domain), routingNote: DOMAIN_ROUTING_NOTE });
});
