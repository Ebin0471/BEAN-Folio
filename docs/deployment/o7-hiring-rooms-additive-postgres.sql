-- CreateTable
CREATE TABLE "HiringRoom" (
    "id" TEXT NOT NULL,
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
    "closedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HiringRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HiringRoomMember" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT,
    "roomRole" TEXT NOT NULL,
    "assignedByUserId" TEXT,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HiringRoomMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interview" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "meetingLink" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "proposedByRole" TEXT NOT NULL,
    "proposedByUserId" TEXT,
    "schedulingUserId" TEXT,
    "cancelledByUserId" TEXT,
    "cancelReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Interview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HiringStageEvent" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "fromStage" TEXT,
    "actorRole" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HiringStageEvent_pkey" PRIMARY KEY ("id")
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

-- AddForeignKey
ALTER TABLE "HiringRoom" ADD CONSTRAINT "HiringRoom_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "OpportunityInvitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiringRoom" ADD CONSTRAINT "HiringRoom_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "EmployerOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiringRoom" ADD CONSTRAINT "HiringRoom_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiringRoom" ADD CONSTRAINT "HiringRoom_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiringRoom" ADD CONSTRAINT "HiringRoom_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiringRoomMember" ADD CONSTRAINT "HiringRoomMember_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HiringRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiringRoomMember" ADD CONSTRAINT "HiringRoomMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiringRoomMember" ADD CONSTRAINT "HiringRoomMember_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HiringRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_proposedByUserId_fkey" FOREIGN KEY ("proposedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_schedulingUserId_fkey" FOREIGN KEY ("schedulingUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiringStageEvent" ADD CONSTRAINT "HiringStageEvent_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HiringRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiringStageEvent" ADD CONSTRAINT "HiringStageEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

