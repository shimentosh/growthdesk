import { z } from "zod";
import { AnalyticsPipelineQuery, AnalyticsRangeQuery } from "@growthdesk/shared";
import { AnalyticsService } from "../../analytics/analytics.service.js";
import { MarketingCampaignsService } from "../../marketing/campaigns.service.js";
import { parseWith } from "../../common/decorators.js";
import { defineTool } from "../tool.js";

/*
 * Reports through MCP — the same AnalyticsService the web Reports page reads,
 * so the figures match what the person sees. Read only. Ranges are whole
 * days in the workspace's time zone (default: the last 30 days).
 */

const range = {
  from: z.string().max(10).optional().describe("First day, YYYY-MM-DD, in the workspace time zone. Default: 30 days before `to`."),
  to: z.string().max(10).optional().describe("Last day, YYYY-MM-DD (inclusive). Default: today."),
};

const pct = (r: number | null | undefined) => (r === null || r === undefined ? null : Math.round(r * 1000) / 10);

export const REPORT_TOOLS = [
  defineTool({
    name: "dashboard_summary",
    title: "Dashboard summary",
    description:
      "Headline figures for a date range, as on the Reports page: outreach (sent, delivered, bounced, opened, clicked, replies, reply rate, unsubscribes), pipeline (deals created, won, lost, win rate, value won, average days to close) and activity (tasks completed, meetings booked and held, calls). Rates are percentages. Without records.view_all the figures cover only the person's own records (scope: own).",
    input: z.object(range),
    permission: "analytics.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const o = await deps.get(AnalyticsService).overview(ctx, parseWith(AnalyticsRangeQuery, args));
      return {
        range: o.range,
        outreach: { ...o.outreach, bounceRate: pct(o.outreach.bounceRate), openRate: pct(o.outreach.openRate), clickRate: pct(o.outreach.clickRate), replyRate: pct(o.outreach.replyRate) },
        pipeline: { ...o.pipeline, winRate: pct(o.pipeline.winRate) },
        activity: o.activity,
      };
    },
  }),

  defineTool({
    name: "pipeline_report",
    title: "Pipeline funnel report",
    description: "The stage funnel for deals created in the range, in one pipeline (default: the default pipeline): how many reached each stage, the step-to-step conversion (%), and how many are open, won and lost.",
    input: z.object({ ...range, pipelineId: z.string().uuid().optional() }),
    permission: "analytics.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const p = await deps.get(AnalyticsService).pipeline(ctx, parseWith(AnalyticsPipelineQuery, args));
      return { ...p, stages: p.stages.map((s) => ({ stageId: s.stageId, name: s.name, kind: s.kind, reached: s.reached, conversion: pct(s.conversion) })) };
    },
  }),

  defineTool({
    name: "outreach_performance",
    title: "Outreach campaign performance",
    description:
      "Outreach (sequence) campaigns compared over the range: sent, contacted, replied, reply rate, bounces, opens, clicks, unsubscribes and deals created, busiest first (campaignId narrows to one). byStepNumber compares first touches with follow-ups across all campaigns: sent, replies and bounces by sequence step position.",
    input: z.object({ ...range, campaignId: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).default(20) }),
    permission: "analytics.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const { campaignId, limit, ...q } = args;
      const r = await deps.get(AnalyticsService).campaigns(ctx, parseWith(AnalyticsRangeQuery, q));
      const rows = (campaignId ? r.campaigns.filter((c) => c.id === campaignId) : r.campaigns).slice(0, limit);
      return {
        range: r.range,
        campaigns: rows.map((c) => ({ ...c, replyRate: pct(c.replyRate), bounceRate: pct(c.bounceRate) })),
        totalCampaigns: r.campaigns.length,
        byStepNumber: r.steps.map((s) => ({ ...s, replyRate: pct(s.replyRate), bounceRate: pct(s.bounceRate) })),
      };
    },
  }),

  defineTool({
    name: "marketing_performance",
    title: "Email marketing performance",
    description: "Marketing (newsletter) campaigns that have been sent or are sending, newest first: recipients, sent, unique opens and clicks with rates (%), unsubscribes, bounces and complaints.",
    input: z.object({ includeDrafts: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(20) }),
    permission: "marketing.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const rows = await deps.get(MarketingCampaignsService).list(ctx);
      const shown = rows.filter((c) => args.includeDrafts || c.status !== "draft").slice(0, args.limit);
      const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
      const items = shown.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        subject: c.subject,
        sentAt: c.startedAt,
        completedAt: c.completedAt,
        ...c.stats,
        openRate: rate(c.stats.uniqueOpens, c.stats.sent),
        clickRate: rate(c.stats.uniqueClicks, c.stats.sent),
        unsubscribeRate: rate(c.stats.unsubscribes, c.stats.sent),
        bounceRate: rate(c.stats.bounces, c.stats.sent),
      }));
      const sum = (k: "sent" | "uniqueOpens" | "uniqueClicks" | "unsubscribes" | "bounces") => items.reduce((a, c) => a + c[k], 0);
      return {
        items,
        totals: { campaigns: items.length, sent: sum("sent"), uniqueOpens: sum("uniqueOpens"), uniqueClicks: sum("uniqueClicks"), unsubscribes: sum("unsubscribes"), bounces: sum("bounces"), openRate: rate(sum("uniqueOpens"), sum("sent")), clickRate: rate(sum("uniqueClicks"), sum("sent")) },
      };
    },
  }),

  defineTool({
    name: "team_report",
    title: "Team leaderboard",
    description: "Per member for the range: messages sent, replies, meetings, deals won and value, tasks completed, calls. Needs the team-reports permission and a plan with advanced reporting.",
    input: z.object(range),
    permission: "analytics.team",
    risk: "read",
    handler: async (ctx, args, deps) => deps.get(AnalyticsService).team(ctx, parseWith(AnalyticsRangeQuery, args)),
  }),
];
