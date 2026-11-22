-- CreateTable
CREATE TABLE "TalentMatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "opportunityId" TEXT NOT NULL,
    "candidateUserId" TEXT NOT NULL,
    "matchVersion" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "ineligibleReason" TEXT,
    "explanationJson" TEXT,
    "generatedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TalentMatch_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TalentMatch_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TalentMatch_candidateUserId_matchVersion_idx" ON "TalentMatch"("candidateUserId", "matchVersion");

-- CreateIndex
CREATE INDEX "TalentMatch_opportunityId_score_idx" ON "TalentMatch"("opportunityId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "TalentMatch_opportunityId_candidateUserId_key" ON "TalentMatch"("opportunityId", "candidateUserId");

