-- AlterTable
ALTER TABLE "BillingAccount" ADD COLUMN     "signupIp" TEXT,
ADD COLUMN     "trialEmailKey" TEXT,
ADD COLUMN     "trialGrantedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "BillingAccount_trialEmailKey_idx" ON "BillingAccount"("trialEmailKey");

-- CreateIndex
CREATE INDEX "BillingAccount_signupIp_createdAt_idx" ON "BillingAccount"("signupIp", "createdAt");

-- Backfill: existing accounts are keyed by their owner's normalised email (the same rule as
-- billing/trial-guard.ts) and count as having had their trial, so a fresh signup with an alias
-- of an existing owner's address does not get another one.
UPDATE "BillingAccount" b
SET "trialEmailKey" = CASE
      WHEN lower(split_part(u."email", '@', 2)) IN ('gmail.com', 'googlemail.com')
        THEN replace(split_part(lower(split_part(u."email", '@', 1)), '+', 1), '.', '') || '@gmail.com'
      ELSE split_part(lower(split_part(u."email", '@', 1)), '+', 1) || '@' || lower(split_part(u."email", '@', 2))
    END,
    "trialGrantedAt" = b."createdAt"
FROM "User" u
WHERE u."id" = b."ownerId";
