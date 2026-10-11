-- docs/GAP_PLAN.md 6.2 and 6.9: indexes for the daily cleanup and retention
-- deletes, the cross-tenant task.overdue sweep, and Task.overdueSentAt.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "overdueSentAt" TIMESTAMP(3);

-- Tasks already announced keep their place: the sweep now reads the flag, not the events
-- (which the retention job prunes).
UPDATE "Task" t SET "overdueSentAt" = e."occurredAt"
FROM (SELECT "subjectId", max("occurredAt") AS "occurredAt" FROM "DomainEvent" WHERE "type" = 'task.overdue' GROUP BY "subjectId") e
WHERE e."subjectId" = t."id"::text;

-- CreateIndex
CREATE INDEX "Activity_type_occurredAt_idx" ON "Activity"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "AiCache_expiresAt_idx" ON "AiCache"("expiresAt");

-- CreateIndex
CREATE INDEX "AiUsage_createdAt_idx" ON "AiUsage"("createdAt");

-- CreateIndex
CREATE INDEX "AuthToken_expiresAt_idx" ON "AuthToken"("expiresAt");

-- CreateIndex
CREATE INDEX "BillingEvent_receivedAt_idx" ON "BillingEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "DomainEvent_type_subjectId_idx" ON "DomainEvent"("type", "subjectId");

-- CreateIndex
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");

-- CreateIndex
CREATE INDEX "MailboxDailyCount_day_idx" ON "MailboxDailyCount"("day");

-- CreateIndex
CREATE INDEX "MessageEvent_occurredAt_idx" ON "MessageEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_revokedAt_idx" ON "Session"("revokedAt");

-- CreateIndex
CREATE INDEX "SignInFailure_lastAt_idx" ON "SignInFailure"("lastAt");

-- CreateIndex
CREATE INDEX "Task_status_dueAt_idx" ON "Task"("status", "dueAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_createdAt_idx" ON "WebhookDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_finishedAt_idx" ON "WorkflowRun"("finishedAt");
