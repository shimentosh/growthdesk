-- The admin-managed email design template library (PlatformEmailDesign).
-- CreateEnum
CREATE TYPE "PlatformEmailDesignStatus" AS ENUM ('draft', 'published');

-- CreateTable
CREATE TABLE "PlatformEmailDesign" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "theme" JSONB NOT NULL DEFAULT '{}',
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "status" "PlatformEmailDesignStatus" NOT NULL DEFAULT 'draft',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PlatformEmailDesign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformEmailDesign_key_key" ON "PlatformEmailDesign"("key");

-- CreateIndex
CREATE INDEX "PlatformEmailDesign_status_deletedAt_sortOrder_idx" ON "PlatformEmailDesign"("status", "deletedAt", "sortOrder");
