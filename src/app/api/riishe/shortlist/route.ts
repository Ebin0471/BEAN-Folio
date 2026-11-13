import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { auditEvent } from "@/lib/riishe/audit";
import { publicProfileBaseFilter } from "@/lib/visibility";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  usernames: z.array(z.string().min(1).max(40)).min(1).max(10),
  reason: z.string().max(200).optional(),
});

/**
 * GET /api/riishe/shortlist — the owner's private creator shortlist.
 * personId is a loose reference (no FK), so person labels are resolved in a
 * second query — rows for deleted accounts keep their place with null labels.
 */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const rows = await db.riisheCreatorShortlist.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const persons = await db.user.findMany({
    where: { id: { in: rows.map((r) => r.personId) } },
    select: { id: true, username: true, name: true, headline: true },
  });
  const byId = new Map(persons.map((p) => [p.id, p]));
  return ok({
    items: rows.map((r) => {
      const p = byId.get(r.personId);
      return {
        id: r.id,
        personId: r.personId,
        username: p?.username ?? null,
        name: p?.name ?? null,
        headline: p?.headline ?? null,
        reason: r.reason,
        source: r.source,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  });
});

/**
 * POST /api/riishe/shortlist — shortlist visible, real accounts. Self,
 * blocked counterparties, demo fixtures and unknown usernames are refused
 * honestly (per-name result). Idempotent: re-adding returns the same list.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const r = await parseBody(req, createSchema);
  if (r.response) return r.response;

  const blocked = new Set(
    (
      await db.block.findMany({
        where: { OR: [{ blockerId: user.id }, { blockedId: user.id }] },
        select: { blockerId: true, blockedId: true },
      })
    ).flatMap((b) => [b.blockerId, b.blockedId])
  );

  const added: string[] = [];
  const refused: { username: string; reason: string }[] = [];
  for (const username of r.data.usernames) {
    const person = await db.user.findFirst({
      where: { username, onboarded: true, deletedAt: null, isDemo: false, ...publicProfileBaseFilter },
      select: { id: true },
    });
    if (!person) {
      refused.push({ username, reason: "no visible account with that username" });
      continue;
    }
    if (person.id === user.id) {
      refused.push({ username, reason: "that is you" });
      continue;
    }
    if (blocked.has(person.id)) {
      refused.push({ username, reason: "blocked accounts cannot be shortlisted" });
      continue;
    }
    await db.riisheCreatorShortlist.upsert({
      where: { userId_personId: { userId: user.id, personId: person.id } },
      create: {
        userId: user.id,
        personId: person.id,
        reason: r.data.reason ?? null,
        source: "manual",
      },
      update: { reason: r.data.reason ?? undefined },
    });
    added.push(username);
  }
  if (added.length > 0) {
    await auditEvent(user.id, "riishe.shortlist.updated", "RiisheCreatorShortlist", user.id, {
      added,
      source: "manual",
    });
  }
  return ok({ added, refused });
});

/**
 * DELETE /api/riishe/shortlist — remove one entry by id (owner-scoped) or
 * clear the whole shortlist with { all: true }.
 */
export const DELETE = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const res = await db.riisheCreatorShortlist.deleteMany({ where: { id, userId: user.id } });
    if (res.count === 0) return ERR.notFound();
    return ok({ removed: 1 });
  }
  const all = url.searchParams.get("all") === "true";
  if (!all) return err("Pass ?id=<shortlist id> or ?all=true", 400);
  const res = await db.riisheCreatorShortlist.deleteMany({ where: { userId: user.id } });
  await auditEvent(user.id, "riishe.shortlist.cleared", "RiisheCreatorShortlist", user.id, { removed: res.count });
  return ok({ removed: res.count });
});
