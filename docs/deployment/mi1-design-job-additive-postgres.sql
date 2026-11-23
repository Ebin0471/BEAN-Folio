-- MI-1 (multi-instance readiness) — ADDITIVE PostgreSQL migration.
-- Postgres mirror of mi1-design-job-additive-sqlite.sql (identical data model;
-- TIMESTAMP(3) / BOOLEAN / SERIAL semantics per the schema.postgres.prisma
-- datasource). No data migration; no existing column is modified.
--
-- Apply manually ONLY on an approved environment:
--   psql "$DATABASE_URL" -f docs/deployment/mi1-design-job-additive-postgres.sql

-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DesignJob" (
    "id" TEXT NOT NULL,
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
    "cancelRequestedAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesignJob_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "DesignJob_userId_idempotencyKey_key" ON "DesignJob"("userId", "idempotencyKey");
CREATE INDEX "DesignJob_userId_createdAt_idx" ON "DesignJob"("userId", "createdAt");
CREATE INDEX "DesignJob_userId_status_idx" ON "DesignJob"("userId", "status");

-- ForeignKeys
ALTER TABLE "DesignJob" ADD CONSTRAINT "DesignJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
