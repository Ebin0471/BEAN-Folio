import { db } from "../../src/lib/db";
import { readWorkspaceFile } from "../../src/lib/giftz/workspace";
async function main() {
  const repo = await db.giftzRepository.findFirst({ select: { id: true } });
  const t = await readWorkspaceFile(repo.id, "tests/ledger.test.ts");
  console.log(t.content.split("\n").slice(8, 18).join("\n"));
  const s = await readWorkspaceFile(repo.id, "src/lib/ledger.ts");
  console.log("=== ledger sumAmounts:"); console.log(s.content.split("\n").slice(4, 12).join("\n"));
  await db.$disconnect();
}
main();
