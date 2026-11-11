import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const q = async (sql: string, label: string) => {
    const rows: any[] = await db.$queryRawUnsafe(sql)
    console.log(label, Number(rows[0]?.c ?? -1))
  }
  await q('SELECT COUNT(*) as c FROM SiteStudioSession', 'SiteStudioSession:')
  await q('SELECT COUNT(*) as c FROM SiteStudioMessage', 'SiteStudioMessage:')
  await q('SELECT COUNT(*) as c FROM SiteDesign', 'SiteDesign:')
  await q('SELECT COUNT(*) as c FROM AgentTask', 'AgentTask:')
  await q('SELECT COUNT(*) as c FROM User', 'User:')
  await q('SELECT COUNT(*) as c FROM AiConversation', 'AiConversation:')
  await q('SELECT COUNT(*) as c FROM Project', 'Project:')
  await q('SELECT COUNT(*) as c FROM MediaAsset', 'MediaAsset:')
}
main().finally(() => db.$disconnect())
