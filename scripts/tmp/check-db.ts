import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const cols = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("LaxiiMessage")`);
  console.log("LaxiiMessage columns:", cols.map((c) => c.name).join(", "));
  const cols2 = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info("AgentArtifact")`);
  console.log("AgentArtifact columns:", cols2.map((c) => c.name).join(", "));
}
main().finally(() => prisma.$disconnect());
