-- Email design themes, and the built-in template / design library.
ALTER TABLE "EmailDesign" ADD COLUMN "theme" JSONB NOT NULL DEFAULT '{}', ADD COLUMN "libraryKey" TEXT;
ALTER TABLE "MarketingCampaign" ADD COLUMN "theme" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Template" ADD COLUMN "libraryKey" TEXT;

CREATE TABLE "LibrarySeed" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LibrarySeed_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LibrarySeed_workspaceId_kind_key_key" ON "LibrarySeed"("workspaceId", "kind", "key");
ALTER TABLE "LibrarySeed" ADD CONSTRAINT "LibrarySeed_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
