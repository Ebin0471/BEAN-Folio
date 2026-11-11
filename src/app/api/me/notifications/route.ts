import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";
import type { NotificationDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Parse the stored JSON payload defensively — never throw on malformed rows. */
function safePayload(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const [rows, unreadCount] = await Promise.all([
    db.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    db.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);

  const notifications: NotificationDTO[] = rows.map((n) => ({
    id: n.id,
    type: n.type,
    payload: safePayload(n.payload),
    readAt: n.readAt ? n.readAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  }));

  return ok({ notifications, unreadCount });
});
