import { Module } from "@nestjs/common";
import { AttachmentsController } from "./attachments.controller.js";
import { AttachmentsService } from "./attachments.service.js";

/** Files attached to contacts, companies, deals and quotes. CRM (activity) and core (audit) are global. */
@Module({
  imports: [],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
