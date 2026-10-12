-- Lead → sales → contact lifecycle, and archiving people.
CREATE TYPE "LifecycleStage" AS ENUM ('lead', 'sales', 'contact');

ALTER TABLE "Contact"
  ADD COLUMN "lifecycleStage" "LifecycleStage" NOT NULL DEFAULT 'lead',
  ADD COLUMN "stageChangedAt" TIMESTAMP(3),
  ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Backfill from what is already known: customers, won deals and held meetings
-- are contacts; qualified people, open deals and booked meetings are in sales.
UPDATE "Contact" c SET "lifecycleStage" = 'contact', "stageChangedAt" = now()
WHERE c.status = 'customer'
   OR EXISTS (SELECT 1 FROM "Deal" d WHERE d."contactId" = c.id AND d.status = 'won' AND d."deletedAt" IS NULL)
   OR EXISTS (SELECT 1 FROM "Meeting" m WHERE m."contactId" = c.id AND m.status = 'completed');

UPDATE "Contact" c SET "lifecycleStage" = 'sales', "stageChangedAt" = now()
WHERE c."lifecycleStage" = 'lead' AND (
     c.qualification = 'qualified'
  OR EXISTS (SELECT 1 FROM "Deal" d WHERE d."contactId" = c.id AND d.status = 'open' AND d."deletedAt" IS NULL)
  OR EXISTS (SELECT 1 FROM "Meeting" m WHERE m."contactId" = c.id AND m.status = 'scheduled'));

CREATE INDEX "Contact_workspaceId_lifecycleStage_idx" ON "Contact"("workspaceId", "lifecycleStage");
