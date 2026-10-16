import type { DiscordTemplateBodyT } from "./discord.js";

/*
 * Ready-made Discord templates, offered on Settings → Discord → Templates.
 * Adding one copies it into the workspace's own templates, where it can be
 * edited like any other. Every variable is one the render context provides
 * for the listed events (apps/api/src/discord/discord-context.service.ts);
 * fields that render empty are hidden (omitEmptyFields), so a preset still
 * reads well when, say, a deal has no company.
 */

export type DiscordTemplatePreset = {
  key: string;
  name: string;
  description: string;
  /** The events it is written for; also what the preview uses. */
  events: string[];
  body: DiscordTemplateBodyT;
};

const COLORS = { green: "#57F287", red: "#ED4245", blurple: "#5865F2", yellow: "#FEE75C", fuchsia: "#EB459E", teal: "#1ABC9C", orange: "#F0B232", grey: "#99AAB5" } as const;

type EmbedInput = Partial<Omit<DiscordTemplateBodyT["embed"], "fields">> & { fields?: [name: string, value: string, inline?: boolean][] };

const preset = (p: { key: string; name: string; description: string; events: string[]; content?: string; embed: EmbedInput; button?: string }): DiscordTemplatePreset => ({
  key: p.key,
  name: p.name,
  description: p.description,
  events: p.events,
  body: {
    content: p.content ?? "",
    embed: {
      enabled: true,
      title: p.embed.title ?? "",
      url: p.embed.url ?? "{{event.link}}",
      description: p.embed.description ?? "",
      color: p.embed.color ?? COLORS.blurple,
      author: p.embed.author ?? "{{workspace.name}}",
      footer: p.embed.footer ?? "",
      timestamp: p.embed.timestamp ?? true,
      fields: (p.embed.fields ?? []).map(([name, value, inline = true]) => ({ name, value, inline })),
    },
    buttons: p.button ? [{ label: p.button, url: "{{event.link}}" }] : [],
    omitEmptyFields: true,
    missing: "blank",
  },
});

export const DISCORD_TEMPLATE_PRESETS: DiscordTemplatePreset[] = [
  preset({
    key: "deal_won",
    name: "Deal won",
    description: "Celebrate a closed deal: value, who won it, company and contact.",
    events: ["deal.won"],
    embed: {
      title: "🎉 Deal won: {{deal.title}}",
      description: "**{{deal.valueFormatted}}** closed by {{event.actor.name|the team}}.",
      color: COLORS.green,
      fields: [
        ["Company", "{{deal.company.name}}"],
        ["Contact", "{{contact.fullName}}"],
        ["Owner", "{{deal.owner.name}}"],
        ["Pipeline", "{{deal.pipeline}}"],
      ],
    },
    button: "Open deal",
  }),
  preset({
    key: "deal_lost",
    name: "Deal lost",
    description: "A deal marked lost, with its value and owner, so the team can follow up.",
    events: ["deal.lost"],
    embed: {
      title: "Deal lost: {{deal.title}}",
      description: "{{deal.valueFormatted}} · marked lost by {{event.actor.name|the team}}.",
      color: COLORS.red,
      fields: [
        ["Company", "{{deal.company.name}}"],
        ["Contact", "{{contact.fullName}}"],
        ["Owner", "{{deal.owner.name}}"],
      ],
    },
    button: "Open deal",
  }),
  preset({
    key: "deal_created",
    name: "New deal",
    description: "A deal is opened: value, stage and owner.",
    events: ["deal.created"],
    embed: {
      title: "💼 New deal: {{deal.title}}",
      color: COLORS.blurple,
      fields: [
        ["Value", "{{deal.valueFormatted}}"],
        ["Stage", "{{deal.stage}}"],
        ["Owner", "{{deal.owner.name|Unassigned}}"],
        ["Company", "{{deal.company.name}}"],
        ["Contact", "{{contact.fullName}}"],
        ["Expected close", "{{deal.expectedCloseDate}}"],
      ],
    },
    button: "Open deal",
  }),
  preset({
    key: "deal_stage",
    name: "Deal moved stage",
    description: "Pipeline movement: which deal, the stage it moved to, and who moved it.",
    events: ["deal.stage_changed"],
    embed: {
      title: "{{deal.title}} → {{deal.stage}}",
      description: "Moved by {{event.actor.name|someone}} in {{deal.pipeline}}.",
      color: COLORS.blurple,
      fields: [
        ["Value", "{{deal.valueFormatted}}"],
        ["Owner", "{{deal.owner.name}}"],
        ["Company", "{{deal.company.name}}"],
      ],
    },
    button: "Open deal",
  }),
  preset({
    key: "deal_stale",
    name: "Deal going stale",
    description: "A deal with no progress for too long, nudging its owner.",
    events: ["deal.stale"],
    embed: {
      title: "⏳ {{deal.title}} is going stale",
      description: "No progress for **{{payload.days}} days** in {{payload.stage}}.",
      color: COLORS.orange,
      fields: [
        ["Owner", "{{deal.owner.name|Unassigned}}"],
        ["Value", "{{deal.valueFormatted}}"],
        ["Contact", "{{contact.fullName}}"],
      ],
    },
    button: "Open deal",
  }),
  preset({
    key: "new_lead",
    name: "New lead",
    description: "A new contact or imported lead: who they are, where they came from, who owns them.",
    events: ["lead.imported", "contact.created"],
    embed: {
      title: "🧲 New lead: {{contact.fullName|Unnamed contact}}",
      description: "{{contact.jobTitle}}",
      color: COLORS.yellow,
      fields: [
        ["Company", "{{contact.company.name}}"],
        ["Email", "{{contact.email}}"],
        ["Phone", "{{contact.phone}}"],
        ["Source", "{{contact.leadSource}}"],
        ["Owner", "{{contact.owner.name|Unassigned}}"],
        ["Country", "{{contact.country}}"],
      ],
    },
    button: "Open contact",
  }),
  preset({
    key: "lead_qualified",
    name: "Lead qualified",
    description: "A lead is marked qualified and ready for sales.",
    events: ["contact.qualified"],
    embed: {
      title: "✅ Qualified: {{contact.fullName}}",
      description: "Marked qualified by {{event.actor.name|the team}}.",
      color: COLORS.teal,
      fields: [
        ["Company", "{{contact.company.name}}"],
        ["Score", "{{contact.score}}"],
        ["Owner", "{{contact.owner.name|Unassigned}}"],
        ["Email", "{{contact.email}}"],
      ],
    },
    button: "Open contact",
  }),
  preset({
    key: "reply",
    name: "New reply",
    description: "Someone replied: who, the subject, the AI summary and sentiment.",
    events: ["reply.received"],
    embed: {
      title: "💬 {{conversation.from|Someone}} replied",
      description: "{{conversation.subject}}",
      color: COLORS.fuchsia,
      fields: [
        ["Summary", "{{conversation.summary}}", false],
        ["Sentiment", "{{conversation.sentiment}}"],
        ["Campaign", "{{campaign.name}}"],
        ["Company", "{{contact.company.name}}"],
        ["Assigned to", "{{conversation.assignee.name}}"],
      ],
    },
    button: "Open in inbox",
  }),
  preset({
    key: "meeting_booked",
    name: "Meeting booked",
    description: "A meeting on the calendar: when, with whom, and the join link.",
    events: ["meeting.booked"],
    embed: {
      title: "📅 Meeting booked: {{meeting.title}}",
      description: "{{meeting.when}}",
      color: COLORS.blurple,
      fields: [
        ["With", "{{meeting.attendeeName}}"],
        ["Contact", "{{contact.fullName}}"],
        ["Email", "{{meeting.attendeeEmail}}"],
        ["Company", "{{contact.company.name}}"],
        ["Where", "{{meeting.location}}"],
        ["Join", "{{meeting.conferenceUrl}}", false],
      ],
    },
    button: "Open meetings",
  }),
  preset({
    key: "call_completed",
    name: "Call completed",
    description: "A finished call: outcome, who made it, and the summary.",
    events: ["call.completed"],
    embed: {
      title: "📞 Call with {{contact.fullName|a contact}}: {{call.outcome|completed}}",
      description: "{{call.summary}}",
      color: COLORS.teal,
      fields: [
        ["By", "{{call.by.name}}"],
        ["Direction", "{{call.direction}}"],
        ["Duration (s)", "{{call.durationSec}}"],
        ["Company", "{{contact.company.name}}"],
      ],
    },
    button: "Open calls",
  }),
  preset({
    key: "quote_accepted",
    name: "Quote accepted",
    description: "A client accepted a quote: its number, total and deal.",
    events: ["quote.accepted"],
    embed: {
      title: "🧾 Quote {{payload.quoteNumber}} accepted",
      description: "**{{payload.total}} {{payload.currency}}** accepted by {{contact.fullName|the client}}.",
      color: COLORS.green,
      fields: [
        ["Deal", "{{deal.title}}"],
        ["Company", "{{contact.company.name}}"],
        ["Owner", "{{deal.owner.name}}"],
      ],
    },
    button: "Open in Growthdesk",
  }),
  preset({
    key: "task_overdue",
    name: "Task overdue",
    description: "A task passed its due date: what it is and whose it is.",
    events: ["task.overdue"],
    embed: {
      title: "⚠️ Overdue: {{task.title}}",
      color: COLORS.orange,
      fields: [
        ["Assigned to", "{{task.assignee.name|Unassigned}}"],
        ["Was due", "{{task.due}}"],
        ["Priority", "{{task.priority}}"],
        ["Contact", "{{contact.fullName}}"],
      ],
    },
    button: "Open tasks",
  }),
  preset({
    key: "campaign_completed",
    name: "Campaign finished",
    description: "A campaign's results when it ends: sent, replies, bounces.",
    events: ["campaign.completed"],
    embed: {
      title: "📣 Campaign finished: {{campaign.name}}",
      color: COLORS.grey,
      fields: [
        ["Enrolled", "{{campaign.enrolledCount}}"],
        ["Sent", "{{campaign.sentCount}}"],
        ["Replies", "{{campaign.replyCount}}"],
        ["Positive", "{{campaign.positiveReplyCount}}"],
        ["Bounced", "{{campaign.bounceCount}}"],
      ],
    },
    button: "Open campaign",
  }),
  preset({
    key: "one_liner",
    name: "Compact one-liner",
    description: "Any event as a single line of text, no card. Good for busy channels.",
    events: ["deal.won", "lead.imported", "reply.received"],
    content: "**{{event.label}}** · {{contact.fullName|}} {{deal.title|}} — {{event.actor.name|Growthdesk}}",
    embed: { enabled: false, timestamp: false, url: "", author: "" },
  }),
];
