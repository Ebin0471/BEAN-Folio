import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const designs = await db.siteDesign.findMany({ select: { userId: true, status: true } })
  console.log('siteDesigns:', designs.length, JSON.stringify(designs.slice(0, 5)))
  const users = await db.user.findMany({ select: { username: true }, take: 12 })
  console.log('usernames:', users.map(u => u.username).join(', '))
}
main().finally(() => db.$disconnect())
