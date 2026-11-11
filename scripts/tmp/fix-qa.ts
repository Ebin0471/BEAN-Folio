import { db } from "../../src/lib/db";
const qaEmails = ["trace-tester@beanfolio.test", "navfree@beanfolio.test", "admin@beanfolio.test", "journey@beanfolio.test", "nova.testwright@example.com", "milo.testwright@example.com", "qa-live-1026@example.com", "qa-live2-1026@example.com", "bean-e2e@beanfolio.app", "pub-e2e-1027@beanfolio.test"];
const rows = await db.user.findMany({ where: { email: { in: qaEmails } }, select: { email: true, isDemo: true } });
for (const r of rows) {
  if (!r.isDemo) {
    const u = await db.user.update({ where: { email: r.email }, data: { isDemo: true } });
    console.log("FIXED", r.email, "-> isDemo:", u.isDemo);
  } else {
    console.log("ok   ", r.email);
  }
}
console.log("checked", rows.length, "of", qaEmails.length);
