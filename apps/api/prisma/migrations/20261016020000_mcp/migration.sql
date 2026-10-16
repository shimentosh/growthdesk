-- MCP access for Claude and other AI clients (src/mcp, docs/MCP.md): personal tokens,
-- two-step confirmations, the call log, and the OAuth 2.1 client/code tables.
-- CreateEnum
CREATE TYPE "McpAccess" AS ENUM ('read', 'build', 'send');

-- CreateTable
CREATE TABLE "McpToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "access" "McpAccess" NOT NULL,
    "clientName" TEXT,
    "oauthClientId" TEXT,
    "refreshTokenHash" TEXT,
    "refreshExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpPendingAction" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "tokenId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "preview" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "result" JSONB,

    CONSTRAINT "McpPendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpCall" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "tokenId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthCode" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "access" "McpAccess" NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
    "scope" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpOAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_tokenHash_key" ON "McpToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_refreshTokenHash_key" ON "McpToken"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "McpToken_workspaceId_userId_idx" ON "McpToken"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "McpToken_userId_idx" ON "McpToken"("userId");

-- CreateIndex
CREATE INDEX "McpToken_oauthClientId_idx" ON "McpToken"("oauthClientId");

-- CreateIndex
CREATE INDEX "McpPendingAction_workspaceId_tokenId_createdAt_idx" ON "McpPendingAction"("workspaceId", "tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "McpPendingAction_expiresAt_idx" ON "McpPendingAction"("expiresAt");

-- CreateIndex
CREATE INDEX "McpCall_workspaceId_createdAt_idx" ON "McpCall"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "McpCall_tokenId_createdAt_idx" ON "McpCall"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "McpCall_createdAt_idx" ON "McpCall"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthCode_codeHash_key" ON "McpOAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "McpOAuthCode_clientId_idx" ON "McpOAuthCode"("clientId");

-- CreateIndex
CREATE INDEX "McpOAuthCode_workspaceId_idx" ON "McpOAuthCode"("workspaceId");

-- CreateIndex
CREATE INDEX "McpOAuthCode_expiresAt_idx" ON "McpOAuthCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpPendingAction" ADD CONSTRAINT "McpPendingAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpPendingAction" ADD CONSTRAINT "McpPendingAction_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "McpToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpCall" ADD CONSTRAINT "McpCall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpCall" ADD CONSTRAINT "McpCall_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "McpToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthCode" ADD CONSTRAINT "McpOAuthCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthCode" ADD CONSTRAINT "McpOAuthCode_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

