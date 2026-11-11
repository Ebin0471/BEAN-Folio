import { db } from "../src/lib/db";

const task = await db.agentTask.findUnique({
  where: { id: "cmw07zvs10013r8qfpql9ppsi" },
  select: { id: true, status: true, resultJson: true },
});
console.log("task status:", task?.status);
const r = task?.resultJson ? JSON.parse(task.resultJson) : null;
console.log("resultJson keys:", Object.keys(r ?? {}));

// find the AiConversation that references this task
const msgs = await db.aiMessage.findMany({
  where: { content: { contains: "cmw07zvs10013r8qfpql9ppsi" } },
  orderBy: { createdAt: "asc" },
  take: 5,
  select: { id: true, role: true, conversationId: true, createdAt: true, content: true },
});
console.log("=== AiMessages referencing task:", msgs.length);
for (const m of msgs) {
  console.log("-", m.role, m.conversationId, m.createdAt.toISOString(), "| content head:", m.content.slice(0, 120).replace(/\n/g, " "));
}
if (msgs[0]) {
  const conv = await db.aiConversation.findUnique({ where: { id: msgs[0].conversationId }, select: { title: true, createdAt: true } });
  console.log("conversation:", conv?.title, conv?.createdAt.toISOString());
  const all = await db.aiMessage.count({ where: { conversationId: msgs[0].conversationId } });
  console.log("messages in conversation:", all);
}
await db.$disconnect();
