/**
 * Promote an existing account to ADMIN (or demote back to USER).
 *
 * Usage:
 *   bun scripts/set-admin.ts admin@example.com          # promote
 *   bun scripts/set-admin.ts admin@example.com --revoke # demote
 *
 * The email must belong to an existing, non-deleted account — the script never
 * creates accounts and never prints or modifies password material.
 * Every change is written to the audit trail (action: "admin.role.change").
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const [email, revokeFlag] = process.argv.slice(2);
  if (!email) {
    console.error("Usage: bun scripts/set-admin.ts <email> [--revoke]");
    process.exit(1);
  }
  const nextRole = revokeFlag === "--revoke" ? "USER" : "ADMIN";

  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user || user.deletedAt) {
    console.error(`No active account found for ${email}`);
    process.exit(1);
  }

  if (user.role === nextRole) {
    console.log(`${email} already has role ${nextRole} — no change.`);
    return;
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { role: nextRole } }),
    prisma.auditEvent.create({
      data: {
        actorUserId: user.id,
        action: "admin.role.change",
        targetType: "USER",
        targetId: user.id,
        meta: JSON.stringify({ from: user.role, to: nextRole, via: "scripts/set-admin.ts" }),
      },
    }),
  ]);

  console.log(`Done. ${email} role: ${user.role} -> ${nextRole}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
