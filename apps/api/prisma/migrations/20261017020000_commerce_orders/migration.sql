-- Orders from a connected store or client portal (src/commerce, Clientdesk), and each contact's order totals. Additive only.
-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "customerSince" TIMESTAMP(3),
ADD COLUMN     "firstOrderAt" TIMESTAMP(3),
ADD COLUMN     "lastOrderAt" TIMESTAMP(3),
ADD COLUMN     "lastPurchase" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "ordersCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paidOrdersCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "spentCurrency" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "totalSpent" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "number" TEXT NOT NULL DEFAULT '',
    "contactId" UUID,
    "companyId" UUID,
    "status" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'open',
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "placedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "data" JSONB NOT NULL DEFAULT '{}',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_workspaceId_contactId_placedAt_idx" ON "Order"("workspaceId", "contactId", "placedAt");

-- CreateIndex
CREATE INDEX "Order_workspaceId_companyId_idx" ON "Order"("workspaceId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_workspaceId_source_externalId_key" ON "Order"("workspaceId", "source", "externalId");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_paidOrdersCount_idx" ON "Contact"("workspaceId", "paidOrdersCount");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

