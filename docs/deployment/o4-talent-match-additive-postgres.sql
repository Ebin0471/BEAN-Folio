-- CreateTable
CREATE TABLE "TalentMatch" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "candidateUserId" TEXT NOT NULL,
    "matchVersion" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "ineligibleReason" TEXT,
    "explanationJson" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TalentMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentMatch_candidateUserId_matchVersion_idx" ON "TalentMatch"("candidateUserId", "matchVersion");

-- CreateIndex
CREATE INDEX "TalentMatch_opportunityId_score_idx" ON "TalentMatch"("opportunityId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "TalentMatch_opportunityId_candidateUserId_key" ON "TalentMatch"("opportunityId", "candidateUserId");

-- AddForeignKey
ALTER TABLE "TalentMatch" ADD CONSTRAINT "TalentMatch_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TalentMatch" ADD CONSTRAINT "TalentMatch_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

