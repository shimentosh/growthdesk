import { z } from "zod";
import { ListQuery, PRIORITIES, TASK_TYPES, isoDate, optionalUuid, text } from "@growthdesk/shared";

/** Query strings carry booleans as text; anything other than "true"/"false" is a 400. */
const queryBoolean = z.enum(["true", "false"]).transform((v) => v === "true");

/**
 * GET /inbox/conversations. `status` is the triage view (snoozed is an open
 * conversation with a future snoozedUntil); `assignee` is "me", "none" or a
 * member's id.
 */
export const ConversationListQuery = ListQuery.extend({
  status: z.enum(["open", "snoozed", "closed"]).optional(),
  channel: z.enum(["email", "whatsapp", "telegram"]).optional(),
  unread: queryBoolean.optional(),
  assignee: z.union([z.enum(["me", "none"]), z.string().uuid()]).optional(),
  mailboxId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  q: text(200).optional(),
});
export type ConversationListQueryT = z.infer<typeof ConversationListQuery>;

/** A follow-up task from a conversation. Title defaults to "Follow up with …"; assignee defaults to the caller. */
export const ConversationTaskInput = z.object({
  type: z.enum(TASK_TYPES).default("custom"),
  title: text(300).optional(),
  description: text(5000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  dueAt: isoDate.nullable().optional(),
  assigneeId: optionalUuid,
});
export type ConversationTaskInputT = z.infer<typeof ConversationTaskInput>;
