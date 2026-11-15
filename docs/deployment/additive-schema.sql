-- ⚠️ HISTORICAL ARTIFACT (pre-LAXII, 31-table era — DO NOT APPLY to the current 36-model schema).
-- This file predates the LAXII AI-studio tables (LaxiiConversation, LaxiiMessage,
-- LaxiiImageVersion, LaxiiUsage, LaxiiResume). Applying it leaves those tables missing and the
-- readiness probe (scripts/check-postgres-schema-readiness.ts, expects the parity-verified 85-model schema) will fail.
-- Regenerate fresh DDL instead: bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.postgres.prisma --script
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarFit" TEXT NOT NULL DEFAULT 'cover',
ADD COLUMN     "avatarPosX" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "avatarPosY" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "avatarZoom" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "coverPositionY" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "experienceLevel" TEXT,
ADD COLUMN     "recoveryKeyHash" TEXT,
ADD COLUMN     "recoveryKeySetAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SiteDesign" (
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
);

-- CreateTable
CREATE TABLE "SiteMaterial" (
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
);

-- CreateTable
CREATE TABLE "SiteRevision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteDesign_userId_key" ON "SiteDesign"("userId");

-- CreateIndex
CREATE INDEX "SiteMaterial_userId_idx" ON "SiteMaterial"("userId");

-- CreateIndex
CREATE INDEX "SiteRevision_userId_createdAt_idx" ON "SiteRevision"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "Project_category_idx" ON "Project"("category");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDesign" ADD CONSTRAINT "SiteDesign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteMaterial" ADD CONSTRAINT "SiteMaterial_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteRevision" ADD CONSTRAINT "SiteRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

