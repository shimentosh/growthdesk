-- GAP_PLAN 2.2: an outgoing webhook is paused for review when the person who set it up leaves.
ALTER TABLE "WebhookEndpoint" ADD COLUMN "createdById" UUID;

-- Existing endpoints: whoever created them or last changed their URL, from the audit trail.
UPDATE "WebhookEndpoint" e
SET "createdById" = a."actorUserId"
FROM (
  SELECT DISTINCT ON ("targetId") "targetId", "actorUserId"
  FROM "AuditEvent"
  WHERE "targetType" = 'webhook_endpoint'
    AND "actorUserId" IS NOT NULL
    AND ("action" = 'webhook.created' OR ("action" = 'webhook.updated' AND "metadata" -> 'fields' ? 'url'))
  ORDER BY "targetId", "createdAt" DESC
) a
WHERE a."targetId" = e."id"::text;
