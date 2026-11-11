/**
 * BEAN Folio — production PostgreSQL SCHEMA READINESS probe (read-only, secret-safe).
 *
 * Companion to scripts/check-postgres-connection.ts. That probe answers two
 * questions (are the credentials accepted? do the 6 core tables exist?). This
 * probe answers the deployment-gating question the Task 29 schema re-sync
 * created: does the live database contain EVERY object the repaired
 * prisma/schema.postgres.prisma expects — all 38 tables (including the LAXII
 * AI-studio set), the 8 post-Task-26 User columns, the Project.coverMedia
 * foreign key, and every index/FK added with the SiteDesign / SiteMaterial /
 * SiteRevision / PasswordResetToken set and the LaxiiConversation /
 * LaxiiMessage / LaxiiImageVersion / LaxiiUsage / LaxiiResume set?
 *
 * Read-only guarantee: the ONLY statements executed are SELECTs against
 * information_schema and pg_catalog (plus current_user/current_database).
 * Nothing is written, created, altered, migrated or deleted. The additive SQL
 * plan printed at the end is TEXT ONLY — it is never executed here.
 *
 * Secret safety: the password and the full connection string are redacted
 * from every output line, including error text (same scrubbing approach as
 * scripts/check-postgres-connection.ts).
 *
 * Usage (from a repo checkout, on YOUR machine — never on Vercel):
 *   DATABASE_URL="postgresql://…" bun scripts/check-postgres-schema-readiness.ts
 *
 * Exit codes
 *   0  connected AND all expected tables/columns/indexes/FKs present
 *   1  connected, but expected objects are MISSING (an additive-only SQL plan
 *      limited to the missing objects is PRINTED, not executed)
 *   2  configuration problem (DATABASE_URL missing / not postgresql:// / unparsable)
 *   3  network failure (DNS / TCP / TLS — server not reachable)
 *   4  authentication failure (server REACHED, credentials REJECTED — P1000 class)
 *   5  unexpected error
 */

import { SQL } from "bun";

// ---------- Expected inventory (derived from prisma/schema.postgres.prisma at
// HEAD 5db3b0d, proven data-model-identical to prisma/schema.prisma via
// `prisma migrate diff` → "empty migration"). Prisma quotes model names, so
// PostgreSQL identifiers are case-sensitive with capitals. ----------

const EXPECTED_TABLES: string[] = [
  "User",
  "Session",
  "Profession",
  "ProfileProfession",
  "Skill",
  "ProfileSkill",
  "MediaAsset",
  "Project",
  "ProjectSkill",
  "ProjectMedia",
  "Contributor",
  "SavedProject",
  "Collection",
  "CollectionItem",
  "Follow",
  "Inquiry",
  "Notification",
  "Block",
  "Report",
  "ProjectView",
  "ProfileView",
  "AiConversation",
  "AiMessage",
  "AiUsage",
  "LaxiiConversation",
  "LaxiiMessage",
  "LaxiiImageVersion",
  "LaxiiUsage",
  "LaxiiResume",
  "SiteDesign",
  "SiteMaterial",
  "SiteRevision",
  "AuditEvent",
  "ExportJob",
  "DeletionRequest",
  "PasswordResetToken",
  "OAuthFlow",
  "GoogleLink",
];

const NEW_TABLES: string[] = [
  "SiteDesign",
  "SiteMaterial",
  "SiteRevision",
  "PasswordResetToken",
  "LaxiiConversation",
  "LaxiiMessage",
  "LaxiiImageVersion",
  "LaxiiUsage",
  "LaxiiResume",
  "OAuthFlow",
  "GoogleLink",
];

/** The 27 tables that predate the Task-26-era additions. If ANY of these is
 * missing, the database was never initialized and the PARTIAL additive plan
 * below must not be used — the full from-empty DDL is the right tool. */
const CORE_TABLES: string[] = EXPECTED_TABLES.filter((t) => !NEW_TABLES.includes(t));

const NEW_USER_COLUMNS: string[] = [
  "coverPositionY",
  "avatarFit",
  "avatarZoom",
  "avatarPosX",
  "avatarPosY",
  "experienceLevel",
  "recoveryKeyHash",
  "recoveryKeySetAt",
  "googleId",
];

const EXPECTED_INDEXES: Array<{ name: string; ddl: string }> = [
  { name: "Project_category_idx", ddl: `CREATE INDEX "Project_category_idx" ON "Project"("category");` },
  { name: "User_googleId_key", ddl: `CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");` },
  { name: "SiteDesign_userId_key", ddl: `CREATE UNIQUE INDEX "SiteDesign_userId_key" ON "SiteDesign"("userId");` },
  { name: "SiteMaterial_userId_idx", ddl: `CREATE INDEX "SiteMaterial_userId_idx" ON "SiteMaterial"("userId");` },
  { name: "SiteRevision_userId_createdAt_idx", ddl: `CREATE INDEX "SiteRevision_userId_createdAt_idx" ON "SiteRevision"("userId", "createdAt");` },
  { name: "PasswordResetToken_tokenHash_key", ddl: `CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");` },
  { name: "PasswordResetToken_userId_idx", ddl: `CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");` },
  { name: "LaxiiConversation_userId_updatedAt_idx", ddl: `CREATE INDEX "LaxiiConversation_userId_updatedAt_idx" ON "LaxiiConversation"("userId", "updatedAt");` },
  { name: "LaxiiMessage_conversationId_createdAt_idx", ddl: `CREATE INDEX "LaxiiMessage_conversationId_createdAt_idx" ON "LaxiiMessage"("conversationId", "createdAt");` },
  { name: "LaxiiImageVersion_conversationId_idx", ddl: `CREATE INDEX "LaxiiImageVersion_conversationId_idx" ON "LaxiiImageVersion"("conversationId");` },
  { name: "LaxiiImageVersion_parentVersionId_idx", ddl: `CREATE INDEX "LaxiiImageVersion_parentVersionId_idx" ON "LaxiiImageVersion"("parentVersionId");` },
  { name: "LaxiiImageVersion_mediaId_idx", ddl: `CREATE INDEX "LaxiiImageVersion_mediaId_idx" ON "LaxiiImageVersion"("mediaId");` },
  { name: "LaxiiUsage_userId_createdAt_idx", ddl: `CREATE INDEX "LaxiiUsage_userId_createdAt_idx" ON "LaxiiUsage"("userId", "createdAt");` },
  { name: "LaxiiUsage_feature_idx", ddl: `CREATE INDEX "LaxiiUsage_feature_idx" ON "LaxiiUsage"("feature");` },
  { name: "LaxiiResume_conversationId_key", ddl: `CREATE UNIQUE INDEX "LaxiiResume_conversationId_key" ON "LaxiiResume"("conversationId");` },
  { name: "LaxiiResume_userId_updatedAt_idx", ddl: `CREATE INDEX "LaxiiResume_userId_updatedAt_idx" ON "LaxiiResume"("userId", "updatedAt");` },
];

const EXPECTED_FKS: Array<{ table: string; name: string; ddl: string }> = [
  {
    table: "Project",
    name: "Project_coverMediaId_fkey",
    ddl: `ALTER TABLE "Project" ADD CONSTRAINT "Project_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;`,
  },
  {
    table: "SiteDesign",
    name: "SiteDesign_userId_fkey",
    ddl: `ALTER TABLE "SiteDesign" ADD CONSTRAINT "SiteDesign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "SiteMaterial",
    name: "SiteMaterial_userId_fkey",
    ddl: `ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "SiteMaterial",
    name: "SiteMaterial_mediaId_fkey",
    ddl: `ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "SiteRevision",
    name: "SiteRevision_userId_fkey",
    ddl: `ALTER TABLE "SiteRevision" ADD CONSTRAINT "SiteRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "PasswordResetToken",
    name: "PasswordResetToken_userId_fkey",
    ddl: `ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "LaxiiConversation",
    name: "LaxiiConversation_userId_fkey",
    ddl: `ALTER TABLE "LaxiiConversation" ADD CONSTRAINT "LaxiiConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "LaxiiMessage",
    name: "LaxiiMessage_conversationId_fkey",
    ddl: `ALTER TABLE "LaxiiMessage" ADD CONSTRAINT "LaxiiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "LaxiiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "LaxiiImageVersion",
    name: "LaxiiImageVersion_messageId_fkey",
    ddl: `ALTER TABLE "LaxiiImageVersion" ADD CONSTRAINT "LaxiiImageVersion_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "LaxiiMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "LaxiiImageVersion",
    name: "LaxiiImageVersion_conversationId_fkey",
    ddl: `ALTER TABLE "LaxiiImageVersion" ADD CONSTRAINT "LaxiiImageVersion_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "LaxiiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "LaxiiImageVersion",
    name: "LaxiiImageVersion_mediaId_fkey",
    ddl: `ALTER TABLE "LaxiiImageVersion" ADD CONSTRAINT "LaxiiImageVersion_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "LaxiiImageVersion",
    name: "LaxiiImageVersion_parentVersionId_fkey",
    ddl: `ALTER TABLE "LaxiiImageVersion" ADD CONSTRAINT "LaxiiImageVersion_parentVersionId_fkey" FOREIGN KEY ("parentVersionId") REFERENCES "LaxiiImageVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;`,
  },
  {
    table: "LaxiiUsage",
    name: "LaxiiUsage_userId_fkey",
    ddl: `ALTER TABLE "LaxiiUsage" ADD CONSTRAINT "LaxiiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "LaxiiResume",
    name: "LaxiiResume_conversationId_fkey",
    ddl: `ALTER TABLE "LaxiiResume" ADD CONSTRAINT "LaxiiResume_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "LaxiiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
  {
    table: "LaxiiResume",
    name: "LaxiiResume_userId_fkey",
    ddl: `ALTER TABLE "LaxiiResume" ADD CONSTRAINT "LaxiiResume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
  },
];

/** Additive DDL for each NEW table (verified from `prisma migrate diff` on the
 * Task 29 re-sync — purely additive, no DROPs, no type changes). When a new
 * table itself is missing, its own indexes/FKs are necessarily missing too and
 * are emitted as part of the table's block. */
const NEW_TABLE_DDL: Record<string, { create: string; indexes: string[]; fks: string[] }> = {
  SiteDesign: {
    create: `CREATE TABLE "SiteDesign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "draftConfig" TEXT,
    "publishedConfig" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "watermark" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SiteDesign_pkey" PRIMARY KEY ("id")
);`,
    indexes: [`CREATE UNIQUE INDEX "SiteDesign_userId_key" ON "SiteDesign"("userId");`],
    fks: [
      `ALTER TABLE "SiteDesign" ADD CONSTRAINT "SiteDesign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    ],
  },
  SiteMaterial: {
    create: `CREATE TABLE "SiteMaterial" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "extractStatus" TEXT NOT NULL DEFAULT 'EMPTY',
    "extractedText" TEXT,
    "note" TEXT,
    "metaJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteMaterial_pkey" PRIMARY KEY ("id")
);`,
    indexes: [`CREATE INDEX "SiteMaterial_userId_idx" ON "SiteMaterial"("userId");`],
    fks: [
      `ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      `ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    ],
  },
  SiteRevision: {
    create: `CREATE TABLE "SiteRevision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteRevision_pkey" PRIMARY KEY ("id")
);`,
    indexes: [`CREATE INDEX "SiteRevision_userId_createdAt_idx" ON "SiteRevision"("userId", "createdAt");`],
    fks: [
      `ALTER TABLE "SiteRevision" ADD CONSTRAINT "SiteRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    ],
  },
  PasswordResetToken: {
    create: `CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);`,
    indexes: [
      `CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");`,
      `CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");`,
    ],
    fks: [
      `ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    ],
  },
  // ---------- LAXII AI studio (verified against `prisma migrate diff` on the
  // 36-model schema.postgres.prisma — purely additive, no DROPs) ----------
  LaxiiConversation: {
    create: `CREATE TABLE "LaxiiConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New creation',
    "kind" TEXT NOT NULL DEFAULT 'IMAGE',
    "bannerKind" TEXT,
    "canvasWidth" INTEGER,
    "canvasHeight" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LaxiiConversation_pkey" PRIMARY KEY ("id")
);`,
    indexes: [`CREATE INDEX "LaxiiConversation_userId_updatedAt_idx" ON "LaxiiConversation"("userId", "updatedAt");`],
    fks: [
      `ALTER TABLE "LaxiiConversation" ADD CONSTRAINT "LaxiiConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    ],
  },
  LaxiiMessage: {
    create: `CREATE TABLE "LaxiiMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "operation" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DONE',
    "error" TEXT,
    "metaJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LaxiiMessage_pkey" PRIMARY KEY ("id")
);`,
    indexes: [`CREATE INDEX "LaxiiMessage_conversationId_createdAt_idx" ON "LaxiiMessage"("conversationId", "createdAt");`],
    fks: [
      `ALTER TABLE "LaxiiMessage" ADD CONSTRAINT "LaxiiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "LaxiiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    ],
  },
  LaxiiImageVersion: {
    create: `CREATE TABLE "LaxiiImageVersion" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "parentVersionId" TEXT,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "isFavourite" BOOLEAN NOT NULL DEFAULT false,
    "width" INTEGER,
    "height" INTEGER,
    "prompt" TEXT,
    "operation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LaxiiImageVersion_pkey" PRIMARY KEY ("id")
);`,
    indexes: [
      `CREATE INDEX "LaxiiImageVersion_conversationId_idx" ON "LaxiiImageVersion"("conversationId");`,
      `CREATE INDEX "LaxiiImageVersion_parentVersionId_idx" ON "LaxiiImageVersion"("parentVersionId");`,
      `CREATE INDEX "LaxiiImageVersion_mediaId_idx" ON "LaxiiImageVersion"("mediaId");`,
    ],
    fks: [
      `ALTER TABLE "LaxiiImageVersion" ADD CONSTRAINT "LaxiiImageVersion_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "LaxiiMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      `ALTER TABLE "LaxiiImageVersion" ADD CONSTRAINT "LaxiiImageVersion_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "LaxiiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      `ALTER TABLE "LaxiiImageVersion" ADD CONSTRAINT "LaxiiImageVersion_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      `ALTER TABLE "LaxiiImageVersion" ADD CONSTRAINT "LaxiiImageVersion_parentVersionId_fkey" FOREIGN KEY ("parentVersionId") REFERENCES "LaxiiImageVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;`,
    ],
  },
  LaxiiUsage: {
    create: `CREATE TABLE "LaxiiUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LaxiiUsage_pkey" PRIMARY KEY ("id")
);`,
    indexes: [
      `CREATE INDEX "LaxiiUsage_userId_createdAt_idx" ON "LaxiiUsage"("userId", "createdAt");`,
      `CREATE INDEX "LaxiiUsage_feature_idx" ON "LaxiiUsage"("feature");`,
    ],
    fks: [
      `ALTER TABLE "LaxiiUsage" ADD CONSTRAINT "LaxiiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    ],
  },
  LaxiiResume: {
    create: `CREATE TABLE "LaxiiResume" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resumeType" TEXT NOT NULL DEFAULT 'ats',
    "template" TEXT NOT NULL DEFAULT 'classic',
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "factsJson" TEXT NOT NULL DEFAULT '{}',
    "aiTouchedJson" TEXT NOT NULL DEFAULT '[]',
    "targetTitle" TEXT,
    "jobDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LaxiiResume_pkey" PRIMARY KEY ("id")
);`,
    indexes: [
      `CREATE UNIQUE INDEX "LaxiiResume_conversationId_key" ON "LaxiiResume"("conversationId");`,
      `CREATE INDEX "LaxiiResume_userId_updatedAt_idx" ON "LaxiiResume"("userId", "updatedAt");`,
    ],
    fks: [
      `ALTER TABLE "LaxiiResume" ADD CONSTRAINT "LaxiiResume_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "LaxiiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      `ALTER TABLE "LaxiiResume" ADD CONSTRAINT "LaxiiResume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    ],
  },
  // ---------- Google OAuth (direct OIDC — src/lib/auth/google-oauth.ts).
  // Server-side flow records; the browser never carries state/nonce/verifier.
  OAuthFlow: {
    create: `CREATE TABLE "OAuthFlow" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OAuthFlow_pkey" PRIMARY KEY ("id")
);`,
    indexes: [
      `CREATE UNIQUE INDEX "OAuthFlow_stateHash_key" ON "OAuthFlow"("stateHash");`,
      `CREATE INDEX "OAuthFlow_expiresAt_idx" ON "OAuthFlow"("expiresAt");`,
    ],
    fks: [],
  },
  GoogleLink: {
    create: `CREATE TABLE "GoogleLink" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "googleId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GoogleLink_pkey" PRIMARY KEY ("id")
);`,
    indexes: [
      `CREATE UNIQUE INDEX "GoogleLink_tokenHash_key" ON "GoogleLink"("tokenHash");`,
      `CREATE INDEX "GoogleLink_expiresAt_idx" ON "GoogleLink"("expiresAt");`,
    ],
    fks: [],
  },
};

const USER_COLUMN_DDL: Record<string, string> = {
  coverPositionY: `ALTER TABLE "User" ADD COLUMN "coverPositionY" INTEGER NOT NULL DEFAULT 50;`,
  avatarFit: `ALTER TABLE "User" ADD COLUMN "avatarFit" TEXT NOT NULL DEFAULT 'cover';`,
  avatarZoom: `ALTER TABLE "User" ADD COLUMN "avatarZoom" INTEGER NOT NULL DEFAULT 100;`,
  avatarPosX: `ALTER TABLE "User" ADD COLUMN "avatarPosX" INTEGER NOT NULL DEFAULT 50;`,
  avatarPosY: `ALTER TABLE "User" ADD COLUMN "avatarPosY" INTEGER NOT NULL DEFAULT 50;`,
  experienceLevel: `ALTER TABLE "User" ADD COLUMN "experienceLevel" TEXT;`,
  recoveryKeyHash: `ALTER TABLE "User" ADD COLUMN "recoveryKeyHash" TEXT;`,
  recoveryKeySetAt: `ALTER TABLE "User" ADD COLUMN "recoveryKeySetAt" TIMESTAMP(3);`,
  googleId: `ALTER TABLE "User" ADD COLUMN "googleId" TEXT;`,
};

// ---------- Classification (same buckets as scripts/check-postgres-connection.ts) ----------

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

function classifyConnectionError(e: unknown, host: string, port: string, scrub: (t: string) => string): never {
  const err = e as { code?: string; errno?: string; message?: string; cause?: { code?: string } };
  const code = err.code ?? err.cause?.code ?? err.errno ?? "";
  const message = scrub(err.message ?? String(e));

  // Bun (verified on 1.3.14) surfaces a server ErrorResponse as PostgresError
  // with code ERR_POSTGRES_SERVER_ERROR and an EMPTY message — the SQLSTATE
  // and the server's text are not exposed. On the FIRST read-only query that
  // can only mean the server was reached (DNS, TCP, TLS fine) but refused the
  // session — the Prisma P1000 class.
  if (code === "ERR_POSTGRES_SERVER_ERROR") {
    fail(4, [
      "✗ SERVER REJECTED THE SESSION — credentials not accepted (Prisma error class P1000).",
      `  The PostgreSQL server at ${host}:${port} WAS reached (DNS, TCP and TLS are fine),`,
      "  but it refused the authentication/session. (This Bun version does not surface",
      "  the server's own error text or SQLSTATE.)",
      "",
      "  Fix — copy the CURRENT connection string from your provider's dashboard and update",
      "  Vercel → Project → Settings → Environment Variables → DATABASE_URL (Production +",
      "  Preview) → Save → Redeploy.",
      "",
      '  Supabase note: POOLED hosts (.pooler.supabase.com) need user "postgres.<project-ref>";',
      '  the DIRECT host (db.<ref>.supabase.co) needs plain "postgres". Mixing them produces',
      "  exactly this rejection.",
      "",
      "  This probe never prints your password or connection string.",
      "  Full runbook: docs/deployment.md §0.4.",
    ]);
  }

  if (AUTH_CODES.has(code) || AUTH_MESSAGE.test(message)) {
    fail(4, [
      "✗ AUTHENTICATION FAILED — the server REJECTED these credentials (Prisma error class P1000).",
      `  The server at ${host}:${port} WAS reached (DNS, TCP and TLS are fine).`,
      `  Server said: ${message}${code ? ` (code ${code})` : ""}`,
      "",
      '  Supabase note: POOLED hosts (.pooler.supabase.com) need user "postgres.<project-ref>";',
      '  the DIRECT host (db.<ref>.supabase.co) needs plain "postgres".',
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
    "✗ UNEXPECTED ERROR while connecting (redacted):",
    `  ${message}${code ? ` (code ${code})` : ""}`,
    "  Please report this output (passwords are redacted) together with your provider name.",
  ]);
}

// ---------- 1. Configuration checks (no network) ----------

const raw = process.env.DATABASE_URL ?? "";
if (!raw.trim()) {
  fail(2, [
    "✗ CONFIGURATION PROBLEM",
    "  DATABASE_URL is not set.",
    "  Run it with the REAL production PostgreSQL URL, e.g.:",
    "    DATABASE_URL=\"postgresql://…\" bun scripts/check-postgres-schema-readiness.ts",
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
for (const candidate of [
  raw,
  parsed.password,
  (() => {
    try {
      return decodeURIComponent(parsed.password);
    } catch {
      return "";
    }
  })(),
  (() => {
    try {
      return encodeURIComponent(parsed.password);
    } catch {
      return "";
    }
  })(),
]) {
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

console.log("BEAN Folio — PostgreSQL schema readiness probe (read-only)");
console.log(`  target host: ${host}:${port}`);
console.log(`  database:    ${database}`);
console.log(`  user:        ${user}`);
console.log(`  sslmode:     ${sslmode}`);
console.log("  (password and full connection string are NEVER printed)");
console.log("");

// ---------- 2. Connection attempt ----------

let sql: InstanceType<typeof SQL>;
try {
  sql = new SQL(raw);
} catch (e) {
  fail(2, [
    "✗ CONFIGURATION PROBLEM",
    "  The driver rejected the DATABASE_URL before connecting:",
    `  ${scrub(e instanceof Error ? e.message : String(e))}`,
  ]);
}

const timer = setTimeout(() => {
  console.error("  (no response within 15s — treating as a network failure)");
  try {
    sql.close();
  } catch {
    try {
      sql.end();
    } catch {
      /* already closed */
    }
  }
  fail(3, [
    "✗ NETWORK FAILURE — the PostgreSQL server did not respond in time",
    `  host: ${host}:${port}`,
    "  The TCP connection neither succeeded nor was actively refused within 15s.",
    "  Check: the host/port in the connection string, provider status page,",
    "  firewall/security rules, and whether the database project is paused.",
  ]);
}, 15_000);

// ---------- 3. Read-only inventory + report ----------

async function run(): Promise<never> {
  // --- Stage 1: authenticate (server identity echo, read-only) ---
  try {
    const who = (await sql`select current_user as user_name, current_database() as db_name`) as unknown as Array<{
      user_name: string;
      db_name: string;
    }>;
    clearTimeout(timer);
    console.log(
      `✓ Connected — credentials accepted (server-verified user: ${who?.[0]?.user_name ?? "(unknown)"}, database: ${who?.[0]?.db_name ?? "(unknown)"})`
    );
    console.log("");
  } catch (e) {
    clearTimeout(timer);
    classifyConnectionError(e, host, port, scrub);
  }

  // --- Stage 2: inventory (information_schema + pg_catalog, read-only) ---
  let tableRows: Array<{ table_name: string }>;
  let userColRows: Array<{ column_name: string }>;
  let indexRows: Array<{ indexname: string }>;
  let fkRows: Array<{ constraint_name: string; table_name: string }>;
  try {
    tableRows = (await sql`select table_name from information_schema.tables where table_schema = 'public'`) as unknown as Array<{
      table_name: string;
    }>;
    userColRows = (await sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'User'`) as unknown as Array<{
      column_name: string;
    }>;
    indexRows = (await sql`select indexname from pg_indexes where schemaname = 'public'`) as unknown as Array<{
      indexname: string;
    }>;
    fkRows = (await sql`select c.conname as constraint_name, t.relname as table_name from pg_constraint c join pg_class t on t.oid = c.conrelid where c.contype = 'f'`) as unknown as Array<{
      constraint_name: string;
      table_name: string;
    }>;
  } catch (e) {
    const err = e as { code?: string; errno?: string; message?: string };
    fail(5, [
      "✗ UNEXPECTED ERROR while reading the schema inventory (redacted):",
      `  ${scrub(err.message ?? String(e))}${err.code ? ` (code ${err.code})` : ""}`,
    ]);
  }

  const tables = new Set(tableRows.map((r) => r.table_name));
  const userCols = new Set(userColRows.map((r) => r.column_name));
  const indexes = new Set(indexRows.map((r) => r.indexname));
  const fks = new Set(fkRows.map((r) => `${r.table_name}.${r.constraint_name}`));

  const missingTables = EXPECTED_TABLES.filter((t) => !tables.has(t));
  const missingCoreTables = CORE_TABLES.filter((t) => !tables.has(t));
  const missingNewTables = NEW_TABLES.filter((t) => !tables.has(t));
  const missingUserCols = NEW_USER_COLUMNS.filter((c) => !userCols.has(c));
  const missingIndexes = EXPECTED_INDEXES.filter((i) => !indexes.has(i.name));
  const missingFks = EXPECTED_FKS.filter((f) => !fks.has(`${f.table}.${f.name}`));
  const extraCount = tableRows.filter((r) => !EXPECTED_TABLES.includes(r.table_name)).length;

  // --- Report ---
  const sect = (label: string, total: number, missing: string[]) => {
    const present = total - missing.length;
    console.log(
      `  ${present}/${total} ${label}${missing.length ? ` — MISSING: ${missing.join(", ")}` : " — all present"}`
    );
  };

  console.log(
    `  public-schema tables found: ${tableRows.length} (BEAN Folio expects ${EXPECTED_TABLES.length}${
      extraCount ? `; ${extraCount} unrelated table(s) ignored` : ""
    })`
  );
  sect("BEAN Folio tables", EXPECTED_TABLES.length, missingTables);
  sect("post-migration User columns", NEW_USER_COLUMNS.length, missingUserCols);
  sect("new/changed indexes", EXPECTED_INDEXES.length, missingIndexes.map((i) => i.name));
  sect("new/changed foreign keys", EXPECTED_FKS.length, missingFks.map((f) => `${f.table}.${f.name}`));
  console.log("");

  const totalMissing = missingTables.length + missingUserCols.length + missingIndexes.length + missingFks.length;

  if (totalMissing === 0) {
    console.log("  Database is READY: credentials valid, schema complete (38 tables, all columns/indexes/FKs).");
    console.log("  Next: deploy, then exercise GET /api/professions and GET /api/discover, then register/login.");
    process.exit(0);
  }

  console.log(`✗ SCHEMA INCOMPLETE — ${totalMissing} expected object(s) missing.`);
  console.log("");

  // Guard: a partial ADDITIVE plan is only valid on top of the pre-Task-26
  // baseline (27 tables). If core tables are missing the DB was never
  // initialized — the full from-empty DDL is the right (and only safe) tool.
  if (missingCoreTables.length > 0) {
    console.log(`  NOTE: ${missingCoreTables.length} CORE table(s) missing (${missingCoreTables.join(", ")}).`);
    console.log("  This database was never initialized — do NOT apply a partial patch.");
    console.log("  Generate the FULL schema DDL instead (no DB connection needed):");
    console.log("    bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.postgres.prisma --script");
    console.log("    then apply that SQL once. Full runbook: docs/deployment.md §0.4.");
    process.exit(1);
  }

  // --- Additive-only plan, limited to the missing objects (NOT executed) ---
  console.log("  ADDITIVE-ONLY SQL PLAN for the missing objects — PRINTED, NOT EXECUTED.");
  console.log("  Every statement below is CREATE TABLE / ADD COLUMN / CREATE INDEX /");
  console.log("  ADD CONSTRAINT. There are no DROP, ALTER TYPE, or data-touching");
  console.log("  statements. Apply with psql or your SQL console only if you approve;");
  console.log("  then re-run this probe and expect exit 0.");
  console.log("");
  console.log("  ---------- BEGIN PLAN (not executed) ----------");

  const covered = new Set<string>();
  let statementCount = 0;
  const emit = (sqlText: string) => {
    statementCount += 1;
    console.log("  " + sqlText.split("\n").join("\n  "));
    console.log("");
  };

  // 1. New tables (each brings its own indexes + FKs)
  for (const t of missingNewTables) {
    const spec = NEW_TABLE_DDL[t];
    emit(spec.create);
    for (const i of spec.indexes) {
      covered.add(i);
      emit(i);
    }
    for (const f of spec.fks) {
      covered.add(f);
      emit(f);
    }
  }
  // 2. Missing User columns (base table is core → guaranteed present here)
  for (const c of missingUserCols) emit(USER_COLUMN_DDL[c]);
  // 3. Remaining missing indexes (skip ones already emitted with their table)
  for (const i of missingIndexes) {
    if (!covered.has(i.ddl)) emit(i.ddl);
  }
  // 4. Remaining missing FKs
  for (const f of missingFks) {
    if (!covered.has(f.ddl)) emit(f.ddl);
  }

  console.log(`  ---------- END PLAN (${statementCount} statement(s), none executed) ----------`);
  process.exit(1);
}

run();
