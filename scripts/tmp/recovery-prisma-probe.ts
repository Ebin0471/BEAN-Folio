import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
try {
  console.log("professions:", await db.profession.count());
  console.log("users:", await db.user.count());
  console.log("families:", await db.professionFamily.count());
} catch (e) { console.error("PRISMA ERR:", e instanceof Error ? e.message : e); }
await db.$disconnect();
