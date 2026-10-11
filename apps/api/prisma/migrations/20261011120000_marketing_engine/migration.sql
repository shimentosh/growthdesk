-- CreateEnum
CREATE TYPE "ListMembershipStatus" AS ENUM ('subscribed', 'unsubscribed', 'pending');

-- CreateEnum
CREATE TYPE "EspProvider" AS ENUM ('ses', 'smtp_relay');

-- CreateEnum
CREATE TYPE "SendingDomainStatus" AS ENUM ('pending', 'verified', 'failed');

-- CreateEnum
CREATE TYPE "MarketingCampaignStatus" AS ENUM ('draft', 'scheduled', 'sending', 'paused', 'sent', 'canceled');

-- CreateEnum
CREATE TYPE "MarketingSendStatus" AS ENUM ('queued', 'sent', 'failed', 'skipped', 'bounced', 'complained');

-- CreateTable
CREATE TABLE "MarketingList" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "archivedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListMembership" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "listId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "status" "ListMembershipStatus" NOT NULL DEFAULT 'subscribed',
    "source" TEXT NOT NULL DEFAULT '',
    "subscribedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EspConnection" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" "EspProvider" NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "secretSealed" TEXT,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'disconnected',
    "lastError" TEXT NOT NULL DEFAULT '',
    "lastCheckedAt" TIMESTAMP(3),
    "webhookToken" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EspConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SendingDomain" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "status" "SendingDomainStatus" NOT NULL DEFAULT 'pending',
    "verificationToken" TEXT NOT NULL,
    "dkimSelectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checks" JSONB NOT NULL DEFAULT '{}',
    "lastCheckedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pausedReason" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SendingDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDesign" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "archivedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDesign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MarketingCampaignStatus" NOT NULL DEFAULT 'draft',
    "subject" TEXT NOT NULL DEFAULT '',
    "preheader" TEXT NOT NULL DEFAULT '',
    "fromName" TEXT NOT NULL DEFAULT '',
    "fromLocalPart" TEXT NOT NULL DEFAULT '',
    "replyTo" TEXT NOT NULL DEFAULT '',
    "sendingDomainId" UUID,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "designId" UUID,
    "audience" JSONB NOT NULL DEFAULT '{}',
    "trackOpens" BOOLEAN NOT NULL DEFAULT true,
    "trackClicks" BOOLEAN NOT NULL DEFAULT true,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pausedReason" TEXT NOT NULL DEFAULT '',
    "canceledAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueOpenCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueClickCount" INTEGER NOT NULL DEFAULT 0,
    "unsubscribeCount" INTEGER NOT NULL DEFAULT 0,
    "bounceCount" INTEGER NOT NULL DEFAULT 0,
    "complaintCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingSend" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" "MarketingSendStatus" NOT NULL DEFAULT 'queued',
    "providerMessageId" TEXT,
    "error" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "complainedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingList_workspaceId_archivedAt_idx" ON "MarketingList"("workspaceId", "archivedAt");

-- CreateIndex
CREATE INDEX "ListMembership_workspaceId_contactId_idx" ON "ListMembership"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "ListMembership_workspaceId_listId_status_idx" ON "ListMembership"("workspaceId", "listId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ListMembership_listId_contactId_key" ON "ListMembership"("listId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "EspConnection_workspaceId_key" ON "EspConnection"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EspConnection_webhookToken_key" ON "EspConnection"("webhookToken");

-- CreateIndex
CREATE UNIQUE INDEX "SendingDomain_workspaceId_domain_key" ON "SendingDomain"("workspaceId", "domain");

-- CreateIndex
CREATE INDEX "EmailDesign_workspaceId_archivedAt_idx" ON "EmailDesign"("workspaceId", "archivedAt");

-- CreateIndex
CREATE INDEX "MarketingCampaign_workspaceId_status_idx" ON "MarketingCampaign"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "MarketingSend_campaignId_status_idx" ON "MarketingSend"("campaignId", "status");

-- CreateIndex
CREATE INDEX "MarketingSend_workspaceId_providerMessageId_idx" ON "MarketingSend"("workspaceId", "providerMessageId");

-- CreateIndex
CREATE INDEX "MarketingSend_workspaceId_contactId_idx" ON "MarketingSend"("workspaceId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingSend_campaignId_contactId_key" ON "MarketingSend"("campaignId", "contactId");

-- AddForeignKey
ALTER TABLE "MarketingList" ADD CONSTRAINT "MarketingList_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMembership" ADD CONSTRAINT "ListMembership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMembership" ADD CONSTRAINT "ListMembership_listId_fkey" FOREIGN KEY ("listId") REFERENCES "MarketingList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMembership" ADD CONSTRAINT "ListMembership_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EspConnection" ADD CONSTRAINT "EspConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendingDomain" ADD CONSTRAINT "SendingDomain_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDesign" ADD CONSTRAINT "EmailDesign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_sendingDomainId_fkey" FOREIGN KEY ("sendingDomainId") REFERENCES "SendingDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingSend" ADD CONSTRAINT "MarketingSend_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingSend" ADD CONSTRAINT "MarketingSend_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingSend" ADD CONSTRAINT "MarketingSend_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Give the seeded plans their marketing allowance (packages/shared/src/plans.ts).
-- Plans an operator created by hand keep 0 / off until set in Platform admin.
UPDATE "Plan" SET
  "limits" = "limits" || CASE "key"
    WHEN 'free'    THEN '{"marketingContacts": 250,   "monthlyMarketingEmails": 1000,   "sendingDomains": 1}'::jsonb
    WHEN 'starter' THEN '{"marketingContacts": 2500,  "monthlyMarketingEmails": 25000,  "sendingDomains": 1}'::jsonb
    WHEN 'growth'  THEN '{"marketingContacts": 15000, "monthlyMarketingEmails": 150000, "sendingDomains": 3}'::jsonb
    WHEN 'agency'  THEN '{"marketingContacts": 50000, "monthlyMarketingEmails": 500000, "sendingDomains": 10}'::jsonb
  END,
  "features" = "features" || '{"marketing": true}'::jsonb
WHERE "key" IN ('free', 'starter', 'growth', 'agency') AND NOT ("limits" ? 'marketingContacts');
