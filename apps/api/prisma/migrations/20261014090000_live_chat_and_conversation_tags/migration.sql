-- Website live chat (a "web" channel: ChatVisitor + ChannelIntegration provider web_widget) and conversation tags.
-- AlterEnum
ALTER TYPE "Channel" ADD VALUE 'web';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "chatVisitorId" UUID;

-- CreateTable
CREATE TABLE "ConversationTag" (
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationTag_pkey" PRIMARY KEY ("conversationId","tagId")
);

-- CreateTable
CREATE TABLE "ChatVisitor" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channelIntegrationId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "contactId" UUID,
    "pageUrl" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatVisitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationTag_workspaceId_tagId_idx" ON "ConversationTag"("workspaceId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatVisitor_tokenHash_key" ON "ChatVisitor"("tokenHash");

-- CreateIndex
CREATE INDEX "ChatVisitor_workspaceId_channelIntegrationId_idx" ON "ChatVisitor"("workspaceId", "channelIntegrationId");

-- CreateIndex
CREATE INDEX "ChatVisitor_contactId_idx" ON "ChatVisitor"("contactId");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_campaignId_idx" ON "Conversation"("workspaceId", "campaignId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_chatVisitorId_fkey" FOREIGN KEY ("chatVisitorId") REFERENCES "ChatVisitor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTag" ADD CONSTRAINT "ConversationTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTag" ADD CONSTRAINT "ConversationTag_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTag" ADD CONSTRAINT "ConversationTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatVisitor" ADD CONSTRAINT "ChatVisitor_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatVisitor" ADD CONSTRAINT "ChatVisitor_channelIntegrationId_fkey" FOREIGN KEY ("channelIntegrationId") REFERENCES "ChannelIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

