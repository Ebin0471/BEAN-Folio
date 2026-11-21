-- CreateTable
CREATE TABLE "CandidateShortlist" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "candidateUserId" TEXT NOT NULL,
    "note" TEXT,
    "scoreAtAdd" INTEGER,
    "matchVersionAtAdd" TEXT,
    "addedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateShortlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateShortlist_organizationId_status_idx" ON "CandidateShortlist"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CandidateShortlist_candidateUserId_idx" ON "CandidateShortlist"("candidateUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateShortlist_organizationId_opportunityId_candidateUs_key" ON "CandidateShortlist"("organizationId", "opportunityId", "candidateUserId");

-- AddForeignKey
ALTER TABLE "CandidateShortlist" ADD CONSTRAINT "CandidateShortlist_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "EmployerOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateShortlist" ADD CONSTRAINT "CandidateShortlist_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateShortlist" ADD CONSTRAINT "CandidateShortlist_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateShortlist" ADD CONSTRAINT "CandidateShortlist_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

