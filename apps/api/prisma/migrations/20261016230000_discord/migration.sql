-- Discord notifications (src/discord): connected servers, channel destinations, message templates,
-- routing rules, per-channel deliveries, workspace settings and counts of unrouted events. Additive only.
-- CreateTable
CREATE TABLE "DiscordConnection" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "guildId" TEXT NOT NULL,
    "guildName" TEXT NOT NULL,
    "guildIcon" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'connected',
    "permissions" TEXT NOT NULL DEFAULT '0',
    "manageChannels" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT NOT NULL DEFAULT '',
    "lastCheckedAt" TIMESTAMP(3),
    "connectedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscordDestination" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "channelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'text',
    "group" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastError" TEXT NOT NULL DEFAULT '',
    "lastDeliveryAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordDestination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscordTemplate" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "body" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscordRule" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "events" TEXT[],
    "destinationIds" TEXT[],
    "templateId" UUID,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "lastMatchedAt" TIMESTAMP(3),
    "lastTestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscordDelivery" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "ruleId" UUID,
    "destinationId" UUID,
    "eventId" UUID,
    "eventType" TEXT NOT NULL,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "error" TEXT NOT NULL DEFAULT '',
    "errorCode" TEXT NOT NULL DEFAULT '',
    "responseStatus" INTEGER,
    "messageId" TEXT NOT NULL DEFAULT '',
    "message" JSONB,
    "channelName" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscordSettings" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "unrouted" TEXT NOT NULL DEFAULT 'ignore',
    "fallbackDestinationId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscordUnroutedEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lastEventId" UUID,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordUnroutedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscordConnection_workspaceId_guildId_key" ON "DiscordConnection"("workspaceId", "guildId");

-- CreateIndex
CREATE INDEX "DiscordDestination_workspaceId_idx" ON "DiscordDestination"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordDestination_connectionId_channelId_key" ON "DiscordDestination"("connectionId", "channelId");

-- CreateIndex
CREATE INDEX "DiscordTemplate_workspaceId_idx" ON "DiscordTemplate"("workspaceId");

-- CreateIndex
CREATE INDEX "DiscordRule_workspaceId_enabled_idx" ON "DiscordRule"("workspaceId", "enabled");

-- CreateIndex
CREATE INDEX "DiscordDelivery_workspaceId_createdAt_idx" ON "DiscordDelivery"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "DiscordDelivery_status_nextAttemptAt_idx" ON "DiscordDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DiscordDelivery_eventId_idx" ON "DiscordDelivery"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordDelivery_ruleId_destinationId_eventId_key" ON "DiscordDelivery"("ruleId", "destinationId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordSettings_workspaceId_key" ON "DiscordSettings"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscordUnroutedEvent_workspaceId_eventType_key" ON "DiscordUnroutedEvent"("workspaceId", "eventType");

-- AddForeignKey
ALTER TABLE "DiscordConnection" ADD CONSTRAINT "DiscordConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordDestination" ADD CONSTRAINT "DiscordDestination_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordDestination" ADD CONSTRAINT "DiscordDestination_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "DiscordConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordTemplate" ADD CONSTRAINT "DiscordTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordRule" ADD CONSTRAINT "DiscordRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordRule" ADD CONSTRAINT "DiscordRule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DiscordTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordDelivery" ADD CONSTRAINT "DiscordDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordDelivery" ADD CONSTRAINT "DiscordDelivery_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "DiscordRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordDelivery" ADD CONSTRAINT "DiscordDelivery_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "DiscordDestination"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordSettings" ADD CONSTRAINT "DiscordSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscordUnroutedEvent" ADD CONSTRAINT "DiscordUnroutedEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
