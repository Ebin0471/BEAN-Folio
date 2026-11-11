import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const d = await db.siteDesign.findFirst({ include: { user: { select: { username: true } } } })
  console.log(d ? `${d.user.username}: status=${d.status} published=${!!d.publishedConfig}` : "none")
}
main().finally(() => db.$disconnect())
