import { z } from "zod";
import { text } from "./schemas.js";

/*
 * The AI assistant's request bodies and labels, shared by the API and the web.
 *
 * Everything the assistant produces is a suggestion a person reviews: drafts
 * land in an editor, never in an outbox, and reply labels are advisory (the
 * unsubscribe-by-reply opt-out is decided by the inbound filer, not by AI).
 */

/** Labels the classifier may put on an inbound reply (Conversation.aiCategory). */
export const AI_REPLY_CATEGORIES = [
  "interested",
  "meeting_request",
  "question",
  "referral",
  "not_interested",
  "not_now",
  "out_of_office",
  "unsubscribe",
  "wrong_person",
  "other",
] as const;
export type AiReplyCategory = (typeof AI_REPLY_CATEGORIES)[number];

export const AI_REPLY_CATEGORY_LABELS: Record<AiReplyCategory, string> = {
  interested: "Interested",
  meeting_request: "Meeting request",
  question: "Question",
  referral: "Referral",
  not_interested: "Not interested",
  not_now: "Not now",
  out_of_office: "Out of office",
  unsubscribe: "Unsubscribe request",
  wrong_person: "Wrong person",
  other: "Other",
};

export const AI_SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type AiSentiment = (typeof AI_SENTIMENTS)[number];

export const AI_TONES = ["friendly", "professional", "direct", "casual"] as const;

/** Bodies over this are cut before they reach a prompt (per message). */
export const AI_MAX_MESSAGE_CHARS = 4000;

/** POST …/ai/conversations/:id/draft-reply — a reply suggestion for an inbox thread. */
export const AiReplyDraftInput = z.object({
  /** What the reply should do ("propose Tuesday", "answer the pricing question"). */
  instructions: text(1000).optional(),
  tone: z.enum(AI_TONES).default("professional"),
  /** Skip the cache and ask again (a different suggestion for the same thread). */
  fresh: z.boolean().default(false),
});
export type AiReplyDraftInputT = z.infer<typeof AiReplyDraftInput>;

/**
 * POST …/ai/write — write or improve an email template or a sequence step.
 * `write` needs a brief; `improve` needs the current body.
 */
export const AiWriteInput = z
  .object({
    target: z.enum(["template", "sequence_step"]).default("template"),
    mode: z.enum(["write", "improve"]),
    channel: z.enum(["email", "whatsapp", "telegram"]).default("email"),
    brief: text(2000).optional(),
    subject: text(500).optional(),
    body: text(20000).optional(),
    tone: z.enum(AI_TONES).default("professional"),
    /** Which step of a sequence this is (1 = first touch; later steps are follow-ups in the same thread). */
    stepNumber: z.number().int().min(1).max(50).optional(),
    fresh: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "write" && !v.brief?.trim()) ctx.addIssue({ code: "custom", path: ["brief"], message: "Describe what the message should say" });
    if (v.mode === "improve" && !v.body?.trim()) ctx.addIssue({ code: "custom", path: ["body"], message: "There is no text to improve yet" });
  });
export type AiWriteInputT = z.infer<typeof AiWriteInput>;

/** POST …/ai/contacts/:id/summary and …/ai/deals/:id/summary. */
export const AiSummaryInput = z.object({ fresh: z.boolean().default(false) });
export type AiSummaryInputT = z.infer<typeof AiSummaryInput>;
