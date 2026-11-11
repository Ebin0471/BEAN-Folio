import { randomBytes, scrypt as _scrypt } from "crypto";
import { promisify } from "util";
import { db } from "../../src/lib/db";

const scrypt = promisify(_scrypt) as (p: string, s: string, k: number) => Promise<string>;
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

const QA_EMAILS = [
  "trace-tester@beanfolio.test", "navfree@beanfolio.test", "admin@beanfolio.test",
  "journey@beanfolio.test", "nova.testwright@example.com", "milo.testwright@example.com",
  "qa-live-1026@example.com", "qa-live2-1026@example.com", "bean-e2e@beanfolio.app",
  "pub-e2e-1027@beanfolio.test",
];

async function main() {
  let created = 0;
  for (const email of QA_EMAILS) {
    const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) continue;
    await db.user.create({
      data: {
        email,
        passwordHash: await hashPassword("qa-fixture-password"),
        name: "QA Fixture",
        isDemo: true,
      },
    });
    created += 1;
  }
  console.log(`QA fixture accounts ensured: ${created} created, ${QA_EMAILS.length} total`);
  await db.$disconnect();
}
main();
