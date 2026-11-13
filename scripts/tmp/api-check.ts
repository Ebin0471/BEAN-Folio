// Direct DB check of what the API would return
import { db } from "../../src/lib/db";
async function main() {
  const rows = await db.agentTask.findMany({ where: { kind: "ENGINEERING_TASK", agent: "CODE_GIFTZ" }, select: { id: true, status: true, kind: true, title: true } });
  console.log("ENGINEERING_TASK rows visible to listTasks:", rows.length);
  rows.forEach(r => console.log(" ", r.id, r.status, r.title.slice(0, 50)));
  await db.$disconnect();
}
main();
