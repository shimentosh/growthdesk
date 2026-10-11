import { Global, Module } from "@nestjs/common";
import { MailboxAuthService } from "./mailbox-auth.service.js";
import { OutboundEmailService } from "./outbound-email.service.js";
import { MailboxFaultService } from "./mailbox-faults.service.js";

/** The shared email send path (used by inbox, campaigns, mailboxes). Global so any module can inject it. */
@Global()
@Module({
  providers: [MailboxAuthService, MailboxFaultService, OutboundEmailService],
  exports: [MailboxAuthService, MailboxFaultService, OutboundEmailService],
})
export class MessagingModule {}
