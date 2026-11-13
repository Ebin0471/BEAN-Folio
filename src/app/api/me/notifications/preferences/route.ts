import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR, parseBody } from "@/lib/api-helpers";
import { NOTIFICATION_TYPES } from "@/lib/notify";

export const dynamic = "force-dynamic";

const prefSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  enabled: z.boolean(),
}).strict();

/** GET — the user's per-type notification preferences (absent row = enabled). */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const rows = await db.notificationSetting.findMany({
    where: { userId: user.id },
    select: { type: true, enabled: true },
  });

  const preferences: Record<string, boolean> = {};
  for (const t of NOTIFICATION_TYPES) preferences[t] = true; // default on
  for (const r of rows) preferences[r.type] = r.enabled;

  return ok({ preferences });
});

/** PATCH — set one type's preference (upsert; absent row means enabled). */
export const PATCH = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const parsed = await parseBody(req, prefSchema);
  if (parsed.response) return parsed.response;
  const { type, enabled } = parsed.data;

  await db.notificationSetting.upsert({
    where: { userId_type: { userId: user.id, type } },
    create: { userId: user.id, type, enabled },
    update: { enabled },
  });

  return ok({ type, enabled });
});
