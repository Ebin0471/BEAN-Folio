/**
 * BEAN Folio — production PostgreSQL connection probe (read-only, secret-safe).
 *
 * Purpose
 *   Verifies that the DATABASE_URL credentials are accepted by the real
 *   PostgreSQL server and that the BEAN Folio schema exists there — WITHOUT
 *   ever printing, logging or deriving any secret (the password and the full
 *   connection string are redacted from every output, including error text).
 *
 *   It distinguishes the two failure stages that look identical in Vercel logs:
 *     Stage 1 — credentials rejected (Prisma P1000 "…credentials for postgres
 *               are not valid") → fix the DATABASE_URL value in Vercel.
 *     Stage 2 — connection works but the 27 tables were never created → apply
 *               the schema (docs/deployment.md §0.4).
 *
 * Usage (run from a repo checkout, on your own machine — never from Vercel):
 *   DATABASE_URL="postgresql://…" bun scripts/check-postgres-connection.ts
 *
 * Read-only guarantee: the only statements executed are SELECT / to_regclass /
 * information_schema lookups. Nothing is written, migrated, created or dropped.
 *
 * Exit codes
 *   0  connected AND all six core BEAN Folio tables present
 *   1  connected, but BEAN Folio tables are missing/incomplete (apply schema)
 *   2  configuration problem (DATABASE_URL missing / not postgresql:// / unparsable)
 *   3  network failure (DNS / TCP / TLS — the server was not reachable)
 *   4  authentication failure (server REACHED, credentials REJECTED — P1000 class)
 *   5  unexpected error
 */

import { SQL } from "bun";

/** Core tables that must exist for the app to boot. (Prisma quotes model
 *  names, so the PostgreSQL identifiers are case-sensitive with capitals.) */
const CORE_TABLES = [
  '"User"',
  '"Session"',
  '"Project"',
  '"Profession"',
  '"MediaAsset"',
  '"SiteDesign"',
] as const;

const AUTH_CODES = new Set(["28P01", "28000", "28P86"]);
const NETWORK_CODES = new Set(["08000", "08001", "08003", "08004", "08006"]);
const AUTH_MESSAGE =
  /password authentication failed|authentication failed|role .* does not exist|no pg_hba entry for/i;
const NETWORK_MESSAGE =
  /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|connect(?:ion)? refused|connect(?:ion)? timed out|Connection terminated|ERR_POSTGRES_CONNECTION_CLOSED|Connection closed/i;

function fail(code: number, lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(code);
}

// ---------- 1. Configuration checks (no network) ----------

const raw = process.env.DATABASE_URL ?? "";
if (!raw.trim()) {
  fail(2, [
    "✗ CONFIGURATION PROBLEM",
    "  DATABASE_URL is not set.",
    "  Run it with the REAL production PostgreSQL URL, e.g.:",
    '    DATABASE_URL="postgresql://…" bun scripts/check-postgres-connection.ts',
    "  (The local sandbox default is SQLite — file:… — which this probe does not test.)",
  ]);
}

let parsed: URL;
try {
  parsed = new URL(raw);
} catch {
  fail(2, [
    "✗ CONFIGURATION PROBLEM",
    "  DATABASE_URL could not be parsed as a URL.",
    "  Expected shape: postgresql://user:password@host:5432/database?sslmode=require",
    "  (the value is never printed by this probe)",
  ]);
}

if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
  fail(2, [
    "✗ CONFIGURATION PROBLEM",
    `  DATABASE_URL is not a PostgreSQL URL (protocol "${parsed.protocol}").`,
    "  Production BEAN Folio builds connect with the PostgreSQL Prisma connector",
    "  (prisma/schema.postgres.prisma via the vercel-build script).",
  ]);
}

if (!parsed.hostname) {
  fail(2, ["✗ CONFIGURATION PROBLEM", "  DATABASE_URL has no host part (nothing to connect to)."]);
}

// Secrets we must never emit — scrubbed from every message before printing.
const secrets = new Set<string>();
for (const candidate of [raw, parsed.password, (() => {
  try { return decodeURIComponent(parsed.password); } catch { return ""; }
})(), (() => {
  try { return encodeURIComponent(parsed.password); } catch { return "";
}})()]) {
  if (candidate) secrets.add(candidate);
}
function scrub(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("<redacted>");
  return out;
}

// Non-secret diagnostics: host, port, database, username. These identify the
// target (and expose user/host mismatches) but cannot authenticate anyone.
const host = parsed.hostname;
const port = parsed.port || "5432";
const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "(none)";
const user = decodeURIComponent(parsed.username) || "(none)";
const sslmode = parsed.searchParams.get("sslmode") ?? "(driver default)";

console.log("BEAN Folio — PostgreSQL connection probe (read-only)");
console.log(`  target host: ${host}:${port}`);
console.log(`  database:    ${database}`);
console.log(`  user:        ${user}`);
console.log(`  sslmode:     ${sslmode}`);
console.log("");

// ---------- 2. Connection attempt ----------

let sql: InstanceType<typeof SQL>;
try {
  sql = new SQL(raw);
} catch (e) {
  fail(2, ["✗ CONFIGURATION PROBLEM", "  The driver rejected the DATABASE_URL before connecting:", `  ${scrub(e instanceof Error ? e.message : String(e))}`]);
}

const timer = setTimeout(() => {
  console.error("  (no response within 15s — treating as a network failure)");
  try { sql.close(); } catch { try { sql.end(); } catch { /* already closed */ } }
  fail(3, [
    "✗ NETWORK FAILURE — the PostgreSQL server did not respond in time",
    `  host: ${host}:${port}`,
    "  The TCP connection neither succeeded nor was actively refused within 15s.",
    "  Check: the host/port in the connection string, provider status page,",
    "  firewall/security rules (server-side allow-lists), and whether the",
    "  database project is paused/suspended in your provider's dashboard.",
  ]);
}, 15_000);

async function run(): Promise<never> {
  try {
    // --- Stage 1: authenticate (server identity echo, read-only) ---
    const who = (await sql`select current_user as user_name, current_database() as db_name`) as unknown as Array<{ user_name: string; db_name: string }>;
    const serverUser = who?.[0]?.user_name ?? "(unknown)";
    const serverDb = who?.[0]?.db_name ?? "(unknown)";
    clearTimeout(timer);

    console.log("✓ Connected — credentials accepted by the server");
    console.log(`  server-verified user:     ${serverUser}`);
    console.log(`  server-verified database: ${serverDb}`);
    if (serverDb !== database) {
      console.log("  NOTE: the database you connected to differs from the one named in");
      console.log("  DATABASE_URL — check the path part of the connection string.");
    }
    console.log("");

    // --- Stage 2: schema presence (information_schema, read-only) ---
    const countRows = (await sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`) as unknown as Array<{ n: number }>;
    const publicTables = countRows?.[0]?.n ?? 0;

    const regExprs = CORE_TABLES.map((t) => `to_regclass('public.${t}') is not null as ${t.replace(/"/g, "")}`).join(", ");
    const presentRows = (await sql.unsafe(`select ${regExprs}`)) as unknown as Array<Record<string, boolean>>;
    const flags = presentRows?.[0] ?? {};
    const present = CORE_TABLES.map((t) => t.replace(/"/g, "")).filter((t) => flags[t] === true);
    const missing = CORE_TABLES.map((t) => t.replace(/"/g, "")).filter((t) => flags[t] !== true);

    console.log(`  public-schema tables on this server: ${publicTables}`);
    console.log(`  BEAN Folio core tables: ${present.length}/${CORE_TABLES.length} present${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);

    if (present.length === CORE_TABLES.length) {
      console.log("");
      console.log("  Database is READY: credentials valid and schema present.");
      console.log("  Next: exercise the deployed app (curl https://<your-domain>/api/professions");
      console.log("  — /api/health does NOT touch the database, /api/professions does).");
      process.exit(0);
    }

    console.log("");
    console.log("✗ SCHEMA NOT APPLIED — the connection works, but the BEAN Folio tables are missing.");
    console.log("  This is Stage 2: create the tables on the (empty) production database, non-destructively:");
    console.log("    Option A (documented runbook, empty DB only):");
    console.log("      DATABASE_URL=\"postgresql://…\" bunx prisma db push --schema prisma/schema.postgres.prisma");
    console.log("    Option B (deterministic DDL, no db push):");
    console.log("      bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.postgres.prisma --script > /tmp/beanfolio_schema.sql");
    console.log("      then run that SQL once against the database.");
    console.log("  NEVER run `prisma db push --accept-data-loss` (the db:push script) against a database");
    console.log("  that already contains accounts/portfolios. Full runbook: docs/deployment.md §0.4.");
    process.exit(1);
  } catch (e) {
    clearTimeout(timer);
    const err = e as { code?: string; errno?: string; message?: string; cause?: { code?: string } };
    const code = err.code ?? err.cause?.code ?? err.errno ?? "";
    const message = scrub(err.message ?? String(e));

    // Bun (verified on 1.3.14) surfaces a server ErrorResponse as PostgresError
    // with code ERR_POSTGRES_SERVER_ERROR and an EMPTY message — the SQLSTATE
    // and the server's text are not exposed. In this probe that error can only
    // happen on the first read-only query, i.e. the server was reached (DNS,
    // TCP, TLS fine) but refused the session — the Prisma P1000 class.
    if (code === "ERR_POSTGRES_SERVER_ERROR") {
      fail(4, [
        "✗ SERVER REJECTED THE SESSION — credentials not accepted (Prisma error class P1000).",
        `  The PostgreSQL server at ${host}:${port} WAS reached (DNS, TCP and TLS are fine),`,
        "  but it refused the authentication/session. (Note: this Bun version does not",
        "  surface the server's own error text, e.g. \"password authentication failed for",
        "  user …\" — the SQLSTATE is not exposed either.)",
        "",
        "  Fix — copy the CURRENT connection string from your provider's dashboard and update",
        "  Vercel → Project → Settings → Environment Variables → DATABASE_URL (Production +",
        "  Preview) → Save → Redeploy (env changes only apply to NEW deployments).",
        "",
        "  Most common concrete causes:",
        "   • the database password was reset/rotated after the env var was saved;",
        "   • Supabase (or similar): a POOLED host used with the DIRECT username — pooled",
        `     connections need user "postgres.<project-ref>", direct ones need "postgres";`,
        "   • the URL was typed by hand instead of copied (placeholder password never replaced);",
        "   • special characters in the password not percent-encoded (e.g. @ → %40, : → %3A, / → %2F);",
        "   • a trailing space/newline captured when pasting the value into Vercel;",
        "   • parts of two different databases mixed (host from one store, credentials from another).",
        "",
        "  This probe never prints your password or connection string.",
        "  Full runbook: docs/deployment.md §0.4.",
      ]);
    }

    if (AUTH_CODES.has(code) || AUTH_MESSAGE.test(message)) {
      fail(4, [
        "✗ AUTHENTICATION FAILED — the server REJECTED these credentials (Prisma error class P1000).",
        `  The server at ${host}:${port} WAS reached (DNS, TCP and TLS are fine) — it simply says`,
        `  the user/password pair is not valid. Server said: ${message}${code ? ` (code ${code})` : ""}`,
        "",
        "  Fix — copy the CURRENT connection string from your provider's dashboard and update",
        "  Vercel → Project → Settings → Environment Variables → DATABASE_URL (Production +",
        "  Preview) → Save → Redeploy (env changes only apply to NEW deployments).",
        "",
        "  Most common concrete causes:",
        "   • the database password was reset/rotated after the env var was saved;",
        "   • Supabase (or similar): a POOLED host used with the DIRECT username — pooled",
        `     connections need user "postgres.<project-ref>", direct ones need "postgres";`,
        "   • the URL was typed by hand instead of copied (placeholder password never replaced);",
        "   • special characters in the password not percent-encoded (e.g. @ → %40, : → %3A, / → %2F);",
        "   • a trailing space/newline captured when pasting the value into Vercel;",
        "   • parts of two different databases mixed (host from one store, credentials from another).",
        "",
        "  This probe never prints your password or connection string.",
        "  Full runbook: docs/deployment.md §0.4.",
      ]);
    }

    if (NETWORK_CODES.has(code) || NETWORK_MESSAGE.test(message)) {
      fail(3, [
        "✗ NETWORK FAILURE — the PostgreSQL server was not reachable.",
        `  host: ${host}:${port}${code ? ` (${code})` : ""} — server said: ${message}`,
        "  Check: host/port spelling, provider status, firewall/security-rules allow-lists,",
        "  and whether the database project is paused (some providers pause free projects).",
      ]);
    }

    fail(5, [
      "✗ UNEXPECTED ERROR while connecting or querying (redacted):",
      `  ${message}${code ? ` (code ${code})` : ""}`,
      "  Please report this output (passwords are redacted) together with your provider name.",
    ]);
  }
}

run();
