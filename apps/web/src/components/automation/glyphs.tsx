import {
  AlarmClock,
  ArrowRightLeft,
  Ban,
  Bell,
  CalendarCheck,
  CheckSquare,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleStop,
  CircleX,
  Clock,
  Hand,
  LoaderCircle,
  MessageSquareReply,
  PenLine,
  PhoneCall,
  Send,
  Tag,
  Upload,
  UserCheck,
  UserCog,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type { WorkflowRunStatus, WorkflowTrigger } from "@growthdesk/shared";
import { IconBadge, IconTile, type Tint } from "@/components/ui/IconTile";
import { triggerLabel, type WorkflowActionType } from "@/lib/types/automation";

/*
 * One glyph (and one tile colour) per workflow trigger, action type and run
 * status, so a trigger looks the same in the workflow list, the builder and
 * the runs log. Tints follow the entity each one is about (components/ui/icons).
 */

export const TRIGGER_GLYPH: Record<WorkflowTrigger, { icon: LucideIcon; tint: Tint }> = {
  "contact.created": { icon: UserPlus, tint: "indigo" },
  "lead.imported": { icon: Upload, tint: "mint" },
  "contact.qualified": { icon: UserCheck, tint: "blue" },
  "reply.received": { icon: MessageSquareReply, tint: "cyan" },
  "call.completed": { icon: PhoneCall, tint: "teal" },
  "meeting.booked": { icon: CalendarCheck, tint: "red" },
  "deal.stage_changed": { icon: ArrowRightLeft, tint: "green" },
  "task.overdue": { icon: AlarmClock, tint: "orange" },
};

export const ACTION_GLYPH: Record<WorkflowActionType, { icon: LucideIcon; tint: Tint }> = {
  assign_contact: { icon: UserCog, tint: "indigo" },
  update_contact: { icon: PenLine, tint: "teal" },
  create_task: { icon: CheckSquare, tint: "orange" },
  notify: { icon: Bell, tint: "red" },
  enroll_campaign: { icon: Send, tint: "blue" },
  stop_campaigns: { icon: CircleStop, tint: "gray" },
  add_tag: { icon: Tag, tint: "yellow" },
};

export const RUN_STATUS_GLYPH: Record<WorkflowRunStatus, { icon: LucideIcon; tint: Tint }> = {
  pending: { icon: CircleDashed, tint: "gray" },
  waiting_approval: { icon: Hand, tint: "orange" },
  waiting: { icon: Clock, tint: "blue" },
  running: { icon: LoaderCircle, tint: "blue" },
  succeeded: { icon: CircleCheck, tint: "green" },
  failed: { icon: CircleX, tint: "red" },
  skipped: { icon: CircleSlash, tint: "gray" },
  canceled: { icon: Ban, tint: "gray" },
};

/** The trigger's coloured tile (unknown triggers get a grey one). */
export function TriggerTile({ trigger, size = "md", className }: { trigger: string; size?: "sm" | "md"; className?: string }) {
  const g = TRIGGER_GLYPH[trigger as WorkflowTrigger];
  const Icon = g?.icon ?? CircleDashed;
  return <IconTile icon={<Icon />} tint={g?.tint ?? "gray"} size={size} className={className} />;
}

/** The action type's coloured tile. */
export function ActionTile({ type, size = "sm", className }: { type: string; size?: "sm" | "md"; className?: string }) {
  const g = ACTION_GLYPH[type as WorkflowActionType];
  const Icon = g?.icon ?? CircleDashed;
  return <IconTile icon={<Icon />} tint={g?.tint ?? "gray"} size={size} className={className} />;
}

/** The action type's bare glyph (inherits colour and size). */
export function ActionGlyph({ type, className }: { type: string; className?: string }) {
  const Icon = ACTION_GLYPH[type as WorkflowActionType]?.icon ?? CircleDashed;
  return <Icon aria-hidden className={className} />;
}

/** The run status in a soft tinted circle, at the start of a run row. */
export function RunStatusBadge({ status, className }: { status: string; className?: string }) {
  const g = RUN_STATUS_GLYPH[status as WorkflowRunStatus];
  const Icon = g?.icon ?? CircleDashed;
  return <IconBadge icon={<Icon />} tint={g?.tint ?? "gray"} className={className} />;
}

/** "Contact created" with its glyph before it, for a Select option or a line of text. */
export function TriggerLabel({ trigger }: { trigger: WorkflowTrigger }) {
  const Icon = TRIGGER_GLYPH[trigger]?.icon ?? CircleDashed;
  return (
    <span className="inline-flex items-center gap-2">
      <Icon aria-hidden className="size-4 shrink-0 text-text-3" />
      {triggerLabel(trigger)}
    </span>
  );
}
