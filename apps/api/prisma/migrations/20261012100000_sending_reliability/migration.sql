-- AlterTable
ALTER TABLE "Mailbox" ADD COLUMN     "nextSendAt" TIMESTAMP(3),
ADD COLUMN     "sendFailures" INTEGER NOT NULL DEFAULT 0;
