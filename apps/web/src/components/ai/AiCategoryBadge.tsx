import { AI_REPLY_CATEGORY_LABELS, type AiReplyCategory } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";

const TONE: Partial<Record<AiReplyCategory, Tone>> = {
  interested: "ok",
  meeting_request: "ok",
  question: "live",
  referral: "info",
  not_interested: "bad",
  unsubscribe: "bad",
  not_now: "warn",
  out_of_office: "mute",
  wrong_person: "mute",
};

/** The AI label on a reply (Conversation.aiCategory). Renders nothing when there is none. */
export function AiCategoryBadge({ category, className }: { category: string | null | undefined; className?: string }) {
  if (!category) return null;
  const label = AI_REPLY_CATEGORY_LABELS[category as AiReplyCategory] ?? category;
  return (
    <Badge
      quiet
      tone={TONE[category as AiReplyCategory] ?? "mute"}
      title={`AI label: ${label}. Suggested by AI from the latest reply — check before acting.`}
      className={className}
    >
      {label}
    </Badge>
  );
}
