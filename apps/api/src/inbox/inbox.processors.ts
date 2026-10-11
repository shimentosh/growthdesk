import { Module } from "@nestjs/common";

/*
 * The inbox has no background jobs, deliberately:
 *  - Sending is synchronous (InboxService.reply / compose call
 *    OutboundEmailService and the ChatSender directly), so nothing is queued.
 *  - Snooze needs no wake-up job: "snoozed" is an open conversation whose
 *    snoozedUntil is in the future, evaluated at read time by the list filter
 *    and the unread count, so a lapsed snooze is simply open again. A new
 *    inbound message clears snoozedUntil when it is filed
 *    (mailboxes/inbound-email.service.ts, channels/chat-inbound.service.ts).
 *  - Reply notifications are raised when the inbound message is filed, and
 *    reply classification is queued on the `ai` queue by the same code.
 * Kept as a module so WorkerModule's wiring stays stable if a job is added.
 */
@Module({})
export class InboxProcessorsModule {}
