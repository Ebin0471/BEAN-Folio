import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR, parseBody } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const readSchema = z.object({
  ids: z.array(z.string().min(1)).max(200).optional(),
});

export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const r = await parseBody(req, readSchema);
  if (r.response) return r.response;

  await db.notification.updateMany({
    where: {
      userId: user.id,
      ...(r.data.ids ? { id: { in: r.data.ids } } : {}),
    },
    data: { readAt: new Date() },
  });

  return ok({ ok: true });
});
