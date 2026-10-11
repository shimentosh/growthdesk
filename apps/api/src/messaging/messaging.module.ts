import { Global, Module } from "@nestjs/common";
import { MailboxAuthService } from "./mailbox-auth.service.js";
import { OutboundEmailService } from "./outbound-email.service.js";

/** The shared email send path (used by inbox, campaigns, mailboxes). Global so any module can inject it. */
@Global()
@Module({ providers: [MailboxAuthService, OutboundEmailService], exports: [MailboxAuthService, OutboundEmailService] })
export class MessagingModule {}
