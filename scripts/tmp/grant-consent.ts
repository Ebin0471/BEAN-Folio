import { db } from "../../src/lib/db";
async function main() {
  const u = await db.user.update({ where: { email: "demo@beanfolio.app" }, data: { aiConsent: true }, select: { id: true, aiConsent: true } });
  console.log("demo aiConsent:", u.aiConsent);
  await db.$disconnect();
}
main();
