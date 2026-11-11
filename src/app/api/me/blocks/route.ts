import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { toPublicPerson } from "@/lib/serialize";
import type { PublicPerson } from "@/lib/types";

export const dynamic = "force-dynamic";

const personInclude = {
  professions: { include: { profession: true } },
  skills: { include: { skill: true } },
} as const;

export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const rows = await db.block.findMany({
    where: { blockerId: user.id },
    include: { blocked: { include: personInclude } },
    orderBy: { createdAt: "desc" },
  });

  const blocks: PublicPerson[] = rows
    .filter((b) => !b.blocked.deletedAt)
    .map((b) => toPublicPerson(b.blocked));

  return ok({ blocks });
});

const blockSchema = z.object({
  username: z.string().trim().min(1).max(40),
});

export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const r = await parseBody(req, blockSchema);
  if (r.response) return r.response;

  const target = await db.user.findUnique({
    where: { username: r.data.username.toLowerCase() },
  });
  if (!target || target.deletedAt) return ERR.notFound();
  if (target.id === user.id) return err("You cannot block yourself", 400);

  // Idempotent create.
  await db.block.upsert({
    where: { blockerId_blockedId: { blockerId: user.id, blockedId: target.id } },
    create: { blockerId: user.id, blockedId: target.id },
    update: {},
  });

  // Blocking severs the social graph in both directions.
  await db.follow.deleteMany({ where: { followerId: user.id, followingId: target.id } });
  await db.follow.deleteMany({ where: { followerId: target.id, followingId: user.id } });

  return ok({ ok: true });
});

export const DELETE = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const username = req.nextUrl.searchParams.get("username");
  if (!username || !username.trim()) return err("Missing username", 400);

  const target = await db.user.findUnique({
    where: { username: username.trim().toLowerCase() },
  });
  if (!target) return ERR.notFound();

  await db.block.deleteMany({ where: { blockerId: user.id, blockedId: target.id } });

  return ok({ ok: true });
});
