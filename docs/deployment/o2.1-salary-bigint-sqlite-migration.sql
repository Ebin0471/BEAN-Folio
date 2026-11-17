-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CandidateOpportunityProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "visibilityStatus" TEXT NOT NULL DEFAULT 'HIDDEN',
    "employmentTypes" TEXT,
    "workModes" TEXT,
    "preferredLocations" TEXT,
    "preferredProfessionIds" TEXT,
    "experienceMinYears" INTEGER,
    "experienceMaxYears" INTEGER,
    "availableFrom" DATETIME,
    "noticePeriodDays" INTEGER,
    "compensationVisibility" TEXT NOT NULL DEFAULT 'HIDDEN',
    "salaryMinPaise" BIGINT,
    "salaryMaxPaise" BIGINT,
    "salaryCurrency" TEXT,
    "compensationPeriod" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CandidateOpportunityProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CandidateOpportunityProfile" ("availableFrom", "compensationPeriod", "compensationVisibility", "createdAt", "employmentTypes", "experienceMaxYears", "experienceMinYears", "id", "noticePeriodDays", "preferredLocations", "preferredProfessionIds", "salaryCurrency", "salaryMaxPaise", "salaryMinPaise", "updatedAt", "userId", "visibilityStatus", "workModes") SELECT "availableFrom", "compensationPeriod", "compensationVisibility", "createdAt", "employmentTypes", "experienceMaxYears", "experienceMinYears", "id", "noticePeriodDays", "preferredLocations", "preferredProfessionIds", "salaryCurrency", "salaryMaxPaise", "salaryMinPaise", "updatedAt", "userId", "visibilityStatus", "workModes" FROM "CandidateOpportunityProfile";
DROP TABLE "CandidateOpportunityProfile";
ALTER TABLE "new_CandidateOpportunityProfile" RENAME TO "CandidateOpportunityProfile";
CREATE UNIQUE INDEX "CandidateOpportunityProfile_userId_key" ON "CandidateOpportunityProfile"("userId");
CREATE INDEX "CandidateOpportunityProfile_visibilityStatus_idx" ON "CandidateOpportunityProfile"("visibilityStatus");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

