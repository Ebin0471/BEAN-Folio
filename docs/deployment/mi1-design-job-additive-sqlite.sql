-- MI-1 (multi-instance readiness) — ADDITIVE SQLite migration.
--
--  1. AgentTask.cancelRequestedAt — durable cancellation flag stamped by ANY
--     application instance; runners poll it at step boundaries (replaces the
--     process-local cancel Set). Nullable; no backfill (absent = not requested).
--  2. DesignJob — the durable shared design-job store (previously a
--     process-local Map). Every column is additive; no existing table is
--     altered beyond the single new AgentTask column.
--
-- Review notes:
--   * No data migration: the previous store held only ephemeral in-flight
--     state; terminal history already lived in the AgentTask shadow
--     (kind SITE_DESIGN_JOB), which is unchanged.
--   * Idempotent: safe to re-run only as a whole-file review artifact; the
--     CREATE TABLE fails loudly if the table already exists (expected).
--   * Verified end-to-end on the isolated QA database
--     (scripts/ops/qa-db-env.sh assert + prisma db push) — never against a
--     database containing real user data.
--
-- Apply manually ONLY on an approved environment:
--   sqlite3 db/custom.db < docs/deployment/mi1-design-job-additive-sqlite.sql
-- (Standard path: `prisma db push` derives the same result from
--  prisma/schema.prisma; this file is the reviewed record of that diff.)

-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN "cancelRequestedAt" DATETIME;

-- CreateTable
CREATE TABLE "DesignJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "planJson" TEXT NOT NULL,
    "baseConfigJson" TEXT NOT NULL,
    "workingJson" TEXT NOT NULL,
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "changesJson" TEXT NOT NULL DEFAULT '[]',
    "eventsJson" TEXT NOT NULL DEFAULT '[]',
    "verificationJson" TEXT,
    "error" TEXT,
    "materialIdsJson" TEXT NOT NULL DEFAULT '[]',
    "contextJson" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "cancelRequestedAt" DATETIME,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "leaseUntil" DATETIME,
    "heartbeatAt" DATETIME,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DesignJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Indexes
CREATE UNIQUE INDEX "DesignJob_userId_idempotencyKey_key" ON "DesignJob"("userId", "idempotencyKey");
CREATE INDEX "DesignJob_userId_createdAt_idx" ON "DesignJob"("userId", "createdAt");
CREATE INDEX "DesignJob_userId_status_idx" ON "DesignJob"("userId", "status");
