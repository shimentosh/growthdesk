-- Products synced from another system (e.g. the Clientdesk client portal's service catalog).
ALTER TABLE "Product" ADD COLUMN "category" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN "groupName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN "unit" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN "costPrice" DECIMAL(14,2);
ALTER TABLE "Product" ADD COLUMN "source" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Product" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Product" ADD COLUMN "syncedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Product_workspaceId_source_externalId_key" ON "Product"("workspaceId", "source", "externalId");
