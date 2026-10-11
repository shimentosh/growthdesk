-- CreateEnum
CREATE TYPE "PlatformBroadcastStatus" AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'canceled', 'failed');

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "bouncedAt" TIMESTAMP(3),
ADD COLUMN     "broadcastId" UUID,
ADD COLUMN     "clickedAt" TIMESTAMP(3),
ADD COLUMN     "complainedAt" TIMESTAMP(3),
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "dripStepId" UUID,
ADD COLUMN     "fromAddress" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "openedAt" TIMESTAMP(3),
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'smtp',
ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "stream" TEXT NOT NULL DEFAULT 'transactional',
ADD COLUMN     "subject" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "templateVersionId" UUID,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "userId" UUID;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "priceCents" INTEGER,
ADD COLUMN     "priceCurrency" TEXT;

-- CreateTable
CREATE TABLE "PlatformEmailEvent" (
    "id" UUID NOT NULL,
    "emailLogId" UUID,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformEmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformEmailTemplate" (
    "key" TEXT NOT NULL,
    "activeVersionId" UUID,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformEmailTemplate_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PlatformEmailTemplateVersion" (
    "id" UUID NOT NULL,
    "templateKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "preheader" TEXT NOT NULL DEFAULT '',
    "blocks" JSONB NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformEmailTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformUserProfile" (
    "userId" UUID NOT NULL,
    "signupSource" TEXT NOT NULL DEFAULT '',
    "utm" JSONB NOT NULL DEFAULT '{}',
    "referrer" TEXT NOT NULL DEFAULT '',
    "landingPath" TEXT NOT NULL DEFAULT '',
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "consentSource" TEXT NOT NULL DEFAULT '',
    "unsubscribedAt" TIMESTAMP(3),
    "suppressedAt" TIMESTAMP(3),
    "suppressionReason" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "anonymisedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformUserProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PlatformUserNote" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformUserNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformWaitlistEntry" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "utm" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSignupInvite" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformSignupInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSiteContent" (
    "key" TEXT NOT NULL,
    "draft" JSONB NOT NULL DEFAULT '{}',
    "published" JSONB NOT NULL DEFAULT '{}',
    "publishedAt" TIMESTAMP(3),
    "publishedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSiteContent_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PlatformAsset" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAudience" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAudience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformBroadcast" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "audienceId" UUID,
    "subject" TEXT NOT NULL DEFAULT '',
    "preheader" TEXT NOT NULL DEFAULT '',
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "fromOverride" TEXT NOT NULL DEFAULT '',
    "status" "PlatformBroadcastStatus" NOT NULL DEFAULT 'draft',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "totals" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformBroadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformBroadcastRecipient" (
    "broadcastId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "emailLogId" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformBroadcastRecipient_pkey" PRIMARY KEY ("broadcastId","userId")
);

-- CreateTable
CREATE TABLE "PlatformDripSequence" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformDripSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformDripStep" (
    "id" UUID NOT NULL,
    "sequenceId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "delayHours" INTEGER NOT NULL DEFAULT 0,
    "subject" TEXT NOT NULL,
    "preheader" TEXT NOT NULL DEFAULT '',
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformDripStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformDripEnrollment" (
    "id" UUID NOT NULL,
    "sequenceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "nextStepPosition" INTEGER NOT NULL DEFAULT 1,
    "nextRunAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformDripEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionStatusChange" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "fromStatus" "SubscriptionStatus",
    "toStatus" "SubscriptionStatus" NOT NULL,
    "planId" UUID NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "mrrCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "provider" TEXT NOT NULL DEFAULT 'none',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformRevenueSnapshot" (
    "day" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "mrrCents" INTEGER NOT NULL,
    "payingCount" INTEGER NOT NULL,
    "trialingCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformRevenueSnapshot_pkey" PRIMARY KEY ("day","currency")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformEmailEvent_providerEventId_key" ON "PlatformEmailEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "PlatformEmailEvent_emailLogId_idx" ON "PlatformEmailEvent"("emailLogId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformEmailTemplateVersion_templateKey_version_key" ON "PlatformEmailTemplateVersion"("templateKey", "version");

-- CreateIndex
CREATE INDEX "PlatformUserProfile_tags_idx" ON "PlatformUserProfile" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "PlatformUserProfile_signupSource_idx" ON "PlatformUserProfile"("signupSource");

-- CreateIndex
CREATE INDEX "PlatformUserNote_userId_createdAt_idx" ON "PlatformUserNote"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformWaitlistEntry_email_key" ON "PlatformWaitlistEntry"("email");

-- CreateIndex
CREATE INDEX "PlatformWaitlistEntry_status_createdAt_idx" ON "PlatformWaitlistEntry"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformSignupInvite_tokenHash_key" ON "PlatformSignupInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "PlatformSignupInvite_email_idx" ON "PlatformSignupInvite"("email");

-- CreateIndex
CREATE INDEX "PlatformBroadcast_status_scheduledAt_idx" ON "PlatformBroadcast"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "PlatformBroadcastRecipient_broadcastId_status_idx" ON "PlatformBroadcastRecipient"("broadcastId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformDripStep_sequenceId_position_key" ON "PlatformDripStep"("sequenceId", "position");

-- CreateIndex
CREATE INDEX "PlatformDripEnrollment_status_nextRunAt_idx" ON "PlatformDripEnrollment"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformDripEnrollment_sequenceId_userId_key" ON "PlatformDripEnrollment"("sequenceId", "userId");

-- CreateIndex
CREATE INDEX "SubscriptionStatusChange_at_idx" ON "SubscriptionStatusChange"("at");

-- CreateIndex
CREATE INDEX "SubscriptionStatusChange_billingAccountId_at_idx" ON "SubscriptionStatusChange"("billingAccountId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "EmailLog_providerMessageId_key" ON "EmailLog"("providerMessageId");

-- CreateIndex
CREATE INDEX "EmailLog_userId_createdAt_idx" ON "EmailLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailLog_broadcastId_status_idx" ON "EmailLog"("broadcastId", "status");

-- CreateIndex
CREATE INDEX "EmailLog_status_createdAt_idx" ON "EmailLog"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "PlatformEmailTemplateVersion" ADD CONSTRAINT "PlatformEmailTemplateVersion_templateKey_fkey" FOREIGN KEY ("templateKey") REFERENCES "PlatformEmailTemplate"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformBroadcast" ADD CONSTRAINT "PlatformBroadcast_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "PlatformAudience"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformBroadcastRecipient" ADD CONSTRAINT "PlatformBroadcastRecipient_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "PlatformBroadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformDripStep" ADD CONSTRAINT "PlatformDripStep_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "PlatformDripSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformDripEnrollment" ADD CONSTRAINT "PlatformDripEnrollment_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "PlatformDripSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

