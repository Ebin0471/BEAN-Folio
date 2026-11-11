// Direct route invocation to surface the real exception
let cookieToken: string | undefined;
;(globalThis as any).__cookieToken = () => cookieToken
import { mock } from "bun:test"
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookieToken && name === "bean_session" ? { name, value: cookieToken } : undefined,
    set: () => undefined,
  }),
}))
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { createSession, hashPassword } from "@/lib/auth"
import { POST as archiveRoute } from "@/app/api/projects/[id]/archive/route"

async function main() {
  const u = await db.user.create({ data: { email: `dbg-route-${Date.now()}@beanfolio.test`, name: "DBG", passwordHash: await hashPassword("x") } })
  const p = await db.project.create({ data: { ownerId: u.id, title: "DBG" } })
  cookieToken = await createSession(u.id)
  const req = new NextRequest(`http://localhost:3000/api/projects/${p.id}/archive`, { method: "POST", headers: { "x-forwarded-for": "198.51.100.1" } })
  try {
    const res = await archiveRoute(req, { params: Promise.resolve({ id: p.id }) })
    console.log("status:", res.status)
    console.log("body:", await res.text())
  } catch (e) {
    console.error("THREW:", e)
  }
  await db.project.delete({ where: { id: p.id } }).catch(() => {})
  await db.session.deleteMany({ where: { userId: u.id } }).catch(() => {})
  await db.user.delete({ where: { id: u.id } }).catch(() => {})
}
main()
