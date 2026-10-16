import {
  AudioLines,
  BadgeCheck,
  BarChart3,
  Bot,
  Ban,
  Building2,
  CalendarDays,
  CheckSquare,
  Copy,
  CreditCard,
  FileText,
  FolderLock,
  FormInput,
  Funnel,
  GitBranch,
  Globe,
  Handshake,
  History,
  Home,
  Inbox,
  KeyRound,
  LifeBuoy,
  ListChecks,
  ListOrdered,
  Mail,
  MailPlus,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Palette,
  Phone,
  ScrollText,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquareKanban,
  Tag,
  TextCursorInput,
  Upload,
  UserPlus,
  UserRound,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { Channel } from "@growthdesk/shared";
import { IconBadge, IconTile, type Tint } from "./IconTile";

/*
 * One glyph and one colour per thing the app is about, so a contact looks
 * like a contact on its page header, in an empty state and in the settings
 * list. Glyphs match the sidebar (components/shell/nav.ts).
 *
 *   <PageHeader icon={<EntityTile of="contacts" />} … />
 *   <EmptyState icon={<EntityTile of="deals" size="xl" />} … />
 *   const { icon: Icon } = ENTITY.deals;   // the bare glyph
 */

export const ENTITY = {
  home: { icon: Home, tint: "blue" },
  inbox: { icon: Inbox, tint: "cyan" },
  tasks: { icon: CheckSquare, tint: "orange" },
  leads: { icon: UserPlus, tint: "mint" },
  contacts: { icon: Users, tint: "indigo" },
  companies: { icon: Building2, tint: "teal" },
  imports: { icon: Upload, tint: "mint" },
  duplicates: { icon: Copy, tint: "yellow" },
  campaigns: { icon: Send, tint: "blue" },
  sequences: { icon: ListOrdered, tint: "purple" },
  templates: { icon: FileText, tint: "orange" },
  deals: { icon: Handshake, tint: "green" },
  meetings: { icon: CalendarDays, tint: "red" },
  calls: { icon: Phone, tint: "teal" },
  aiAgents: { icon: AudioLines, tint: "indigo" },
  workflows: { icon: Workflow, tint: "purple" },
  runs: { icon: History, tint: "purple" },
  reports: { icon: BarChart3, tint: "pink" },
  billing: { icon: CreditCard, tint: "green" },
  settings: { icon: Settings, tint: "gray" },
  account: { icon: UserRound, tint: "gray" },
  admin: { icon: ShieldCheck, tint: "indigo" },
  // Settings sections.
  general: { icon: SlidersHorizontal, tint: "gray" },
  company: { icon: Building2, tint: "blue" },
  members: { icon: Users, tint: "blue" },
  roles: { icon: ShieldCheck, tint: "indigo" },
  mailboxes: { icon: Mail, tint: "blue" },
  channels: { icon: MessageCircle, tint: "green" },
  liveChat: { icon: MessagesSquare, tint: "purple" },
  calling: { icon: Phone, tint: "teal" },
  pipelines: { icon: SquareKanban, tint: "orange" },
  tags: { icon: Tag, tint: "yellow" },
  fields: { icon: TextCursorInput, tint: "teal" },
  suppressions: { icon: Ban, tint: "red" },
  apiKeys: { icon: KeyRound, tint: "gray" },
  webhooks: { icon: Webhook, tint: "purple" },
  mcp: { icon: Bot, tint: "orange" },
  audit: { icon: ScrollText, tint: "brown" },
  supportAccess: { icon: LifeBuoy, tint: "pink" },
  privacy: { icon: FolderLock, tint: "gray" },
  sendingDomains: { icon: Globe, tint: "blue" },
  // Marketing.
  marketing: { icon: Megaphone, tint: "pink" },
  lists: { icon: ListChecks, tint: "indigo" },
  segments: { icon: Funnel, tint: "teal" },
  marketingCampaigns: { icon: MailPlus, tint: "blue" },
  flows: { icon: GitBranch, tint: "purple" },
  forms: { icon: FormInput, tint: "mint" },
  designs: { icon: Palette, tint: "orange" },
  consent: { icon: BadgeCheck, tint: "green" },
} as const satisfies Record<string, { icon: LucideIcon; tint: Tint }>;

export type Entity = keyof typeof ENTITY;

/** The entity's coloured tile. */
export function EntityTile({ of, size = "lg", className }: { of: Entity; size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  const { icon: Icon, tint } = ENTITY[of];
  return <IconTile icon={<Icon />} tint={tint} size={size} className={className} />;
}

/** The entity's glyph in a soft tinted circle. */
export function EntityBadge({ of, className }: { of: Entity; className?: string }) {
  const { icon: Icon, tint } = ENTITY[of];
  return <IconBadge icon={<Icon />} tint={tint} className={className} />;
}

/** One glyph and one colour per message channel: template lists, sequence steps, the inbox. */
export const CHANNEL: Record<Channel, { icon: LucideIcon; tint: Tint }> = {
  email: { icon: Mail, tint: "blue" },
  whatsapp: { icon: MessageCircle, tint: "green" },
  telegram: { icon: Send, tint: "cyan" },
  call: { icon: Phone, tint: "teal" },
  web: { icon: MessagesSquare, tint: "purple" },
};

/** The channel's small coloured tile. */
export function ChannelTile({ channel, size = "sm", className }: { channel: Channel; size?: "sm" | "md" | "lg"; className?: string }) {
  const { icon: Icon, tint } = CHANNEL[channel];
  return <IconTile icon={<Icon />} tint={tint} size={size} className={className} />;
}
