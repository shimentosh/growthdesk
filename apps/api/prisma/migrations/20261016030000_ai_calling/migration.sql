-- AI calling (src/ai-calling, packages/shared/src/ai-calling.ts): voice agents
-- that place calls through Cartesia, the ai_call sequence step, and the
-- transcript / summary / analysis an AI call comes back with.

-- AlterEnum
ALTER TYPE "StepType" ADD VALUE 'ai_call' AFTER 'call_task';

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "agentId" UUID,
ADD COLUMN     "analysis" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "campaignId" UUID,
ADD COLUMN     "endReason" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "enrollmentId" UUID,
ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "summary" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "transcript" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "CallAgent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL DEFAULT '',
    "goal" TEXT NOT NULL DEFAULT 'book_meeting',
    "language" TEXT NOT NULL DEFAULT 'en',
    "voiceId" TEXT NOT NULL,
    "voiceName" TEXT NOT NULL DEFAULT '',
    "personaName" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "greeting" TEXT NOT NULL,
    "disclosure" TEXT NOT NULL,
    "about" TEXT NOT NULL,
    "goalDetails" TEXT NOT NULL DEFAULT '',
    "questions" JSONB NOT NULL DEFAULT '[]',
    "objections" JSONB NOT NULL DEFAULT '[]',
    "voicemailMessage" TEXT NOT NULL DEFAULT '',
    "extraInstructions" TEXT NOT NULL DEFAULT '',
    "transferNumber" TEXT NOT NULL DEFAULT '',
    "maxCallMinutes" INTEGER NOT NULL DEFAULT 5,
    "integrationId" UUID,
    "providerAgentId" TEXT,
    "syncedAt" TIMESTAMP(3),
    "syncError" TEXT NOT NULL DEFAULT '',
    "archivedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallAgent_workspaceId_archivedAt_idx" ON "CallAgent"("workspaceId", "archivedAt");

-- CreateIndex
CREATE INDEX "Call_workspaceId_agentId_createdAt_idx" ON "Call"("workspaceId", "agentId", "createdAt");

-- CreateIndex
CREATE INDEX "Call_provider_status_createdAt_idx" ON "Call"("provider", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "CallAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAgent" ADD CONSTRAINT "CallAgent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
