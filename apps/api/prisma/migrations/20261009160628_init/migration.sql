-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('none', 'support', 'admin', 'owner');

-- CreateEnum
CREATE TYPE "AuthTokenKind" AS ENUM ('verify_email', 'reset_password');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'expired');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('month', 'year');

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('owner', 'admin', 'manager', 'member', 'viewer');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "Qualification" AS ENUM ('unqualified', 'qualifying', 'qualified', 'disqualified');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('new', 'contacted', 'replied', 'interested', 'customer', 'not_interested', 'do_not_contact');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('unknown', 'granted', 'denied');

-- CreateEnum
CREATE TYPE "IdentifierKind" AS ENUM ('email', 'phone', 'whatsapp', 'telegram');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "SuppressionKind" AS ENUM ('email', 'domain', 'phone');

-- CreateEnum
CREATE TYPE "StageKind" AS ENUM ('open', 'won', 'lost');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('open', 'won', 'lost');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('scheduled', 'completed', 'canceled', 'no_show');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('email', 'follow_up', 'call', 'meeting', 'proposal', 'review_reply', 'qualify', 'custom');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('open', 'done', 'canceled');

-- CreateEnum
CREATE TYPE "MailboxProvider" AS ENUM ('smtp', 'gmail', 'microsoft');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('connected', 'error', 'disconnected');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('email', 'whatsapp', 'telegram', 'call');

-- CreateEnum
CREATE TYPE "StepType" AS ENUM ('email', 'wait', 'branch', 'call_task', 'whatsapp', 'telegram', 'update_field', 'assign_owner', 'create_task', 'notify', 'end');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'scheduled', 'running', 'paused', 'completed', 'canceled');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('active', 'paused', 'completed', 'stopped', 'failed');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('running', 'succeeded', 'failed', 'skipped', 'uncertain');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'bounced', 'received', 'uncertain');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('queued', 'ringing', 'in_progress', 'completed', 'busy', 'no_answer', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('pending', 'waiting_approval', 'waiting', 'running', 'succeeded', 'failed', 'skipped', 'canceled');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "passwordHash" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "googleSub" TEXT,
    "avatarUrl" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "platformRole" "PlatformRole" NOT NULL DEFAULT 'none',
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT NOT NULL DEFAULT '',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "workspaceId" UUID,
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "AuthTokenKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignInFailure" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID,

    CONSTRAINT "SignInFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAccount" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "billingEmail" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "taxId" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "monthlyPriceCents" INTEGER NOT NULL DEFAULT 0,
    "annualPriceCents" INTEGER NOT NULL DEFAULT 0,
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "limits" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "providerPrices" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "interval" "BillingInterval" NOT NULL DEFAULT 'month',
    "provider" TEXT NOT NULL DEFAULT 'none',
    "providerCustomerId" TEXT,
    "providerSubscriptionId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerInvoiceId" TEXT NOT NULL,
    "number" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "amountDueCents" INTEGER NOT NULL DEFAULT 0,
    "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
    "hostedUrl" TEXT NOT NULL DEFAULT '',
    "pdfUrl" TEXT NOT NULL DEFAULT '',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "billingAccountId" UUID,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "billingAccountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "businessType" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'active',
    "suspendedReason" TEXT NOT NULL DEFAULT '',
    "suspendedAt" TIMESTAMP(3),
    "rolePermissions" JSONB,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "onboarding" JSONB NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT NOT NULL DEFAULT '',
    "industry" TEXT NOT NULL DEFAULT '',
    "size" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "region" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "ownerId" UUID,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "externalSource" TEXT,
    "externalId" TEXT,
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "companyId" UUID,
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "fullName" TEXT NOT NULL DEFAULT '',
    "email" TEXT,
    "phone" TEXT,
    "jobTitle" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "linkedinUrl" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT '',
    "leadSource" TEXT NOT NULL DEFAULT '',
    "ownerId" UUID,
    "priority" "Priority" NOT NULL DEFAULT 'medium',
    "qualification" "Qualification" NOT NULL DEFAULT 'unqualified',
    "status" "ContactStatus" NOT NULL DEFAULT 'new',
    "score" INTEGER,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "lastContactedAt" TIMESTAMP(3),
    "lastRepliedAt" TIMESTAMP(3),
    "nextActionAt" TIMESTAMP(3),
    "nextActionNote" TEXT NOT NULL DEFAULT '',
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribedAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "consentStatus" "ConsentStatus" NOT NULL DEFAULT 'unknown',
    "consentSource" TEXT NOT NULL DEFAULT '',
    "consentAt" TIMESTAMP(3),
    "mergedIntoId" UUID,
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactIdentifier" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "kind" "IdentifierKind" NOT NULL,
    "value" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactSource" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "importId" UUID,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'gray',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactTag" (
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactTag_pkey" PRIMARY KEY ("contactId","tagId")
);

-- CreateTable
CREATE TABLE "CompanyTag" (
    "workspaceId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyTag_pkey" PRIMARY KEY ("companyId","tagId")
);

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedView" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID,
    "entity" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "sort" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID,
    "companyId" UUID,
    "dealId" UUID,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID,
    "companyId" UUID,
    "dealId" UUID,
    "actorId" UUID,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Import" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'pending',
    "fileName" TEXT NOT NULL DEFAULT '',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '{}',
    "rows" JSONB,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "idempotencyKey" TEXT,
    "createdById" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateCandidate" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "duplicateId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" "SuppressionKind" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "StageKind" NOT NULL DEFAULT 'open',
    "probability" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT 'gray',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contactId" UUID,
    "companyId" UUID,
    "ownerId" UUID,
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "expectedCloseDate" DATE,
    "status" "DealStatus" NOT NULL DEFAULT 'open',
    "sourceCampaignId" UUID,
    "wonReason" TEXT NOT NULL DEFAULT '',
    "lostReason" TEXT NOT NULL DEFAULT '',
    "proposalUrl" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealStageChange" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "dealId" UUID NOT NULL,
    "fromStageId" UUID,
    "toStageId" UUID NOT NULL,
    "changedById" UUID,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealStageChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID,
    "dealId" UUID,
    "ownerId" UUID,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "location" TEXT NOT NULL DEFAULT '',
    "status" "MeetingStatus" NOT NULL DEFAULT 'scheduled',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" "TaskType" NOT NULL DEFAULT 'custom',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "TaskStatus" NOT NULL DEFAULT 'open',
    "priority" "Priority" NOT NULL DEFAULT 'medium',
    "dueAt" TIMESTAMP(3),
    "remindAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" UUID,
    "assigneeId" UUID,
    "createdById" UUID,
    "contactId" UUID,
    "dealId" UUID,
    "conversationId" UUID,
    "campaignId" UUID,
    "enrollmentId" UUID,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" "MailboxProvider" NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "status" "ConnectionStatus" NOT NULL DEFAULT 'disconnected',
    "lastError" TEXT NOT NULL DEFAULT '',
    "lastCheckedAt" TIMESTAMP(3),
    "smtpHost" TEXT NOT NULL DEFAULT '',
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpSecurity" TEXT NOT NULL DEFAULT 'starttls',
    "smtpUser" TEXT NOT NULL DEFAULT '',
    "imapEnabled" BOOLEAN NOT NULL DEFAULT true,
    "imapHost" TEXT NOT NULL DEFAULT '',
    "imapPort" INTEGER NOT NULL DEFAULT 993,
    "imapSecurity" TEXT NOT NULL DEFAULT 'ssl',
    "imapUser" TEXT NOT NULL DEFAULT '',
    "secretSealed" TEXT,
    "oauthAccessSealed" TEXT,
    "oauthExpiresAt" TIMESTAMP(3),
    "oauthScope" TEXT NOT NULL DEFAULT '',
    "dailyLimit" INTEGER NOT NULL DEFAULT 50,
    "minDelaySeconds" INTEGER NOT NULL DEFAULT 90,
    "signature" TEXT NOT NULL DEFAULT '',
    "imapUidValidity" TEXT,
    "imapUidNext" INTEGER,
    "lastSyncedAt" TIMESTAMP(3),
    "syncError" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxDailyCount" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "mailboxId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MailboxDailyCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'email',
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "waTemplate" TEXT NOT NULL DEFAULT '',
    "waLanguage" TEXT NOT NULL DEFAULT '',
    "archivedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateVersion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'library',
    "archivedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStep" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "sequenceId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "StepType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "sequenceId" UUID NOT NULL,
    "audience" JSONB NOT NULL DEFAULT '{}',
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "ownerId" UUID,
    "startAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "enrolledCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "positiveReplyCount" INTEGER NOT NULL DEFAULT 0,
    "bounceCount" INTEGER NOT NULL DEFAULT 0,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "unsubscribeCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "statsUpdatedAt" TIMESTAMP(3),
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignMailbox" (
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "mailboxId" UUID NOT NULL,

    CONSTRAINT "CampaignMailbox_pkey" PRIMARY KEY ("campaignId","mailboxId")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'active',
    "position" INTEGER NOT NULL DEFAULT 0,
    "stepRun" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "mailboxId" UUID,
    "threadMessageId" TEXT,
    "threadSubject" TEXT,
    "conversationId" UUID,
    "stopReason" TEXT NOT NULL DEFAULT '',
    "lastError" TEXT NOT NULL DEFAULT '',
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "repliedAt" TIMESTAMP(3),
    "enrolledById" UUID,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepExecution" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "stepType" "StepType" NOT NULL,
    "stepRun" INTEGER NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'running',
    "error" TEXT NOT NULL DEFAULT '',
    "result" JSONB NOT NULL DEFAULT '{}',
    "messageId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "StepExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "contactId" UUID,
    "subject" TEXT NOT NULL DEFAULT '',
    "mailboxId" UUID,
    "channelIntegrationId" UUID,
    "externalKey" TEXT NOT NULL,
    "peer" TEXT NOT NULL DEFAULT '',
    "handle" TEXT NOT NULL DEFAULT '',
    "displayName" TEXT NOT NULL DEFAULT '',
    "assigneeId" UUID,
    "status" "ConversationStatus" NOT NULL DEFAULT 'open',
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "campaignId" UUID,
    "dealId" UUID,
    "lastMessageAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "aiCategory" TEXT NOT NULL DEFAULT '',
    "aiSentiment" TEXT NOT NULL DEFAULT '',
    "aiSummary" TEXT NOT NULL DEFAULT '',
    "aiUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "fromAddress" TEXT NOT NULL DEFAULT '',
    "toAddress" TEXT NOT NULL DEFAULT '',
    "cc" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "bodyText" TEXT NOT NULL DEFAULT '',
    "bodyHtml" TEXT,
    "providerMessageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT,
    "isAutoReply" BOOLEAN NOT NULL DEFAULT false,
    "authorId" UUID,
    "enrollmentId" UUID,
    "campaignId" UUID,
    "mailboxId" UUID,
    "channelIntegrationId" UUID,
    "templateId" UUID,
    "error" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "clickedAt" TIMESTAMP(3),
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "bouncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "providerEventId" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationNote" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelIntegration" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "status" "ConnectionStatus" NOT NULL DEFAULT 'disconnected',
    "lastError" TEXT NOT NULL DEFAULT '',
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretSealed" TEXT,
    "webhookKey" TEXT NOT NULL,
    "externalId" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID,
    "dealId" UUID,
    "taskId" UUID,
    "userId" UUID,
    "integrationId" UUID,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "providerCallId" TEXT,
    "fromNumber" TEXT NOT NULL DEFAULT '',
    "toNumber" TEXT NOT NULL DEFAULT '',
    "status" "CallStatus" NOT NULL DEFAULT 'queued',
    "outcome" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "durationSec" INTEGER,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "recordingUrl" TEXT NOT NULL DEFAULT '',
    "callbackAt" TIMESTAMP(3),
    "scriptId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallScript" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallScript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'pending',
    "subjectType" TEXT NOT NULL DEFAULT '',
    "subjectId" TEXT NOT NULL DEFAULT '',
    "actionIndex" INTEGER NOT NULL DEFAULT 0,
    "resumeAt" TIMESTAMP(3),
    "log" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "approvedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL DEFAULT '',
    "subjectId" TEXT NOT NULL DEFAULT '',
    "actorId" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL DEFAULT '',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" UUID,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "secretSealed" TEXT NOT NULL,
    "events" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "error" TEXT NOT NULL DEFAULT '',
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCache" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "actorUserId" UUID,
    "actorType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT '',
    "targetId" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCase" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "userId" UUID,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "assigneeId" UUID,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportCaseNote" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCaseNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAccessGrant" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "grantedById" UUID NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" UUID NOT NULL,
    "to" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_kind_idx" ON "AuthToken"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "SignInFailure_email_ip_key" ON "SignInFailure"("email", "ip");

-- CreateIndex
CREATE INDEX "BillingAccount_ownerId_idx" ON "BillingAccount"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_key_key" ON "Plan"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_billingAccountId_key" ON "Subscription"("billingAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_providerSubscriptionId_key" ON "Subscription"("providerSubscriptionId");

-- CreateIndex
CREATE INDEX "Invoice_billingAccountId_issuedAt_idx" ON "Invoice"("billingAccountId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_provider_providerInvoiceId_key" ON "Invoice"("provider", "providerInvoiceId");

-- CreateIndex
CREATE INDEX "BillingEvent_billingAccountId_idx" ON "BillingEvent"("billingAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_provider_providerEventId_key" ON "BillingEvent"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "UsageCounter_billingAccountId_metric_period_idx" ON "UsageCounter"("billingAccountId", "metric", "period");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_workspaceId_metric_period_key" ON "UsageCounter"("workspaceId", "metric", "period");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "Workspace_billingAccountId_idx" ON "Workspace"("billingAccountId");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_workspaceId_userId_key" ON "Membership"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_workspaceId_email_idx" ON "Invitation"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "Company_workspaceId_normalizedName_idx" ON "Company"("workspaceId", "normalizedName");

-- CreateIndex
CREATE INDEX "Company_workspaceId_createdAt_idx" ON "Company"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Company_workspaceId_domain_key" ON "Company"("workspaceId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "Company_workspaceId_externalSource_externalId_key" ON "Company"("workspaceId", "externalSource", "externalId");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_createdAt_idx" ON "Contact"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_email_idx" ON "Contact"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_phone_idx" ON "Contact"("workspaceId", "phone");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_ownerId_idx" ON "Contact"("workspaceId", "ownerId");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_status_idx" ON "Contact"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_companyId_idx" ON "Contact"("workspaceId", "companyId");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_nextActionAt_idx" ON "Contact"("workspaceId", "nextActionAt");

-- CreateIndex
CREATE INDEX "ContactIdentifier_contactId_idx" ON "ContactIdentifier"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactIdentifier_workspaceId_kind_value_key" ON "ContactIdentifier"("workspaceId", "kind", "value");

-- CreateIndex
CREATE INDEX "ContactSource_contactId_idx" ON "ContactSource"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactSource_workspaceId_source_externalId_key" ON "ContactSource"("workspaceId", "source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_workspaceId_name_key" ON "Tag"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "ContactTag_workspaceId_tagId_idx" ON "ContactTag"("workspaceId", "tagId");

-- CreateIndex
CREATE INDEX "CompanyTag_workspaceId_tagId_idx" ON "CompanyTag"("workspaceId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_workspaceId_entity_key_key" ON "CustomFieldDefinition"("workspaceId", "entity", "key");

-- CreateIndex
CREATE INDEX "SavedView_workspaceId_entity_idx" ON "SavedView"("workspaceId", "entity");

-- CreateIndex
CREATE INDEX "Note_workspaceId_contactId_idx" ON "Note"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Note_workspaceId_dealId_idx" ON "Note"("workspaceId", "dealId");

-- CreateIndex
CREATE INDEX "Activity_workspaceId_contactId_occurredAt_idx" ON "Activity"("workspaceId", "contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_workspaceId_dealId_occurredAt_idx" ON "Activity"("workspaceId", "dealId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_workspaceId_type_occurredAt_idx" ON "Activity"("workspaceId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "Import_workspaceId_createdAt_idx" ON "Import"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Import_workspaceId_idempotencyKey_key" ON "Import"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "DuplicateCandidate_workspaceId_status_idx" ON "DuplicateCandidate"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateCandidate_workspaceId_contactId_duplicateId_key" ON "DuplicateCandidate"("workspaceId", "contactId", "duplicateId");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_workspaceId_kind_value_key" ON "Suppression"("workspaceId", "kind", "value");

-- CreateIndex
CREATE INDEX "Pipeline_workspaceId_idx" ON "Pipeline"("workspaceId");

-- CreateIndex
CREATE INDEX "PipelineStage_pipelineId_position_idx" ON "PipelineStage"("pipelineId", "position");

-- CreateIndex
CREATE INDEX "Deal_workspaceId_pipelineId_stageId_idx" ON "Deal"("workspaceId", "pipelineId", "stageId");

-- CreateIndex
CREATE INDEX "Deal_workspaceId_ownerId_idx" ON "Deal"("workspaceId", "ownerId");

-- CreateIndex
CREATE INDEX "Deal_workspaceId_contactId_idx" ON "Deal"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Deal_workspaceId_status_closedAt_idx" ON "Deal"("workspaceId", "status", "closedAt");

-- CreateIndex
CREATE INDEX "DealStageChange_dealId_changedAt_idx" ON "DealStageChange"("dealId", "changedAt");

-- CreateIndex
CREATE INDEX "DealStageChange_workspaceId_changedAt_idx" ON "DealStageChange"("workspaceId", "changedAt");

-- CreateIndex
CREATE INDEX "Meeting_workspaceId_startsAt_idx" ON "Meeting"("workspaceId", "startsAt");

-- CreateIndex
CREATE INDEX "Meeting_workspaceId_contactId_idx" ON "Meeting"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Task_workspaceId_assigneeId_status_dueAt_idx" ON "Task"("workspaceId", "assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_workspaceId_status_dueAt_idx" ON "Task"("workspaceId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_workspaceId_contactId_idx" ON "Task"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Task_status_remindAt_idx" ON "Task"("status", "remindAt");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_workspaceId_email_key" ON "Mailbox"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "MailboxDailyCount_workspaceId_day_idx" ON "MailboxDailyCount"("workspaceId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxDailyCount_mailboxId_day_key" ON "MailboxDailyCount"("mailboxId", "day");

-- CreateIndex
CREATE INDEX "Template_workspaceId_channel_idx" ON "Template"("workspaceId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateVersion_templateId_version_key" ON "TemplateVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "Sequence_workspaceId_kind_idx" ON "Sequence"("workspaceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceStep_sequenceId_position_key" ON "SequenceStep"("sequenceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_sequenceId_key" ON "Campaign"("sequenceId");

-- CreateIndex
CREATE INDEX "Campaign_workspaceId_status_idx" ON "Campaign"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Enrollment_status_nextRunAt_idx" ON "Enrollment"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "Enrollment_workspaceId_contactId_idx" ON "Enrollment"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Enrollment_campaignId_status_idx" ON "Enrollment"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_campaignId_contactId_key" ON "Enrollment"("campaignId", "contactId");

-- CreateIndex
CREATE INDEX "StepExecution_campaignId_position_status_idx" ON "StepExecution"("campaignId", "position", "status");

-- CreateIndex
CREATE INDEX "StepExecution_workspaceId_startedAt_idx" ON "StepExecution"("workspaceId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StepExecution_enrollmentId_stepRun_key" ON "StepExecution"("enrollmentId", "stepRun");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_lastMessageAt_idx" ON "Conversation"("workspaceId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_contactId_idx" ON "Conversation"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_assigneeId_status_idx" ON "Conversation"("workspaceId", "assigneeId", "status");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_channel_unread_idx" ON "Conversation"("workspaceId", "channel", "unread");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_workspaceId_externalKey_key" ON "Conversation"("workspaceId", "externalKey");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_workspaceId_campaignId_idx" ON "Message"("workspaceId", "campaignId");

-- CreateIndex
CREATE INDEX "Message_workspaceId_direction_createdAt_idx" ON "Message"("workspaceId", "direction", "createdAt");

-- CreateIndex
CREATE INDEX "Message_enrollmentId_idx" ON "Message"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_workspaceId_channel_providerMessageId_key" ON "Message"("workspaceId", "channel", "providerMessageId");

-- CreateIndex
CREATE INDEX "MessageEvent_messageId_idx" ON "MessageEvent"("messageId");

-- CreateIndex
CREATE INDEX "MessageEvent_workspaceId_type_occurredAt_idx" ON "MessageEvent"("workspaceId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageEvent_workspaceId_providerEventId_key" ON "MessageEvent"("workspaceId", "providerEventId");

-- CreateIndex
CREATE INDEX "ConversationNote_conversationId_idx" ON "ConversationNote"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelIntegration_webhookKey_key" ON "ChannelIntegration"("webhookKey");

-- CreateIndex
CREATE INDEX "ChannelIntegration_workspaceId_channel_idx" ON "ChannelIntegration"("workspaceId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelIntegration_provider_externalId_key" ON "ChannelIntegration"("provider", "externalId");

-- CreateIndex
CREATE INDEX "Call_workspaceId_createdAt_idx" ON "Call"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Call_workspaceId_userId_createdAt_idx" ON "Call"("workspaceId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "Call_workspaceId_contactId_idx" ON "Call"("workspaceId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Call_provider_providerCallId_key" ON "Call"("provider", "providerCallId");

-- CreateIndex
CREATE INDEX "CallScript_workspaceId_idx" ON "CallScript"("workspaceId");

-- CreateIndex
CREATE INDEX "Workflow_workspaceId_trigger_enabled_idx" ON "Workflow"("workspaceId", "trigger", "enabled");

-- CreateIndex
CREATE INDEX "WorkflowRun_status_resumeAt_idx" ON "WorkflowRun"("status", "resumeAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_workspaceId_createdAt_idx" ON "WorkflowRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_workflowId_eventId_key" ON "WorkflowRun"("workflowId", "eventId");

-- CreateIndex
CREATE INDEX "DomainEvent_dispatchedAt_occurredAt_idx" ON "DomainEvent"("dispatchedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "DomainEvent_workspaceId_type_occurredAt_idx" ON "DomainEvent"("workspaceId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "Notification_workspaceId_userId_readAt_idx" ON "Notification"("workspaceId", "userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_workspaceId_idx" ON "ApiKey"("workspaceId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_workspaceId_idx" ON "WebhookEndpoint"("workspaceId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_workspaceId_createdAt_idx" ON "WebhookDelivery"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_endpointId_eventId_key" ON "WebhookDelivery"("endpointId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_workspaceId_key_key" ON "IdempotencyKey"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "AiUsage_workspaceId_createdAt_idx" ON "AiUsage"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiCache_workspaceId_key_key" ON "AiCache"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_createdAt_idx" ON "AuditEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "SupportCase_status_createdAt_idx" ON "SupportCase"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SupportCase_workspaceId_idx" ON "SupportCase"("workspaceId");

-- CreateIndex
CREATE INDEX "SupportCaseNote_caseId_idx" ON "SupportCaseNote"("caseId");

-- CreateIndex
CREATE INDEX "SupportAccessGrant_workspaceId_expiresAt_idx" ON "SupportAccessGrant"("workspaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "EmailLog_createdAt_idx" ON "EmailLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignInFailure" ADD CONSTRAINT "SignInFailure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAccount" ADD CONSTRAINT "BillingAccount_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactIdentifier" ADD CONSTRAINT "ContactIdentifier_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactIdentifier" ADD CONSTRAINT "ContactIdentifier_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactSource" ADD CONSTRAINT "ContactSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactSource" ADD CONSTRAINT "ContactSource_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyTag" ADD CONSTRAINT "CompanyTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyTag" ADD CONSTRAINT "CompanyTag_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyTag" ADD CONSTRAINT "CompanyTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldDefinition" ADD CONSTRAINT "CustomFieldDefinition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Import" ADD CONSTRAINT "Import_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_sourceCampaignId_fkey" FOREIGN KEY ("sourceCampaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealStageChange" ADD CONSTRAINT "DealStageChange_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealStageChange" ADD CONSTRAINT "DealStageChange_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxDailyCount" ADD CONSTRAINT "MailboxDailyCount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxDailyCount" ADD CONSTRAINT "MailboxDailyCount_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sequence" ADD CONSTRAINT "Sequence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMailbox" ADD CONSTRAINT "CampaignMailbox_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMailbox" ADD CONSTRAINT "CampaignMailbox_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMailbox" ADD CONSTRAINT "CampaignMailbox_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepExecution" ADD CONSTRAINT "StepExecution_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepExecution" ADD CONSTRAINT "StepExecution_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_channelIntegrationId_fkey" FOREIGN KEY ("channelIntegrationId") REFERENCES "ChannelIntegration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageEvent" ADD CONSTRAINT "MessageEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageEvent" ADD CONSTRAINT "MessageEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelIntegration" ADD CONSTRAINT "ChannelIntegration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallScript" ADD CONSTRAINT "CallScript_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCache" ADD CONSTRAINT "AiCache_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportCaseNote" ADD CONSTRAINT "SupportCaseNote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "SupportCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
