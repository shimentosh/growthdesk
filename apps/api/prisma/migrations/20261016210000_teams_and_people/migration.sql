-- Teams (who sees whose work, routing pools, reporting), per-person inbox reads, and people details: title, phone, out of office, deactivation, invitation notes.

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "message" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "deactivatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "outOfOfficeUntil" TIMESTAMP(3),
ADD COLUMN     "phone" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "title" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT 'blue',
    "leadUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "teamId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("teamId","userId")
);

-- CreateTable
CREATE TABLE "ConversationRead" (
    "conversationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationRead_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Team_workspaceId_name_key" ON "Team"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "TeamMember_workspaceId_userId_idx" ON "TeamMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "ConversationRead_workspaceId_userId_idx" ON "ConversationRead"("workspaceId", "userId");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Conversations already read stay read for everyone who could see them when "unread" was shared.
INSERT INTO "ConversationRead" ("conversationId", "userId", "workspaceId", "readAt")
SELECT c."id", m."userId", c."workspaceId", CURRENT_TIMESTAMP
FROM "Conversation" c
JOIN "Membership" m ON m."workspaceId" = c."workspaceId"
WHERE c."unread" = false
ON CONFLICT DO NOTHING;
