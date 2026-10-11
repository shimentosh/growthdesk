-- AlterTable
ALTER TABLE "Mailbox" ADD COLUMN     "imapFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "imapFailedUid" INTEGER,
ADD COLUMN     "imapJunkState" JSONB;
