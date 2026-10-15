-- Uploaded images for marketing emails (WorkspaceAsset), and double opt-in for lead lists.
-- AlterTable
ALTER TABLE "ListMembership" ADD COLUMN     "confirmSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MarketingList" ADD COLUMN     "doubleOptIn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "WorkspaceAsset" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "fileName" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceAsset_workspaceId_sha256_idx" ON "WorkspaceAsset"("workspaceId", "sha256");

-- AddForeignKey
ALTER TABLE "WorkspaceAsset" ADD CONSTRAINT "WorkspaceAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

