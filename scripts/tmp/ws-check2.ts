import { db } from "../../src/lib/db";
import { runGit, workspaceDir } from "../../src/lib/giftz/workspace";
import { existsSync, readdirSync } from "fs";
import path from "path";
async function main() {
  const repo = await db.giftzRepository.findFirst({ select: { id: true } });
  const dir = workspaceDir(repo.id);
  console.log("ws exists:", existsSync(dir), "· .git:", existsSync(path.join(dir, ".git")));
  const gitRes = await runGit(repo.id, ["status"]);
  console.log("git status full:", gitRes.stdout.trim().slice(0, 200), "| stderr:", gitRes.stderr.trim().slice(0, 200));
  const files = readdirSync(path.join(dir, "assets"), { recursive: false });
  console.log("assets/:", files.join(","));
  await db.$disconnect();
}
main();
