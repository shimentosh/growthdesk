import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module.js";
import { LifecycleController } from "./lifecycle.controller.js";
import { WorkspaceLifecycleService } from "./workspace-lifecycle.service.js";
import { WorkspaceExportService } from "./workspace-export.service.js";
import { ContactPrivacyService } from "./contact-privacy.service.js";
import { AccountService } from "./account.service.js";

/** Account lifecycle and GDPR: workspace deletion/restore/purge, ownership transfer, exports, contact erasure, closing an account. */
@Module({
  imports: [BillingModule],
  controllers: [LifecycleController],
  providers: [WorkspaceLifecycleService, WorkspaceExportService, ContactPrivacyService, AccountService],
  exports: [WorkspaceLifecycleService, WorkspaceExportService, ContactPrivacyService, AccountService],
})
export class LifecycleModule {}
