import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  // Create a throwaway user + project, then exercise the update directly
  const u = await db.user.create({ data: { email: `dbg-${Date.now()}@beanfolio.test`, name: "DBG", passwordHash: "x" } })
  const p = await db.project.create({ data: { ownerId: u.id, title: "DBG" } })
  const updated = await db.project.update({ where: { id: p.id }, data: { archivedAt: new Date() } })
  console.log("archivedAt:", updated.archivedAt)
  const dup = await db.$transaction(async (tx) => {
    return tx.project.create({ data: { ownerId: u.id, title: `${p.title} (copy)`, visibility: "PRIVATE", customFields: p.customFields, tools: p.tools } })
  })
  console.log("duplicate ok:", dup.id)
  await db.project.delete({ where: { id: dup.id } })
  await db.project.delete({ where: { id: p.id } })
  await db.user.delete({ where: { id: u.id } })
}
main().finally(() => db.$disconnect())
