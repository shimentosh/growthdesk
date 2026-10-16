-- Who acted, on every timeline entry: a person, an AI agent, a workflow, an integration or the system.
-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "actorName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "actorRef" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "actorType" TEXT NOT NULL DEFAULT 'system',
ADD COLUMN     "onBehalfOfId" UUID;

-- Existing entries with a person on them were that person's.
UPDATE "Activity" SET "actorType" = 'user' WHERE "actorId" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Activity_workspaceId_occurredAt_idx" ON "Activity"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_workspaceId_actorId_occurredAt_idx" ON "Activity"("workspaceId", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_workspaceId_actorType_occurredAt_idx" ON "Activity"("workspaceId", "actorType", "occurredAt");
