-- AlterTable
ALTER TABLE "User" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" UUID,
ADD COLUMN     "purgeAfter" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WorkspaceExport" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "requestedById" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fileName" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceExport_workspaceId_createdAt_idx" ON "WorkspaceExport"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceExport_status_expiresAt_idx" ON "WorkspaceExport"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Workspace_purgeAfter_idx" ON "Workspace"("purgeAfter");

-- AddForeignKey
ALTER TABLE "WorkspaceExport" ADD CONSTRAINT "WorkspaceExport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

