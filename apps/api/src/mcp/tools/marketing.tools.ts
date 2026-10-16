import { definePrompt, type McpTool } from "../tool.js";
import { CAMPAIGN_TOOLS } from "./marketing/campaigns.tools.js";
import { DESIGN_TOOLS } from "./marketing/designs.tools.js";
import { LIST_TOOLS } from "./marketing/lists.tools.js";
import { SETUP_TOOLS } from "./marketing/setup.tools.js";

/*
 * Email marketing through MCP (docs/MCP.md → "Marketing tools"): setup
 * status, lists, designs and the template library, newsletter campaigns and
 * their reports, and the suppression list. Each tool calls the same service
 * as the matching HTTP route, with that route's permission. Sending,
 * scheduling, resuming, canceling, deleting, bulk-adding and removing are
 * "important": they wait for the user's approval through confirm_action.
 */

export const MARKETING_TOOLS: McpTool[] = [...SETUP_TOOLS, ...LIST_TOOLS, ...DESIGN_TOOLS, ...CAMPAIGN_TOOLS];

export const MARKETING_PROMPTS = [
  definePrompt({
    name: "plan_newsletter",
    title: "Plan and schedule a newsletter",
    description: "Walks through a newsletter: check setup, pick the list, design it from a template, preview, test, then schedule with your approval.",
    arguments: [
      { name: "topic", description: "What the newsletter is about.", required: true },
      { name: "audience", description: "Who it is for, or which list to use." },
      { name: "when", description: "When to send it, e.g. \"Tuesday 9am\"." },
    ],
    render: (args, ctx) =>
      [
        `Help me plan an email newsletter in "${ctx.workspace.name}" about: ${args.topic}.${args.audience ? ` Audience: ${args.audience}.` : ""}${args.when ? ` Send time: ${args.when} (workspace timezone ${ctx.workspace.timezone}).` : ""}`,
        "",
        "Work step by step and tell me what you find at each step:",
        "1. Call marketing_setup_status. If it is not ready to send, tell me exactly what is missing and stop there.",
        "2. Call list_lists and propose the list(s) to send to, with their subscribed counts. Ask me if it is unclear.",
        "3. Call list_design_templates, pick a fitting template and create_design from it. Read get_design_block_reference, then use update_design (blockOps) to write the content: a clear headline, short sections, one main call to action. Use upload_image_from_url for any images I give you.",
        "4. Call preview_design and fix every problem it lists. Show me the plain-text version.",
        "5. create_marketing_campaign with a subject (under 60 characters), a preheader, the design and the list(s); check marketing_campaign_readiness.",
        "6. send_test_email to me, and ask me to check it in my inbox.",
        "7. When I am happy, call schedule_marketing_campaign (or send_marketing_campaign_now if I ask for it). Show me the summary it returns — recipients, sender, time, allowance — and only call confirm_action after I say yes.",
      ].join("\n"),
  }),
  definePrompt({
    name: "campaign_report_summary",
    title: "Summarise an email campaign's results",
    description: "Reads a marketing campaign's report and explains how it did, with suggestions for the next one.",
    arguments: [{ name: "campaign", description: "The campaign's name or id (leave empty for the most recent sent one)." }],
    render: (args) =>
      [
        args.campaign
          ? `Find the marketing campaign "${args.campaign}" (list_marketing_campaigns, search by name, or use it as the id).`
          : "Find my most recent sent marketing campaign (list_marketing_campaigns with status sent).",
        "Call marketing_campaign_report for it and give me a short summary: delivered, open rate, click rate, click-to-open, unsubscribes, bounces and complaints, and the top links.",
        "Say plainly whether each number is good for a B2B newsletter (typical: opens 20–40%, clicks 2–5%, unsubscribes under 0.5%, bounces under 2%, complaints under 0.1%).",
        "If bounces or complaints are high, use list_campaign_recipients with that status to show examples.",
        "End with three concrete suggestions for the next campaign (subject, content, audience or timing).",
      ].join("\n"),
  }),
];
