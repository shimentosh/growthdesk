-- Resend as a marketing email service: the provider, and the domain records it manages.
-- AlterEnum
ALTER TYPE "EspProvider" ADD VALUE 'resend';

-- AlterTable
ALTER TABLE "SendingDomain" ADD COLUMN     "espDomainId" TEXT,
ADD COLUMN     "espRecords" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "espStatus" TEXT NOT NULL DEFAULT '';
