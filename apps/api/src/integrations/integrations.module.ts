import { Module } from "@nestjs/common";
import { CampaignsModule } from "../campaigns/campaigns.module.js";
import { IntegrationsController } from "./integrations.controller.js";
import { ApiKeysService } from "./api-keys.service.js";
import { IdempotencyService } from "./idempotency.service.js";
import { LeadIngestService } from "./lead-ingest.service.js";

/**
 * API keys, Business OS lead ingest and the public API. Keys are verified by
 * AccessGuard (src/common/access.guard.ts) on routes marked `@ApiKeyScope`;
 * this module issues and revokes them and owns the ingest endpoint.
 * CampaignsModule provides CampaignsService for enrolling ingested leads.
 */
@Module({
  imports: [CampaignsModule],
  controllers: [IntegrationsController],
  providers: [ApiKeysService, IdempotencyService, LeadIngestService],
  exports: [ApiKeysService, IdempotencyService],
})
export class IntegrationsModule {}
