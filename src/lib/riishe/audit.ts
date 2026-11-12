import { db } from "@/lib/db";

/**
 * Append-only audit trail entry for RIISHE automation actions. Same shape as
 * the platform's existing audit writes (actor, action, target, meta) — never
 * throws: an audit failure must not fail the automation step it documents.
 */
export async function auditEvent(
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
