import { z } from "zod";
import { AI_REPLY_CATEGORIES, ListQuery, PRIORITIES, TASK_TYPES, isoDate, optionalUuid, text } from "@growthdesk/shared";

/** Query strings carry booleans as text; anything other than "true"/"false" is a 400. */
const queryBoolean = z.enum(["true", "false"]).transform((v) => v === "true");

/**
 * GET /inbox/conversations. `status` is the triage view (snoozed is an open
 * conversation with a future snoozedUntil); `assignee` is "me", "none" or a
 * member's id.
 */
export const ConversationListQuery = ListQuery.extend({
  status: z.enum(["open", "snoozed", "closed"]).optional(),
  channel: z.enum(["email", "whatsapp", "telegram", "web"]).optional(),
  unread: queryBoolean.optional(),
  assignee: z.union([z.enum(["me", "none"]), z.string().uuid()]).optional(),
  mailboxId: z.string().uuid().optional(),
  /** A campaign's id, or "any" for every campaign reply. */
  campaignId: z.union([z.literal("any"), z.string().uuid()]).optional(),
  /** A tag's id, or "none" for untagged conversations. */
  tag: z.union([z.literal("none"), z.string().uuid()]).optional(),
  /** A channel integration — e.g. one live-chat widget. */
  integrationId: z.string().uuid().optional(),
  /** The AI reply label (Conversation.aiCategory), e.g. "interested". */
  aiCategory: z.enum(AI_REPLY_CATEGORIES).optional(),
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
