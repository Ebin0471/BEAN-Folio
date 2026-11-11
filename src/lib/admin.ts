import { db } from "@/lib/db";
import type { User } from "@prisma/client";

/**
 * Server-side admin authorization.
 *
 * The client hides admin surfaces based on the session DTO's `role`, but that
 * is a convenience only — every /api/admin route MUST call requireAdmin() and
 * treat null as "deny". A missing/anonymous session and a non-ADMIN session
 * are deliberately indistinguishable in the response (403) so the existence
 * of the admin API is not advertised beyond what authentication already shows.
 */
export async function requireAdmin(): Promise<User | null> {
  const { getSessionUser } = await import("@/lib/auth");
  const user = await getSessionUser();
  if (!user) return null;
  if (user.role !== "ADMIN") return null;
  if (user.deletedAt) return null;
  return user;
}

/** Append-only audit trail entry for a moderation action. */
export async function auditModeration(
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  meta: Record<string, unknown>
): Promise<void> {
  await db.auditEvent
    .create({
      data: {
        actorUserId,
        action,
        targetType,
        targetId,
        meta: JSON.stringify(meta),
      },
    })
    .catch(() => undefined);
}
