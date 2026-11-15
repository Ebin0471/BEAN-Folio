/**
 * BEAN FOLIO — seed & fixture safety guard (M0.5 Stage D).
 *
 * Shared gate for every script that writes demo/QA fixture data. It exists
 * so that fixture seeding can never ACCIDENTALLY touch a production system,
 * per the M0.5 seed-discipline requirements:
 *
 *   1. Demo/QA seeding refuses to run against a production context.
 *   2. Destructive fixture operations (--clear) require an additional,
 *      explicit confirmation env var.
 *   3. The operator always sees WHICH database they are about to write.
 *
 * Production context means: NODE_ENV === "production", OR a PostgreSQL
 * DATABASE_URL (the production engine for this app), OR an unrecognized
 * DATABASE_URL (fail closed on unknown targets).
 *
 * Escape hatch: setting BEAN_SEED_ALLOW_NONISOLATED=1 disables the refusal
 * for deliberate, owner-supervised operations. The override is printed
 * loudly and recorded in the output so it can never happen silently.
 */

interface GuardTarget {
  /** Script name for log lines, e.g. "scripts/seed.ts". */
  script: string;
  /** Destructive mode (e.g. seed.ts --clear) — requires BEAN_SEED_CONFIRM_CLEAR=1. */
  destructive?: boolean;
}

interface GuardReport {
  engine: "sqlite" | "postgresql" | "unknown";
  target: string;
  nodeEnv: string;
  overridden: boolean;
}

function describeTarget(url: string): { engine: "sqlite" | "postgresql" | "unknown"; target: string } {
  if (url.startsWith("file:")) {
    // Redact query params, keep only the file name — never print connection material.
    const p = url.slice("file:".length).split("?")[0];
    const parts = p.split("/");
    return { engine: "sqlite", target: parts[parts.length - 1] || p };
  }
  if (url.startsWith("postgres")) {
    // Never print the connection string — only the engine.
    return { engine: "postgresql", target: "(postgresql connection string withheld)" };
  }
  return { engine: "unknown", target: url ? "(unrecognized DATABASE_URL withheld)" : "(DATABASE_URL not set)" };
}

export function assertSeedSafety(target: GuardTarget): GuardReport {
  const url = process.env.DATABASE_URL ?? "";
  const { engine, target: targetDesc } = describeTarget(url);
  const nodeEnv = process.env.NODE_ENV ?? "";
  const overridden = process.env.BEAN_SEED_ALLOW_NONISOLATED === "1";

  const isProduction =
    nodeEnv === "production" || engine === "postgresql" || engine === "unknown";

  // An isolated context: a sqlite DATABASE_URL in a non-production env —
  // the sandbox dev DB (custom.db) or any CI/test temp DB.
  const isolated = engine === "sqlite" && !isProduction;

  console.log(`[seed-guard] ${target.script}`);
  console.log(`[seed-guard]   NODE_ENV=${nodeEnv || "(unset)"}  engine=${engine}  db=${targetDesc}`);

  if (overridden) {
    console.warn(
      `[seed-guard]   OVERRIDE ACTIVE: BEAN_SEED_ALLOW_NONISOLATED=1 — proceeding deliberately (recorded).`,
    );
  }

  if (isProduction && !overridden) {
    console.error(
      `[seed-guard] REFUSED: ${target.script} writes demo/QA fixture data and this looks like a PRODUCTION context ` +
        `(NODE_ENV=${nodeEnv || "(unset)"}, engine=${engine}).\n` +
        `  Demo seeding must never touch production. If this is a deliberate, owner-supervised operation, ` +
        `re-run with BEAN_SEED_ALLOW_NONISOLATED=1.`,
    );
    process.exit(2);
  }

  if (target.destructive && !isolated && !overridden) {
    console.error(
      `[seed-guard] REFUSED: destructive fixture operation (--clear) requires an isolated/test context ` +
        `(a non-production sqlite DATABASE_URL, e.g. a CI temp DB).\n` +
        `  Current context: NODE_ENV=${nodeEnv || "(unset)"} engine=${engine} db=${targetDesc}.\n` +
        `  For the sandbox dev DB this is deliberate-only: re-run with BEAN_SEED_ALLOW_NONISOLATED=1 ` +
        `to acknowledge clearing fixture (isDemo) rows there.`,
    );
    process.exit(2);
  }

  if (target.destructive && process.env.BEAN_SEED_CONFIRM_CLEAR !== "1" && !overridden) {
    console.error(
      `[seed-guard] REFUSED: --clear deletes every isDemo fixture account and its content. ` +
        `Re-run with BEAN_SEED_CONFIRM_CLEAR=1 to confirm.`,
    );
    process.exit(2);
  }

  return { engine, target: targetDesc, nodeEnv, overridden };
}
