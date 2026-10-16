-- API keys created from Settings → Integrations name the app they connect ("clientdesk", "business_os"). Additive only.
ALTER TABLE "ApiKey" ADD COLUMN "app" TEXT NOT NULL DEFAULT '';
