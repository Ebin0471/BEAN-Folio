import { NextRequest } from "next/server";
import { z } from "zod";

import { handler, ok, err, ERR, parseBody, rateLimitShared } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  HOSTNAME_MAX_LENGTH,
  newVerificationToken,
  serializeDomain,
  validateHostname,
} from "@/lib/giftz/project-domains";
import { recordGiftzActivity } from "@/lib/giftz/project-activity";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const postSchema = z.object({
  hostname: z.string().max(HOSTNAME_MAX_LENGTH + 64),
});

/**
 * GET /api/giftz/sites/[id]/domains — the generated site's custom domains
 * with their real verification state (PENDING / VERIFIED / FAILED), the
 * verification token (the TXT record to create is
 * "bean-giftz-verification=<token>") and the last honest DNS error.
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const domains = await db.giftzDomain.findMany({
    where: { siteId: id },
    orderBy: { createdAt: "desc" },
  });

  return ok({ domains: domains.map(serializeDomain) });
});

/**
 * POST /api/giftz/sites/[id]/domains — claim a custom hostname for this site.
 * Hostnames are validated as bare DNS names (lowercased + trimmed; no scheme,
 * port or path; ≤253 chars; labels ≤63) and are UNIQUE across the whole table
 * (@@hostname): a taken hostname is a friendly 409. Creation generates the
 * one-time verification token; DNS is NOT checked here — verification is an
 * explicit, real check via the verify route.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const limited = await rateLimitShared(`giftz-domain:${user.id}`, 10, 60_000);
  if (limited) return limited;

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const r = await parseBody(req, postSchema);
  if (r.response) return r.response;

  const validated = validateHostname(r.data.hostname);
  if (!validated.ok) return err(validated.message, 400);
  const hostname = validated.hostname;

  // Defense in depth (the regex already forbids these — keep the checks
  // explicit so the honest error never depends on regex internals alone).
  if (hostname.includes(":") || hostname.includes("/") || hostname.includes("\\") || hostname.includes("@")) {
    return err("Enter a bare hostname like www.example.com — no scheme, port, path or credentials.", 400);
  }

  const existing = await db.giftzDomain.findUnique({ where: { hostname } });
  if (existing) {
    return err(
      existing.siteId === site.id
        ? `${hostname} is already added to this site.`
        : `${hostname} is already connected to another generated site — each hostname can serve exactly one site.`,
      409
    );
  }

  const domain = await db.giftzDomain.create({
    data: {
      siteId: site.id,
      hostname,
      status: "PENDING",
      verificationToken: newVerificationToken(),
    },
  });

  await recordGiftzActivity(site.id, user.id, "domain.add", {
    domainId: domain.id,
    hostname,
    // Surface the expected record shape so the creator knows what to create.
    txtRecordHint: `bean-giftz-verification=<token>`,
  });

  return ok({ domain: serializeDomain(domain) });
});
