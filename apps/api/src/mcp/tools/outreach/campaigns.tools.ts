import { z } from "zod";
import { CAMPAIGN_STATUSES } from "@growthdesk/shared";
import { CampaignCreateBody, CampaignListQuery, CampaignPatchBody, CampaignsService, StepTestBody } from "../../../campaigns/campaigns.service.js";
import { ApiError, badRequest, conflict } from "../../../common/errors.js";
import { defineTool, pageInput, paged, type McpCtx, type McpDeps } from "../../tool.js";
import {
  audienceInput,
  campaignRow,
  describeLimits,
  describeSteps,
  describeWindow,
  firstSendAt,
  id,
  scheduleInput,
  sendingMailboxes,
  settingsInput,
  stepOut,
  stepsInput,
  validate,
} from "./shared.js";

/*
 * Outreach campaigns: a private copy of a step list, an audience, a send
 * window, settings and the mailboxes it sends from. Drafts are built and
 * edited freely (write); launching, resuming, stopping and deleting are
 * important actions that only happen after the person confirms. Permissions
 * are CampaignsController's: campaigns.read / campaigns.write / campaigns.launch.
 */

type CampaignDto = Awaited<ReturnType<CampaignsService["get"]>>;

const LIVE = ["scheduled", "running", "paused"];

const startAtInput = z.iso
  .datetime({ offset: true })
  .nullable()
  .optional()
  .describe("When the campaign may start sending, ISO 8601 (e.g. 2026-11-02T09:00:00Z). Launching before then schedules it. null clears it.");

/** What the model reads about one campaign. */
function campaignDetail(c: CampaignDto) {
  return {
    ...campaignRow(c),
    description: c.description,
    owner: c.owner ? { id: c.owner.id, name: c.owner.name } : null,
    audienceDefinition: c.audience,
    window: describeWindow(c.schedule),
    schedule: c.schedule,
    settings: c.settings,
    mailboxes: c.mailboxes.map((m) => ({ id: m.id, email: m.email, status: m.status })),
    mailboxNote: c.mailboxes.length ? undefined : "No mailbox chosen: emails go from whichever connected mailbox has the most room that day.",
    outline: describeSteps(c.steps),
    steps: c.steps.map(stepOut),
    pausedAt: c.pausedAt,
    completedAt: c.completedAt,
    canceledAt: c.canceledAt,
  };
}

const NEXT: Record<string, string> = {
  draft: "Draft: check campaign_readiness, send_test_step to yourself, then launch_campaign (the person confirms).",
  scheduled: "Scheduled: sends from its start time. pause_campaign holds it.",
  running: "Running. pause_campaign holds it; campaign_health shows problems.",
  paused: "Paused: resume_campaign continues it (the person confirms). Steps, audience, schedule, settings and mailboxes can be edited now.",
  completed: "Completed: everyone finished. duplicate_campaign to run it again.",
  canceled: "Stopped for good. duplicate_campaign to run it again.",
};

async function load(ctx: McpCtx, deps: McpDeps, campaignId: string) {
  return deps.get(CampaignsService).get(ctx, campaignId);
}

/** The person-readable part of a launch/resume preview: steps, mailboxes, limits, first send. */
async function sendingFacts(ctx: McpCtx, deps: McpDeps, c: CampaignDto) {
  const mailboxes = c.steps.some((s) => s.type === "email") ? await sendingMailboxes(ctx, deps, c.mailboxes) : "no email steps";
  const first = firstSendAt(c, c.steps);
  return { mailboxes, first, limits: describeLimits(c), outline: describeSteps(c.steps) };
}

export const OUTREACH_CAMPAIGN_TOOLS = [
  defineTool({
    name: "list_campaigns",
    title: "List outreach campaigns",
    description:
      "Outreach (cold email / multichannel sequence) campaigns with status, audience, mailboxes, stats (sent, opened, replied, bounced…) and enrollment counts. Not newsletters (those are marketing campaigns).",
    input: z.object({
      status: z.enum(CAMPAIGN_STATUSES).optional().describe("Only this status: draft, scheduled, running, paused, completed, canceled."),
      search: z.string().trim().max(200).optional().describe("Matches the name."),
      ...pageInput,
    }),
    permission: "campaigns.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const q = validate(CampaignListQuery, { page: args.page, pageSize: args.limit, status: args.status, q: args.search });
      const r = await deps.get(CampaignsService).list(ctx, q);
      return paged(r.items.map(campaignRow), r.total, args.page, args.limit);
    },
  }),

  defineTool({
    name: "get_campaign",
    title: "Get an outreach campaign",
    description:
      'One campaign in full: status, stats, steps, audience, send window, settings (keepOpen = "Always on", daily limit, stop rules, tracking), mailboxes, and — once launched — health issues. Says what to do next.',
    input: z.object({ campaignId: id("campaign") }),
    permission: "campaigns.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const svc = deps.get(CampaignsService);
      const c = await svc.get(ctx, args.campaignId);
      const health = LIVE.includes(c.status) ? (await svc.health(ctx, c.id)).issues.map((i) => i.message) : [];
      return { ...campaignDetail(c), healthIssues: health, next: NEXT[c.status] };
    },
  }),

  defineTool({
    name: "create_campaign",
    title: "Create an outreach campaign (draft)",
    description:
      'Creates a DRAFT campaign — nothing is sent until launch_campaign is confirmed. Give the steps inline (steps) or copy a saved sequence (fromSequenceId). Audience: contacts, lead lists, a saved view or a filter. For inbound leads that keep arriving (e.g. a workflow enrolls them), set settings.keepOpen = true ("Always on"). mailboxIds come from list_mailboxes (empty = any connected mailbox). Schedule/settings fields not given take the workspace defaults.',
    input: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(1000).optional(),
      fromSequenceId: z.string().uuid().optional().describe("Copy the steps of this saved sequence (list_sequences). Ignored when steps are given."),
      steps: stepsInput.optional(),
      audience: audienceInput.optional(),
      schedule: scheduleInput.optional(),
      settings: settingsInput.optional(),
      mailboxIds: z.array(z.string().uuid()).max(50).optional().describe("Sending mailboxes (list_mailboxes). Several spread the volume."),
      startAt: startAtInput,
    }),
    permission: "campaigns.write",
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => {
      const c = await deps.get(CampaignsService).create(ctx, validate(CampaignCreateBody, args));
      return { ...campaignDetail(c), next: NEXT.draft };
    },
  }),

  defineTool({
    name: "update_campaign_steps",
    title: "Replace a campaign's steps",
    description:
      "Replaces the campaign's steps (the whole list). Only while it is a draft or paused. Once contacts are enrolled, existing steps keep their number and kind: you may edit their wording and timing, or add steps at the end, but not insert/remove/reorder (duplicate the campaign for that).",
    input: z.object({ campaignId: id("campaign"), steps: stepsInput }),
    permission: "campaigns.write",
    risk: "write",
    handler: async (ctx, args, deps) =>
      campaignDetail(await deps.get(CampaignsService).update(ctx, args.campaignId, validate(CampaignPatchBody, { steps: args.steps }))),
  }),

  defineTool({
    name: "update_campaign_audience",
    title: "Set a campaign's audience",
    description: "Sets who the campaign starts with at launch (contacts, lead lists, saved view or filter); null clears it. Draft or paused only. To add people to a launched campaign use enroll_contacts.",
    input: z.object({ campaignId: id("campaign"), audience: audienceInput.nullable() }),
    permission: "campaigns.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const c = await deps.get(CampaignsService).update(ctx, args.campaignId, validate(CampaignPatchBody, { audience: args.audience }));
      return { id: c.id, name: c.name, status: c.status, audience: c.audienceDescription, audienceDefinition: c.audience, next: "campaign_readiness shows how many of them can be contacted." };
    },
  }),

  defineTool({
    name: "update_campaign_schedule",
    title: "Set a campaign's send window and start",
    description: "Changes the send window (days, hours, time zone; only the fields given change) and/or the start time. Draft or paused only; the start cannot move once the campaign has started.",
    input: z.object({ campaignId: id("campaign"), schedule: scheduleInput.optional(), startAt: startAtInput }),
    permission: "campaigns.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      if (!args.schedule && args.startAt === undefined) throw badRequest("Give a schedule or a startAt to change.");
      const c = await deps.get(CampaignsService).update(ctx, args.campaignId, validate(CampaignPatchBody, { schedule: args.schedule, startAt: args.startAt }));
      return { id: c.id, name: c.name, window: describeWindow(c.schedule), schedule: c.schedule, startAt: c.startAt };
    },
  }),

  defineTool({
    name: "update_campaign_settings",
    title: "Change a campaign's settings or name",
    description:
      'Changes settings — keepOpen ("Always on"), dailyNewLimit, gapSeconds, stop rules, open/click tracking, unsubscribe link — and/or the name and description. Only the fields given change. Settings change only while draft or paused (pause it first); the name can change any time.',
    input: z.object({
      campaignId: id("campaign"),
      settings: settingsInput.optional(),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(1000).optional(),
    }),
    permission: "campaigns.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const c = await deps.get(CampaignsService).update(
        ctx,
        args.campaignId,
        validate(CampaignPatchBody, { settings: args.settings, name: args.name, description: args.description }),
      );
      return { id: c.id, name: c.name, description: c.description, settings: c.settings, summary: describeLimits(c) };
    },
  }),

  defineTool({
    name: "set_campaign_mailboxes",
    title: "Choose a campaign's sending mailboxes",
    description: "Sets the mailboxes the campaign sends from (ids from list_mailboxes); an empty list means any connected mailbox. Replaces the current choice. Draft or paused only.",
    input: z.object({ campaignId: id("campaign"), mailboxIds: z.array(z.string().uuid()).max(50) }),
    permission: "campaigns.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const c = await deps.get(CampaignsService).update(ctx, args.campaignId, validate(CampaignPatchBody, { mailboxIds: args.mailboxIds }));
      return { id: c.id, name: c.name, mailboxes: c.mailboxes.map((m) => ({ id: m.id, email: m.email, status: m.status })) };
    },
  }),

  defineTool({
    name: "campaign_readiness",
    title: "Can this campaign launch?",
    description:
      "Checks a campaign without changing anything: blocking problems (steps, plan, mailboxes, audience), warnings (reply tracking off, missing personalization values, channels not connected), how many of the audience can be contacted and why the rest are skipped, plus when the first emails would go out.",
    input: z.object({ campaignId: id("campaign") }),
    permission: "campaigns.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const svc = deps.get(CampaignsService);
      const c = await svc.get(ctx, args.campaignId);
      const r = await svc.readiness(ctx, c.id);
      return {
        ready: r.ready,
        problems: r.problems.map((p) => ({ field: p.field, message: p.message })),
        warnings: r.warnings,
        audience: r.audience,
        mailboxes: r.mailboxes,
        personalization: r.personalization,
        firstSendAt: firstSendAt(c, c.steps),
        limits: describeLimits(c),
        ...(c.status === "draft" ? {} : { note: `This campaign is ${c.status}; readiness matters for drafts.` }),
      };
    },
  }),

  defineTool({
    name: "send_test_step",
    title: "Send a test of an email step",
    description:
      'Sends one email step as a "[Test]" email, rendered as the engine would (personalized for contactId when given), from the chosen or the next mailbox. Nothing is counted or tracked. position is the step\'s 0-based position (get_campaign). Recipients: by default the person this connection acts as; at most 5, and only workspace members\' or the workspace\'s own mailbox addresses (to test to an outside address, use the campaign page in the app). At most 20 tests per campaign per hour.',
    input: z.object({
      campaignId: id("campaign"),
      position: z.number().int().min(0).max(49).describe("The email step's 0-based position."),
      to: z.array(z.string().trim().toLowerCase().email()).min(1).max(5).optional().describe("Where to send it. Default: your own address."),
      contactId: z.string().uuid().optional().describe("Personalize it as for this contact."),
      mailboxId: z.string().uuid().optional().describe("Send from this mailbox (list_mailboxes)."),
    }),
    permission: "campaigns.write",
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => {
      const to = [...new Set(args.to ?? [ctx.identity.email.toLowerCase()])];
      // A test reaches only the team's own inboxes through MCP: prompt-injected content cannot mail outsiders without a confirmation.
      const [members, boxes] = await Promise.all([
        deps.prisma.db.membership.findMany({ where: { workspaceId: ctx.workspace.id }, select: { user: { select: { email: true } } } }),
        deps.prisma.db.mailbox.findMany({ where: { workspaceId: ctx.workspace.id, deletedAt: null }, select: { email: true } }),
      ]);
      const allowed = new Set([ctx.identity.email, ...members.map((m) => m.user.email), ...boxes.map((b) => b.email)].map((e) => e.toLowerCase()));
      const outside = to.filter((e) => !allowed.has(e));
      if (outside.length) {
        throw badRequest(
          `Through Claude, tests go only to workspace members or the workspace's mailboxes; ${outside.join(", ")} is neither. Send to an outside address from the campaign page in Growthdesk.`,
          { to: "Not a workspace member or mailbox" },
        );
      }
      const svc = deps.get(CampaignsService);
      const results = [];
      for (const address of to) {
        results.push(await svc.testStep(ctx, args.campaignId, args.position, validate(StepTestBody, { to: address, contactId: args.contactId, mailboxId: args.mailboxId })));
      }
      return { results };
    },
  }),

  defineTool({
    name: "launch_campaign",
    title: "Launch an outreach campaign",
    description:
      "Launches a draft: enrolls everyone in its audience who may be contacted and starts sending inside its window (or schedules it for its startAt). Needs the person's confirmation — the preview says how many contacts, from which mailboxes, the daily limit and when the first emails go. Run campaign_readiness and a test first.",
    input: z.object({ campaignId: id("campaign") }),
    permission: "campaigns.launch",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const svc = deps.get(CampaignsService);
      const c = await load(ctx, deps, args.campaignId);
      if (c.status !== "draft") throw conflict(`“${c.name}” is ${c.status}; only a draft can be launched.${c.status === "paused" ? " Use resume_campaign." : ""}`);
      const r = await svc.readiness(ctx, c.id);
      if (!r.ready) {
        throw new ApiError(
          422,
          "not_ready",
          `“${c.name}” is not ready to launch: ${r.problems.map((p) => p.message).join(" ")}`,
          Object.fromEntries(r.problems.map((p) => [p.field, p.message])),
        );
      }
      const f = await sendingFacts(ctx, deps, c);
      const eligible = r.audience.eligible;
      const daily = c.settings.dailyNewLimit;
      const skipped = r.audience.skipped.map((s) => `${s.count} ${s.label}`).join(", ");
      const future = c.startAt && new Date(c.startAt).getTime() > Date.now();
      const keepOpen = c.settings.keepOpen;
      const summary = [
        `${future ? "Schedule" : "Launch"} the outreach campaign “${c.name}”${future ? ` to start ${new Date(c.startAt!).toISOString()}` : " now"}.`,
        `It enrolls ${eligible} of ${r.audience.candidates} contact${r.audience.candidates === 1 ? "" : "s"} (${r.audience.description})${skipped ? `; skipped: ${skipped}` : ""}.`,
        keepOpen ? "Always on: it stays open for people enrolled later (workflows, enroll_contacts)." : "",
        `Steps: ${f.outline}.`,
        `Sends from: ${f.mailboxes}.`,
        `Limits: ${f.limits}.`,
        eligible ? `First messages from ${f.first.toISOString()}; starting everyone takes about ${Math.ceil(eligible / daily)} sending day${Math.ceil(eligible / daily) === 1 ? "" : "s"}.` : "",
        r.warnings.length ? `Warnings: ${r.warnings.join(" ")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return {
        summary,
        details: {
          campaignId: c.id,
          name: c.name,
          eligible,
          candidates: r.audience.candidates,
          skipped: r.audience.skipped,
          mailboxes: f.mailboxes,
          dailyNewLimit: daily,
          window: describeWindow(c.schedule),
          firstSendAt: f.first,
          keepOpen,
          warnings: r.warnings,
        },
      };
    },
    handler: async (ctx, args, deps) => {
      const r = await deps.get(CampaignsService).launch(ctx, args.campaignId);
      return { status: r.campaign.status, enrolled: r.enrolled, skipped: r.skipped, warnings: r.warnings, campaign: campaignRow(r.campaign) };
    },
  }),

  defineTool({
    name: "pause_campaign",
    title: "Pause an outreach campaign",
    description: "Pauses a running or scheduled campaign at once: no more messages until it is resumed (resume_campaign). Safe; contacts keep their place.",
    input: z.object({ campaignId: id("campaign") }),
    permission: "campaigns.launch",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const c = await deps.get(CampaignsService).pause(ctx, args.campaignId);
      return { id: c.id, name: c.name, status: c.status, pausedAt: c.pausedAt, next: NEXT.paused };
    },
  }),

  defineTool({
    name: "resume_campaign",
    title: "Resume an outreach campaign",
    description: "Resumes a paused campaign: its contacts continue where they stopped, and starts that fell due during the pause are spread under the daily limit. Needs the person's confirmation.",
    input: z.object({ campaignId: id("campaign") }),
    permission: "campaigns.launch",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const c = await load(ctx, deps, args.campaignId);
      if (c.status !== "paused") throw conflict(`“${c.name}” is ${c.status}; only a paused campaign can be resumed.`);
      const f = await sendingFacts(ctx, deps, c);
      const active = c.enrollments.active;
      return {
        summary: [
          `Resume the outreach campaign “${c.name}”.`,
          `${active} contact${active === 1 ? "" : "s"} continue${active === 1 ? "s" : ""} where they stopped (${c.enrollments.paused} individually paused stay paused).`,
          `Steps: ${f.outline}.`,
          `Sends from: ${f.mailboxes}.`,
          `Limits: ${f.limits}.`,
        ].join(" "),
        details: { campaignId: c.id, name: c.name, activeEnrollments: active, mailboxes: f.mailboxes, window: describeWindow(c.schedule), dailyNewLimit: c.settings.dailyNewLimit },
      };
    },
    handler: async (ctx, args, deps) => {
      const c = await deps.get(CampaignsService).resume(ctx, args.campaignId);
      return { id: c.id, name: c.name, status: c.status };
    },
  }),

  defineTool({
    name: "stop_campaign",
    title: "Stop an outreach campaign for good",
    description: "Stops a scheduled, running or paused campaign permanently: every open enrollment ends and nothing more is sent. It cannot be restarted (duplicate_campaign to run it again). To hold it temporarily use pause_campaign. Needs the person's confirmation.",
    input: z.object({ campaignId: id("campaign") }),
    permission: "campaigns.launch",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const c = await load(ctx, deps, args.campaignId);
      if (c.status === "draft") throw conflict(`“${c.name}” is a draft and has not started; delete_campaign removes it.`);
      if (!LIVE.includes(c.status)) throw conflict(`“${c.name}” is already ${c.status}.`);
      const open = c.enrollments.active + c.enrollments.paused;
      return {
        summary: `Stop the outreach campaign “${c.name}” (${c.status}) for good: ${open} contact${open === 1 ? "'s" : "s'"} sequence${open === 1 ? "" : "s"} end now and nothing more is sent. This cannot be undone — pause_campaign holds it instead.`,
        details: { campaignId: c.id, name: c.name, status: c.status, openEnrollments: open },
      };
    },
    handler: async (ctx, args, deps) => {
      const c = await deps.get(CampaignsService).stop(ctx, args.campaignId);
      return { id: c.id, name: c.name, status: c.status };
    },
  }),

  defineTool({
    name: "duplicate_campaign",
    title: "Duplicate an outreach campaign",
    description: 'Copies a campaign — steps, audience, window, settings, mailboxes — as a new draft "<name> (copy)". The way to rerun a completed or stopped campaign, or restructure one with enrollments.',
    input: z.object({ campaignId: id("campaign") }),
    permission: "campaigns.write",
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => ({ ...campaignDetail(await deps.get(CampaignsService).duplicate(ctx, args.campaignId)), next: NEXT.draft }),
  }),

  defineTool({
    name: "delete_campaign",
    title: "Delete an outreach campaign",
    description: "Deletes a draft, paused, completed or stopped campaign (pause or stop a running one first). Its open enrollments end. Needs the person's confirmation.",
    input: z.object({ campaignId: id("campaign") }),
    permission: "campaigns.write",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const c = await load(ctx, deps, args.campaignId);
      if (c.status === "running" || c.status === "scheduled") throw conflict(`“${c.name}” is ${c.status}. Pause or stop it before deleting it.`);
      const open = c.enrollments.active + c.enrollments.paused;
      return {
        summary: `Delete the outreach campaign “${c.name}” (${c.status}, ${c.stats.enrolled} enrolled, ${c.stats.sent} sent).${open ? ` ${open} open enrollment${open === 1 ? "" : "s"} end now.` : ""} It disappears from the campaign list.`,
        details: { campaignId: c.id, name: c.name, status: c.status, openEnrollments: open, sent: c.stats.sent },
      };
    },
    handler: async (ctx, args, deps) => deps.get(CampaignsService).remove(ctx, args.campaignId),
  }),

  defineTool({
    name: "campaign_health",
    title: "Campaign health and per-step numbers",
    description:
      "For a launched campaign: what is holding it back (disconnected mailboxes, contacts stuck on errors or long past due, failed enrollments to retry) and per-step numbers (sent, opened, clicked, bounced, waiting, failed). Use it for reports.",
    input: z.object({ campaignId: id("campaign") }),
    permission: "campaigns.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const svc = deps.get(CampaignsService);
      const c = await svc.get(ctx, args.campaignId);
      const [health, steps] = await Promise.all([svc.health(ctx, c.id), svc.stepStats(ctx, c.id)]);
      const { updatedAt: _u, ...stats } = c.stats;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        stats,
        enrollments: c.enrollments,
        issues: health.issues.map((i) => i.message),
        steps: steps.map((s) => ({
          position: s.position,
          type: s.type,
          waiting: s.waiting,
          ...(s.messages ? { messages: s.messages } : {}),
          succeeded: s.executions.succeeded,
          failed: s.executions.failed,
          skipped: s.executions.skipped,
        })),
        ...(LIVE.includes(c.status) ? {} : { note: c.status === "draft" ? "A draft has no health yet; use campaign_readiness." : `This campaign is ${c.status}.` }),
      };
    },
  }),
];
