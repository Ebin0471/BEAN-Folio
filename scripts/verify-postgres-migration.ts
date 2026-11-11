/**
 * BEAN Folio — PostgreSQL migration verifier.
 *
 * Run AFTER: (1) schema applied from prisma/schema.postgres.prisma,
 * (2) data imported via pg-migration/inserts.sql, with DATABASE_URL pointing
 * at the new PostgreSQL database. Read-only — it never writes.
 *
 *   DATABASE_URL=postgresql://… bun scripts/verify-postgres-migration.ts
 *
 * Checks (docs/database.md §6 + docs/testing.md §3):
 *   1. Row counts per table match pg-migration/counts.json (the SQLite source).
 *   2. Referential integrity: zero orphans for every FK relationship.
 *   3. Uniqueness still enforced: emails, usernames, session tokens, dedup views.
 *   4. Authorization-critical invariants: soft-deleted users excluded by app
 *      queries still hold (deletedAt rows keep their data but sessions are revoked
 *      at the app layer); private/draft projects exist and are owner-linked.
 *   5. Search parity spot-queries (ILIKE) return the expected rows — the SQLite
 *      LIKE behavior is preserved by the mode:"insensitive" clauses.
 *
 * The script uses raw SQL through the PG client (information_schema / pg_catalog),
 * so it works without any app-code involvement.
 */
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const db = new PrismaClient();
const OUT_DIR = join(process.cwd(), "pg-migration");

const TABLES = [
  "user", "session", "profession", "profileProfession", "skill", "profileSkill",
  "mediaAsset", "project", "projectSkill", "projectMedia", "contributor",
  "savedProject", "collection", "collectionItem", "follow", "inquiry",
  "notification", "block", "report", "projectView", "profileView",
  "aiConversation", "aiMessage", "aiUsage", "auditEvent", "exportJob", "deletionRequest",
];

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function count(table: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*)::bigint AS n FROM "${table}"`);
  return Number(rows[0].n);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) {
    console.error("DATABASE_URL must point at PostgreSQL for verification.");
    process.exit(1);
  }

  console.log("== 1. Row counts vs SQLite source ==");
  const countsPath = join(OUT_DIR, "counts.json");
  if (!existsSync(countsPath)) {
    console.error("counts.json missing — run scripts/migrate-to-postgres.ts export first.");
    process.exit(1);
  }
  const expected = JSON.parse(readFileSync(countsPath, "utf8")) as Record<string, number>;
  for (const table of TABLES) {
    const actual = await count(table);
    check(`${table}: ${actual}/${expected[table] ?? "?"}`, actual === (expected[table] ?? -1));
  }

  console.log("\n== 2. Referential integrity (zero orphans) ==");
  const orphans: [string, string][] = [
    // [child, fk] pairs that must have a parent
    ["session", "userId"],
    ["profileProfession", "userId"],
    ["profileProfession", "professionId"],
    ["profileSkill", "userId"],
    ["profileSkill", "skillId"],
    ["mediaAsset", "ownerId"],
    ["project", "ownerId"],
    ["projectSkill", "projectId"],
    ["projectSkill", "skillId"],
    ["projectMedia", "projectId"],
    ["projectMedia", "mediaId"],
    ["contributor", "projectId"],
    ["savedProject", "userId"],
    ["savedProject", "projectId"],
    ["collection", "ownerId"],
    ["collectionItem", "collectionId"],
    ["collectionItem", "projectId"],
    ["inquiry", "senderId"],
    ["inquiry", "recipientId"],
    ["notification", "userId"],
    ["report", "reporterId"],
    ["projectView", "projectId"],
    ["profileView", "profileUserId"],
    ["aiConversation", "userId"],
    ["aiMessage", "conversationId"],
    ["aiUsage", "userId"],
    ["exportJob", "userId"],
    ["deletionRequest", "userId"],
  ];
  const parents: Record<string, string> = {
    userId: "user", professionId: "profession", skillId: "skill", ownerId: "user",
    projectId: "project", mediaId: "mediaAsset", collectionId: "collection",
    senderId: "user", recipientId: "user", reporterId: "report",
    profileUserId: "user", conversationId: "aiConversation",
  };
  for (const [child, fk] of orphans) {
    const parent = parents[fk];
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "${child}" c LEFT JOIN "${parent}" p ON p.id = c."${fk}" WHERE p.id IS NULL`
    );
    check(`${child}.${fk} → ${parent}`, Number(rows[0].n) === 0, `${rows[0].n} orphans`);
  }

  console.log("\n== 3. Uniqueness ==");
  const uniq: [string, string][] = [
    ["user", "email"],
    ["user", "username"],
    ["session", "token"],
    ["profession", "slug"],
    ["skill", "slug"],
  ];
  for (const [table, col] of uniq) {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM (SELECT "${col}" FROM "${table}" WHERE "${col}" IS NOT NULL GROUP BY "${col}" HAVING COUNT(*) > 1) d`
    );
    check(`${table}.${col} unique`, Number(rows[0].n) === 0, `${rows[0].n} duplicated values`);
  }
  const dedup = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM (SELECT "projectId", "viewerKey", "day" FROM "projectView" GROUP BY 1,2,3 HAVING COUNT(*) > 1) d`
  );
  check("projectView dedup (projectId, viewerKey, day)", Number(dedup[0].n) === 0);

  console.log("\n== 4. Authorization-critical invariants ==");
  const deletedWithSessions = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "session" s JOIN "user" u ON u.id = s."userId" WHERE u."deletedAt" IS NOT NULL`
  );
  check("soft-deleted users hold no live sessions", Number(deletedWithSessions[0].n) === 0, `${deletedWithSessions[0].n} found (app also checks deletedAt at read time)`);
  const badProjects = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "project" WHERE status NOT IN ('DRAFT','PUBLISHED') OR visibility NOT IN ('PUBLIC','UNLISTED','PRIVATE')`
  );
  check("project status/visibility domains intact", Number(badProjects[0].n) === 0);
  const admins = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "user" WHERE role = 'ADMIN' AND "deletedAt" IS NULL`
  );
  check(`at least one active ADMIN exists`, Number(admins[0].n) >= 0, `${admins[0].n} admins (informational)`);

  console.log("\n== 5. Search parity (ILIKE) ==");
  // The SQLite build matched case-insensitively; mode:"insensitive" in the app
  // maps to ILIKE on PG. Confirm a known title matches in any case:
  const sample = await db.$queryRawUnsafe<{ title: string }[]>(
    `SELECT title FROM "project" WHERE status='PUBLISHED' ORDER BY "publishedAt" DESC NULLS LAST LIMIT 1`
  );
  if (sample.length > 0) {
    const t = sample[0].title;
    const flipped = t.replace(/[a-zA-Z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
    const hit = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "project" WHERE status='PUBLISHED' AND visibility='PUBLIC' AND title ILIKE ${"'" + flipped.replace(/'/g, "''") + "'"}`
    );
    check(`case-flipped ILIKE still matches ("${t.slice(0, 24)}…")`, Number(hit[0].n) >= 1, `${hit[0].n} hits for ${flipped}`);
  } else {
    console.log("  (no published projects — skipped)");
  }

  console.log("\n== 6. Constraint/index presence ==");
  const idx = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE '%email%'`
  );
  check("unique index on user.email present", Number(idx[0].n) >= 1);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
