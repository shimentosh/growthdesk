-- Sales suite: calendar connections and booking pages, forecast targets and deal
-- forecast fields, stale-deal settings, products and quotes (with e-signature),
-- lead scoring rules and score breakdown, and file attachments.
-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "scoreBreakdown" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "scoreEngagement" INTEGER,
ADD COLUMN     "scoreFit" INTEGER,
ADD COLUMN     "scoreUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "forecastCategory" TEXT NOT NULL DEFAULT 'pipeline',
ADD COLUMN     "nextStep" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "nextStepAt" TIMESTAMP(3),
ADD COLUMN     "staleNotifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "answers" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "attendeeEmail" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "attendeeName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "bookingPageId" UUID,
ADD COLUMN     "calendarConnectionId" UUID,
ADD COLUMN     "cancelReason" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "canceledAt" TIMESTAMP(3),
ADD COLUMN     "conferenceUrl" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "externalEventId" TEXT,
ADD COLUMN     "manageToken" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "PipelineStage" ADD COLUMN     "rotDays" INTEGER;

-- CreateTable
CREATE TABLE "CalendarConnection" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "secretSealed" TEXT,
    "accessSealed" TEXT,
    "accessExpiresAt" TIMESTAMP(3),
    "scope" TEXT NOT NULL DEFAULT '',
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "busyCalendarIds" JSONB NOT NULL DEFAULT '[]',
    "status" "ConnectionStatus" NOT NULL DEFAULT 'connected',
    "lastError" TEXT NOT NULL DEFAULT '',
    "lastSyncedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingPage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "assignment" TEXT NOT NULL DEFAULT 'single',
    "hostUserIds" JSONB NOT NULL DEFAULT '[]',
    "roundRobinCursor" INTEGER NOT NULL DEFAULT 0,
    "availability" JSONB NOT NULL DEFAULT '{}',
    "bufferBeforeMinutes" INTEGER NOT NULL DEFAULT 0,
    "bufferAfterMinutes" INTEGER NOT NULL DEFAULT 0,
    "minNoticeMinutes" INTEGER NOT NULL DEFAULT 240,
    "maxDaysAhead" INTEGER NOT NULL DEFAULT 30,
    "slotStepMinutes" INTEGER NOT NULL DEFAULT 30,
    "locationType" TEXT NOT NULL DEFAULT 'google_meet',
    "locationDetail" TEXT NOT NULL DEFAULT '',
    "questions" JSONB NOT NULL DEFAULT '[]',
    "confirmationMessage" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesTarget" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID,
    "periodType" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "metric" TEXT NOT NULL DEFAULT 'revenue_won',
    "target" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "billingPeriod" TEXT NOT NULL DEFAULT 'one_time',
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "dealId" UUID,
    "contactId" UUID,
    "companyId" UUID,
    "ownerId" UUID,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "validUntil" DATE,
    "intro" TEXT NOT NULL DEFAULT '',
    "terms" TEXT NOT NULL DEFAULT '',
    "publicToken" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "firstViewedAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedAt" TIMESTAMP(3),
    "signerName" TEXT NOT NULL DEFAULT '',
    "signerEmail" TEXT NOT NULL DEFAULT '',
    "signerTitle" TEXT NOT NULL DEFAULT '',
    "signatureData" TEXT NOT NULL DEFAULT '',
    "signerIp" TEXT NOT NULL DEFAULT '',
    "signerUserAgent" TEXT NOT NULL DEFAULT '',
    "documentHash" TEXT NOT NULL DEFAULT '',
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLineItem" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "productId" UUID,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "billingPeriod" TEXT NOT NULL DEFAULT 'one_time',
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoringRule" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "field" TEXT NOT NULL DEFAULT '',
    "op" TEXT NOT NULL DEFAULT '',
    "value" TEXT NOT NULL DEFAULT '',
    "event" TEXT NOT NULL DEFAULT '',
    "points" INTEGER NOT NULL,
    "maxPoints" INTEGER,
    "decayDays" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoringRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "uploadedById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarConnection_workspaceId_userId_idx" ON "CalendarConnection"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPage_slug_key" ON "BookingPage"("slug");

-- CreateIndex
CREATE INDEX "BookingPage_workspaceId_idx" ON "BookingPage"("workspaceId");

-- CreateIndex
CREATE INDEX "SalesTarget_workspaceId_periodStart_idx" ON "SalesTarget"("workspaceId", "periodStart");

-- CreateIndex
CREATE INDEX "Product_workspaceId_archivedAt_idx" ON "Product"("workspaceId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_publicToken_key" ON "Quote"("publicToken");

-- CreateIndex
CREATE INDEX "Quote_workspaceId_dealId_idx" ON "Quote"("workspaceId", "dealId");

-- CreateIndex
CREATE INDEX "Quote_workspaceId_status_idx" ON "Quote"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_workspaceId_number_key" ON "Quote"("workspaceId", "number");

-- CreateIndex
CREATE INDEX "QuoteLineItem_quoteId_position_idx" ON "QuoteLineItem"("quoteId", "position");

-- CreateIndex
CREATE INDEX "ScoringRule_workspaceId_idx" ON "ScoringRule"("workspaceId");

-- CreateIndex
CREATE INDEX "Attachment_workspaceId_entityType_entityId_idx" ON "Attachment"("workspaceId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_manageToken_key" ON "Meeting"("manageToken");

-- CreateIndex
CREATE INDEX "Meeting_workspaceId_ownerId_startsAt_idx" ON "Meeting"("workspaceId", "ownerId", "startsAt");

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_bookingPageId_fkey" FOREIGN KEY ("bookingPageId") REFERENCES "BookingPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPage" ADD CONSTRAINT "BookingPage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTarget" ADD CONSTRAINT "SalesTarget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLineItem" ADD CONSTRAINT "QuoteLineItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLineItem" ADD CONSTRAINT "QuoteLineItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLineItem" ADD CONSTRAINT "QuoteLineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoringRule" ADD CONSTRAINT "ScoringRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

