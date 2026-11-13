import { NextRequest } from "next/server";
import { z } from "zod";

import { handler, ok, err, ERR, parseBodySized, rateLimitShared } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { applyFileProposal } from "@/lib/giftz/project-agent";

export const dynamic = "force-dynamic";
// File-tree writes + a version snapshot are fast, but the honest ceiling
// matches the other mutating giftz routes (§4).
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  // The SiteStudioMessage carrying the kind-"files" proposalJson (§6).
  messageId: z.string().min(1).max(64),
});

/**
 * POST /api/giftz/sites/[id]/files/apply-proposal — apply a chat proposal's
 * kind-"files" changes to the WORKING tree (source "ai").
 *
 * Contract §4/§6: owner-scoped; the proposal's message must belong to a
 * giftz session owned by the caller and targeting THIS site; the working
 * tree is only ever mutated here (never during the turn itself); a synced
 * site.config.json is re-validated (schema + media guard) BEFORE anything is
 * applied — 422 leaves the tree untouched; the apply snapshots a version
 * (source "ai") and records the ai.edit activity.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const limited = await rateLimitShared(`giftz-apply:${user.id}`, 20, 60_000);
  if (limited) return limited;

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id } });
  if (!site) return ERR.notFound();

  const r = await parseBodySized(req, bodySchema, 4_000);
  if (r.response) return r.response;

  const result = await applyFileProposal(user, site, r.data.messageId);
  if (!result.ok) return err(result.error, result.status);

  return ok({
    applied: result.applied,
    files: result.files,
    ...(result.config ? { config: result.config } : {}),
  });
});
