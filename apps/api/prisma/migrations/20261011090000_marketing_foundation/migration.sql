-- CreateEnum
CREATE TYPE "SuppressionScope" AS ENUM ('all', 'outreach', 'marketing');

-- DropIndex
DROP INDEX "Suppression_workspaceId_kind_value_key";

-- AlterTable
ALTER TABLE "Suppression" ADD COLUMN     "scope" "SuppressionScope" NOT NULL DEFAULT 'all';

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "legalName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "marketingFromName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "marketingReplyTo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "postalAddress" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "ConsentEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentEvent_workspaceId_contactId_createdAt_idx" ON "ConsentEvent"("workspaceId", "contactId", "createdAt");

-- CreateIndex
CREATE INDEX "Suppression_workspaceId_kind_value_idx" ON "Suppression"("workspaceId", "kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_workspaceId_scope_kind_value_key" ON "Suppression"("workspaceId", "scope", "kind", "value");

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing suppressions predate the scope split and stay `all` (the default):
-- an unsubscribe recorded before marketing existed keeps stopping every engine.

-- Seed the consent history with each contact's current, already-recorded consent.
INSERT INTO "ConsentEvent" ("id", "workspaceId", "contactId", "status", "source", "detail", "createdAt")
SELECT uuidv7(), c."workspaceId", c."id", c."consentStatus", c."consentSource", '{"via":"backfill"}'::jsonb, COALESCE(c."consentAt", c."updatedAt")
FROM "Contact" c
WHERE c."consentStatus" <> 'unknown';
