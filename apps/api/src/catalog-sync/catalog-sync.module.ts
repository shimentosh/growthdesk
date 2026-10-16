import { Module } from "@nestjs/common";
import { CatalogSyncController } from "./catalog-sync.controller.js";
import { CatalogSyncService } from "./catalog-sync.service.js";

/** Products kept in step with another system's catalog (the Clientdesk client portal's services). */
@Module({
  controllers: [CatalogSyncController],
  providers: [CatalogSyncService],
  exports: [CatalogSyncService],
})
export class CatalogSyncModule {}
