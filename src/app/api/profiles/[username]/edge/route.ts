import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit, parseBody } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ username: string }> };

const edgeSchema = z
  .object({
    muted: z.boolean().optional(),
    restricted: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.muted !== undefined || v.restricted !== undefined, { message: "Nothing to update" });

async function loadTarget(username: string) {
  const uname = username.trim().toLowerCase();
  return db.user.findFirst({ where: { username: uname, deletedAt: null } });
}

/**
 * PATCH /api/profiles/:username/edge — per-pair relationship controls the
 * viewer sets on the target: mute (their posts never enter the viewer's
 * feeds and their actions never notify the viewer) and restrict (their new
 * comments on the viewer's posts start HIDDEN until approved). Both are
 * one-directional and private: the target is never notified and can always
 * still see the viewer's public content.
 */
export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const sessionUser = await getSessionUser();
  if (!sessionUser) return ERR.unauthorized();

  if (!rateLimit(`edge:${sessionUser.id}`, 60, 60_000)) return ERR.rateLimited();

  const parsed = await parseBody(req, edgeSchema);
  if (parsed.response) return parsed.response;
  const input = parsed.data;

  const { username } = await params;
  const target = await loadTarget(username);
  if (!target) return ERR.notFound();
  if (target.id === sessionUser.id) return err("You cannot change your own controls", 400);

  const data: { muted?: boolean; restricted?: boolean } = {};
  if (input.muted !== undefined) data.muted = input.muted;
  if (input.restricted !== undefined) data.restricted = input.restricted;

  const edge = await db.accountEdge.upsert({
    where: { userId_targetId: { userId: sessionUser.id, targetId: target.id } },
    create: { userId: sessionUser.id, targetId: target.id, ...data },
    update: data,
  });

  return ok({ muted: edge.muted, restricted: edge.restricted });
});
