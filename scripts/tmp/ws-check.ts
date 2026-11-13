import { db } from "../../src/lib/db";
import { readWorkspaceFile } from "../../src/lib/giftz/workspace";
import { runGit } from "../../src/lib/giftz/workspace";
async function main() {
  const repo = await db.giftzRepository.findFirst({ select: { id: true } });
  const idx = await readWorkspaceFile(repo.id, "src/index.ts");
  console.log("=== src/index.ts head:\n" + idx.content.split("\n").slice(0, 12).join("\n"));
  const log = await runGit(repo.id, ["log", "--oneline", "-3"]);
  console.log("=== git log:", log.stdout.trim());
  const st = await runGit(repo.id, ["status", "--short"]);
  console.log("=== git status:", st.stdout.trim() || "(clean)");
  await db.$disconnect();
}
main();
