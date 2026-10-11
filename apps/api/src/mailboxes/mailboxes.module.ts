import { Module } from "@nestjs/common";
import { MailboxesController, MailboxOAuthCallbackController } from "./mailboxes.controller.js";
import { MailboxesService } from "./mailboxes.service.js";
import { MailboxOAuthService } from "./mailbox-oauth.service.js";
import { InboundEmailService } from "./inbound-email.service.js";
import { ImapSyncService } from "./imap-sync.service.js";

/**
 * Mailboxes: connect (SMTP/IMAP, Gmail, Microsoft 365), verify, test send,
 * DNS report, and inbound mail (IMAP sync → InboundEmailService). The BullMQ
 * processor for the `mail` queue lives in mailboxes.processors.ts (worker only).
 */
@Module({
  controllers: [MailboxesController, MailboxOAuthCallbackController],
  providers: [MailboxesService, MailboxOAuthService, InboundEmailService, ImapSyncService],
  exports: [MailboxesService, InboundEmailService, ImapSyncService],
})
export class MailboxesModule {}
