-- A workspace may use its own Discord application (bring your own bot) instead of the installation's. Additive only.
ALTER TABLE "DiscordSettings" ADD COLUMN "appClientId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "DiscordSettings" ADD COLUMN "appClientSecretSealed" TEXT NOT NULL DEFAULT '';
ALTER TABLE "DiscordSettings" ADD COLUMN "appBotTokenSealed" TEXT NOT NULL DEFAULT '';
