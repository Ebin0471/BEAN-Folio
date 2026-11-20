-- CreateTable
CREATE TABLE "HiringRoom" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invitationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "candidateUserId" TEXT,
    "candidateDisplayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "currentStage" TEXT NOT NULL DEFAULT 'INVITATION_ACCEPTED',
    "acceptedSalaryMinPaise" BIGINT NOT NULL,
    "acceptedSalaryMaxPaise" BIGINT NOT NULL,
    "acceptedCurrency" TEXT NOT NULL,
    "acceptedPeriod" TEXT NOT NULL,
    "candidateTimezone" TEXT,
    "closedOutcome" TEXT,
    "closedReason" TEXT,
    "closedAt" DATETIME,
    "pausedAt" DATETIME,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HiringRoom_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "OpportunityInvitation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HiringRoom_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "EmployerOrganization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HiringRoom_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HiringRoom_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "HiringRoom_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HiringRoomMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "userId" TEXT,
    "roomRole" TEXT NOT NULL,
    "assignedByUserId" TEXT,
    "removedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HiringRoomMember_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HiringRoom" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HiringRoomMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "HiringRoomMember_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Interview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "meetingLink" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "proposedByRole" TEXT NOT NULL,
    "proposedByUserId" TEXT,
    "schedulingUserId" TEXT,
    "cancelledByUserId" TEXT,
    "cancelReason" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Interview_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HiringRoom" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Interview_proposedByUserId_fkey" FOREIGN KEY ("proposedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Interview_schedulingUserId_fkey" FOREIGN KEY ("schedulingUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Interview_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HiringStageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "fromStage" TEXT,
    "actorRole" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HiringStageEvent_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HiringRoom" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HiringStageEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "HiringRoom_invitationId_key" ON "HiringRoom"("invitationId");

-- CreateIndex
CREATE INDEX "HiringRoom_organizationId_status_idx" ON "HiringRoom"("organizationId", "status");

-- CreateIndex
CREATE INDEX "HiringRoom_candidateUserId_status_idx" ON "HiringRoom"("candidateUserId", "status");

-- CreateIndex
CREATE INDEX "HiringRoom_opportunityId_status_idx" ON "HiringRoom"("opportunityId", "status");

-- CreateIndex
CREATE INDEX "HiringRoom_status_updatedAt_idx" ON "HiringRoom"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "HiringRoomMember_roomId_roomRole_removedAt_idx" ON "HiringRoomMember"("roomId", "roomRole", "removedAt");

-- CreateIndex
CREATE INDEX "HiringRoomMember_userId_idx" ON "HiringRoomMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HiringRoomMember_roomId_userId_key" ON "HiringRoomMember"("roomId", "userId");

-- CreateIndex
CREATE INDEX "Interview_roomId_status_idx" ON "Interview"("roomId", "status");

-- CreateIndex
CREATE INDEX "Interview_status_startsAt_idx" ON "Interview"("status", "startsAt");

-- CreateIndex
CREATE INDEX "HiringStageEvent_roomId_createdAt_idx" ON "HiringStageEvent"("roomId", "createdAt");

