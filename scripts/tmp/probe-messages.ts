import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
declare global { var __laxiiP3Auth: { armed: boolean; userId: string | null } | undefined; }
globalThis.__laxiiP3Auth = { armed: true, userId: null };
const { db } = await import("@/lib/db");
const suffix = randomUUID().slice(0, 8);
const u = await db.user.create({ data: { email: `qa-probe-msg-${suffix}@beanfolio.test`, passwordHash: "scrypt$fake$hash$for$qa", name: "QA Probe", username: `qa-probe-msg-${suffix}`, aiConsent: true } });
globalThis.__laxiiP3Auth!.userId = u.id;
const { POST: conversationsRoute } = await import("@/app/api/laxii/conversations/route");
const { POST: messagesRoute } = await import("@/app/api/laxii/conversations/[id]/messages/route");
const req = (p: string, init?: any) => new NextRequest(`http://localhost:3000${p}`, { method: init?.method ?? "GET", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.1.${Math.floor(Math.random()*254)}` }, ...(init?.json !== undefined ? { body: JSON.stringify(init.json) } : {}) });
const conv = await conversationsRoute(req("/api/laxii/conversations", { method: "POST", json: {} }));
const body = await conv.json();
console.log("conv:", conv.status, body?.conversation?.id);
const r = await messagesRoute(req(`/api/laxii/conversations/${body.conversation.id}/messages`, { method: "POST", json: { text: "x".repeat(16000), operation: "GENERATE" } }));
console.log("messages:", r.status, JSON.stringify(await r.json()).slice(0, 500));
await db.user.deleteMany({ where: { id: u.id } });
process.exit(0);
