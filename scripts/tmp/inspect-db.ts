import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const users: any[] = await db.$queryRawUnsafe('SELECT * FROM User LIMIT 3')
  console.log('User row keys:', users.length ? Object.keys(users[0]).join(', ') : 'none')
  console.log('User rows:', JSON.stringify(users, (_k, v) => typeof v === 'bigint' ? Number(v) : v))
  const tables: any[] = await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  const counts: string[] = []
  for (const t of tables) {
    if (t.name.startsWith('_') || t.name.startsWith('sqlite_')) continue
    try {
      const c: any[] = await db.$queryRawUnsafe(`SELECT COUNT(*) as c FROM "${t.name}"`)
      const n = Number(c[0].c)
      if (n > 0) counts.push(`${t.name}=${n}`)
    } catch {}
  }
  console.log('Non-empty tables:', counts.join(', ') || 'NONE')
}
main().finally(() => db.$disconnect())
