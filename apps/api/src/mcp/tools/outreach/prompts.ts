import { definePrompt } from "../../tool.js";

/*
 * Outreach prompts: the guided way to build and launch a cold sequence, and
 * a report on how campaigns are doing.
 */

export const OUTREACH_PROMPTS = [
  definePrompt({
    name: "build_cold_sequence",
    title: "Build a cold email sequence",
    description: "Guides Claude from mailboxes to a drafted, tested campaign, and launches it only after you confirm.",
    arguments: [
      { name: "goal", description: "What the outreach is for: offer, audience, desired outcome.", required: false },
      { name: "audience", description: "Who to reach: a lead list, saved view, tag or 'new inbound leads'.", required: false },
    ],
    render: (args, ctx) =>
      [
        `Help me build a cold outreach campaign in Growthdesk workspace "${ctx.workspace.name}".`,
        args.goal ? `Goal: ${args.goal}.` : "First ask me what I am offering, to whom, and what reply I want.",
        args.audience ? `Audience: ${args.audience}.` : "",
        "",
        "Work in this order, showing me each draft before moving on:",
        "1. list_mailboxes: which mailboxes can send, their daily room, reply tracking (needed for stop-on-reply) and DNS health (SPF/DKIM/DMARC). If none is connected, or DNS is failing, tell me to fix it in Settings → Mailboxes — never ask me for a mailbox password here.",
        "2. get_step_reference, then draft a short sequence: 2–4 plain-text emails, 2–4 days apart, the first with a curiosity-free specific subject, follow-ups with an empty subject so they reply in the same thread. Personalize with fallbacks on every token, e.g. {{first_name|there}}, {{company|your team}}. Keep each email under ~120 words, one clear ask, no links in the first email.",
        "3. Find the audience (lead lists, saved views, contacts). Then create_campaign with the steps, audience, mailboxIds, a weekday business-hours window in my time zone and a modest dailyNewLimit (20–50 per mailbox). If people will keep arriving (new inbound leads, a workflow enrolling them), set settings.keepOpen = true (\"Always on\").",
        "4. campaign_readiness: fix every problem; explain the warnings and the skipped contacts.",
        "5. send_test_step for the first email (it goes to my own address) and ask me to check it.",
        "6. launch_campaign — show me the confirmation summary exactly (how many contacts, mailboxes, daily limit, first send time) and call confirm_action only after I say yes in this chat.",
      ]
        .filter((l) => l !== "")
        .join("\n"),
  }),

  definePrompt({
    name: "outreach_report",
    title: "Outreach report",
    description: "How the outreach campaigns are doing, what is broken, and what to do next.",
    arguments: [{ name: "campaignId", description: "One campaign to report on (default: all running, scheduled and paused ones).", required: false }],
    render: (args) =>
      [
        args.campaignId
          ? `Report on outreach campaign ${args.campaignId}: get_campaign and campaign_health.`
          : "Report on my outreach campaigns: list_campaigns for running, scheduled and paused ones (and drafts waiting to launch), then campaign_health for each live one.",
        "For each: sent, reply rate (replied / sent), bounce rate, opens/clicks only if tracking is on, contacts still in progress, and which step gets replies.",
        "Flag problems: bounce rate above 3%, disconnected mailboxes, reply tracking off, failed enrollments (retry_failed_enrollments after the cause is fixed), drafts not ready.",
        "Use list_enrollments with replied=true to name who replied. End with three concrete next steps. Do not change anything without asking me.",
      ].join("\n"),
  }),
];
