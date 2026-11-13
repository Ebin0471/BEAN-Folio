import { db } from "../../src/lib/db";
async function main() {
  const users = await db.user.findMany({ select: { id: true, email: true, isDemo: true, deletedAt: true } });
  console.log("total users:", users.length);
  console.log(users.slice(0, 10));
  const repos = await db.giftzRepository.count();
  const media = await db.mediaAsset.count();
  console.log("giftz repos:", repos, "· media:", media);
  await db.$disconnect();
}
main();
