-- CreateTable
CREATE TABLE "OpportunityInvitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "candidateUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "offerSalaryMinPaise" BIGINT NOT NULL,
    "offerSalaryMaxPaise" BIGINT NOT NULL,
    "offerCurrency" TEXT NOT NULL,
    "offerPeriod" TEXT NOT NULL,
    "acceptedSalaryMinPaise" BIGINT,
    "acceptedSalaryMaxPaise" BIGINT,
    "acceptedCurrency" TEXT,
    "acceptedPeriod" TEXT,
    "acceptedAt" DATETIME,
    "sentAt" DATETIME,
    "viewedAt" DATETIME,
    "respondedAt" DATETIME,
    "withdrawnAt" DATETIME,
    "expiresAt" DATETIME,
    "createdByUserId" TEXT,
    "sentByUserId" TEXT,
    "withdrawnByUserId" TEXT,
    "activeInvitationToken" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OpportunityInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "EmployerOrganization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OpportunityInvitation_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OpportunityInvitation_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OpportunityInvitation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OpportunityInvitation_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OpportunityInvitation_withdrawnByUserId_fkey" FOREIGN KEY ("withdrawnByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InvitationNegotiation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invitationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "proposerRole" TEXT NOT NULL,
    "proposerUserId" TEXT,
    "proposedSalaryMinPaise" BIGINT NOT NULL,
    "proposedSalaryMaxPaise" BIGINT NOT NULL,
    "proposedCurrency" TEXT NOT NULL,
    "proposedPeriod" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InvitationNegotiation_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "OpportunityInvitation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InvitationNegotiation_proposerUserId_fkey" FOREIGN KEY ("proposerUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "OpportunityInvitation_organizationId_status_idx" ON "OpportunityInvitation"("organizationId", "status");

-- CreateIndex
CREATE INDEX "OpportunityInvitation_opportunityId_status_idx" ON "OpportunityInvitation"("opportunityId", "status");

-- CreateIndex
CREATE INDEX "OpportunityInvitation_candidateUserId_status_idx" ON "OpportunityInvitation"("candidateUserId", "status");

-- CreateIndex
CREATE INDEX "OpportunityInvitation_status_expiresAt_idx" ON "OpportunityInvitation"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityInvitation_organizationId_opportunityId_candidateUserId_activeInvitationToken_key" ON "OpportunityInvitation"("organizationId", "opportunityId", "candidateUserId", "activeInvitationToken");

-- CreateIndex
CREATE INDEX "InvitationNegotiation_invitationId_status_idx" ON "InvitationNegotiation"("invitationId", "status");

-- CreateIndex
CREATE INDEX "InvitationNegotiation_status_expiresAt_idx" ON "InvitationNegotiation"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvitationNegotiation_invitationId_seq_key" ON "InvitationNegotiation"("invitationId", "seq");

