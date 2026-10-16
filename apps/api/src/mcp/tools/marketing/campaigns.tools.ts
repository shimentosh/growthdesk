import { z } from "zod";
import { MARKETING_CAMPAIGN_STATUSES, MARKETING_SEND_STATUSES, MarketingCampaignInput, MarketingTestInput, patchOf, type MarketingCampaignInputT } from "@growthdesk/shared";
import { parseWith } from "../../../common/decorators.js";
import { badRequest, conflict } from "../../../common/errors.js";
import { MarketingCampaignsService } from "../../../marketing/campaigns.service.js";
import { defineTool, pageInput, paged, type McpCtx, type McpDeps } from "../../tool.js";
import { allowanceLine, emailAllowance, inZone, outline, scheduleStillValid, scheduleTrouble } from "./helpers.js";

/*
 * Marketing (newsletter) campaigns. Permissions as marketing.controller.ts:
 * marketing.read to look, marketing.write to draft, marketing.send for test
 * sends, sending, scheduling, pausing, resuming and canceling.
 *
 * Sending, scheduling, resuming, canceling and deleting are important: the
 * preview runs the same readiness check the app does, counts the recipients
 * who are eligible right now (consent, subscription, suppressions), names the
 * sender and the allowance it uses. Sending and scheduling also pin the
 * draft's version: if it is edited before the user approves, confirm_action
 * refuses and the action has to be prepared again.
 */

type Campaign = Awaited<ReturnType<MarketingCampaignsService["get"]>>;

const campaignId = z.string().uuid().describe("The campaign's id (from list_marketing_campaigns).");
const version = z.string().max(40).optional().describe("Set automatically when the action is prepared — leave it out.");

const S = MarketingCampaignInput.shape;
const uuid = z.string().uuid();

/** The campaign fields the model may set; mapped to MarketingCampaignInput by toCampaignInput. */
const campaignFields = {
  subject: S.subject.describe("Subject line. Personalisation tokens work, e.g. \"{{first_name|Hi}}, our October news\"."),
  preheader: S.preheader.describe("The preview text inbox apps show after the subject."),
  fromName: S.fromName.describe("Sender name, e.g. \"Acme\". Defaults to the workspace's marketing from-name."),
  fromEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .optional()
    .describe("Sender address, e.g. news@mail.yourbrand.com. The part after @ must be one of the workspace's sending domains (marketing_setup_status). Default: news@ the first verified domain."),
  replyTo: S.replyTo.describe("Where replies go (empty for the sender address)."),
  designId: uuid.optional().describe("Copies this design's blocks and theme into the campaign (on update: re-copies, replacing the campaign's content)."),
  listIds: z.array(uuid).max(50).optional().describe("Lists to send to (from list_lists). Only subscribed members with marketing consent and no suppression receive it."),
  excludeListIds: z.array(uuid).max(50).optional().describe("Lists whose members are left out."),
  viewId: uuid.nullable().optional().describe("A saved contact view used as a segment: only list members it matches are included. null clears it."),
  trackOpens: S.trackOpens,
  trackClicks: S.trackClicks,
};

type CampaignArgs = { [K in keyof typeof campaignFields]?: z.output<(typeof campaignFields)[K]> } & { name?: string };

/** The tool's arguments as the service's MarketingCampaignInput (fromEmail → local part + sending domain; audience merged with the current one). */
async function toCampaignInput(ctx: McpCtx, deps: McpDeps, args: CampaignArgs, current?: Campaign): Promise<Partial<MarketingCampaignInputT>> {
  const out: Record<string, unknown> = {};
  for (const k of ["name", "subject", "preheader", "fromName", "replyTo", "designId", "trackOpens", "trackClicks"] as const) {
    if (args[k] !== undefined) out[k] = args[k];
  }
  if (args.fromEmail !== undefined) {
    const at = args.fromEmail.lastIndexOf("@");
    if (at < 1) throw badRequest("Give the sender as a full address, e.g. news@mail.yourbrand.com", { fromEmail: "Not an email address" });
    const domain = args.fromEmail.slice(at + 1);
    const d = await deps.prisma.db.sendingDomain.findFirst({ where: { workspaceId: ctx.workspace.id, domain, deletedAt: null }, select: { id: true } });
    if (!d) throw badRequest(`${domain} is not one of this workspace's sending domains. Use one listed by marketing_setup_status, or add it in Settings → Sending domains.`, { fromEmail: "Unknown sending domain" });
    out.fromLocalPart = args.fromEmail.slice(0, at);
    out.sendingDomainId = d.id;
  }
  if (args.listIds !== undefined || args.excludeListIds !== undefined || args.viewId !== undefined) {
    const a = current?.audience ?? { listIds: [], excludeListIds: [], viewId: null };
    out.audience = {
      listIds: args.listIds ?? a.listIds,
      excludeListIds: args.excludeListIds ?? a.excludeListIds,
      viewId: args.viewId !== undefined ? args.viewId : a.viewId,
    };
  }
  return out as Partial<MarketingCampaignInputT>;
}

const sender = (c: Campaign) => (c.fromEmail ? `${c.fromName} <${c.fromEmail}>` : null);

async function listNames(ctx: McpCtx, deps: McpDeps, ids: string[]) {
  if (!ids.length) return [];
  const rows = await deps.prisma.db.marketingList.findMany({ where: { workspaceId: ctx.workspace.id, id: { in: ids } }, select: { id: true, name: true, archivedAt: true } });
  return rows.map((r) => ({ id: r.id, name: r.name, ...(r.archivedAt ? { archived: true } : {}) }));
}

function brief(c: Campaign, tz: string) {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    subject: c.subject,
    from: sender(c),
    ...(c.scheduledAt ? { scheduledAt: c.scheduledAt, scheduledLocal: inZone(c.scheduledAt, tz) } : {}),
    ...(c.status === "draft" ? {} : { recipients: c.stats.recipients, sent: c.stats.sent, uniqueOpens: c.stats.uniqueOpens, uniqueClicks: c.stats.uniqueClicks }),
    ...(c.pausedReason ? { pausedReason: c.pausedReason } : {}),
    updatedAt: c.updatedAt,
  };
}

async function detail(ctx: McpCtx, deps: McpDeps, c: Campaign, withReadiness: boolean) {
  const svc = deps.get(MarketingCampaignsService);
  const [include, exclude, ready] = await Promise.all([
    listNames(ctx, deps, c.audience.listIds),
    listNames(ctx, deps, c.audience.excludeListIds),
    withReadiness && c.status === "draft" ? svc.readiness(ctx, c.id) : null,
  ]);
  return {
    ...brief(c, ctx.workspace.timezone),
    preheader: c.preheader,
    fromName: c.fromName,
    replyTo: c.replyTo || null,
    audience: { lists: include, excludeLists: exclude, viewId: c.audience.viewId },
    tracking: { opens: c.trackOpens, clicks: c.trackClicks },
    content: outline(c.blocks),
    ...(c.status === "draft" ? {} : { stats: c.stats, startedAt: c.startedAt, completedAt: c.completedAt, canceledAt: c.canceledAt }),
    ...(ready ? { readiness: ready } : {}),
  };
}

/** The campaign as of the preview, so confirm_action can tell whether it changed since the user saw it. */
const versionOf = (c: Campaign) => new Date(c.updatedAt).toISOString();

async function current(ctx: McpCtx, deps: McpDeps, id: string, pinned?: string) {
  const c = await deps.get(MarketingCampaignsService).get(ctx, id);
  if (pinned && versionOf(c) !== pinned) throw conflict(`"${c.name}" was changed after this action was prepared. Prepare it again so the user can review the current version.`);
  return c;
}

/** Everything the user should see before a campaign goes out: recipients, sender, subject, lists, allowance. */
async function sendPreview(ctx: McpCtx, deps: McpDeps, id: string, when: Date | null) {
  const svc = deps.get(MarketingCampaignsService);
  const c = await svc.get(ctx, id);
  if (c.status !== "draft") {
    throw conflict(c.status === "scheduled" ? `"${c.name}" is already scheduled (${inZone(c.scheduledAt, ctx.workspace.timezone)}). Unschedule it first to change it.` : `Only a draft can be sent; "${c.name}" is ${c.status}. Duplicate it to send it again.`);
  }
  const ready = await svc.readiness(ctx, id);
  if (!ready.ready) throw badRequest(`"${c.name}" is not ready to send: ${ready.problems.join(" ")}`);
  const [include, exclude, allowance] = await Promise.all([listNames(ctx, deps, c.audience.listIds), listNames(ctx, deps, c.audience.excludeListIds), emailAllowance(ctx, deps)]);
  const tz = ctx.workspace.timezone;
  const summary = [
    `${when ? "Schedule" : "Send NOW"} the email campaign "${c.name}"`,
    `to ${ready.recipients.toLocaleString()} people`,
    `(lists: ${include.map((l) => l.name).join(", ")}${exclude.length ? `; excluding ${exclude.map((l) => l.name).join(", ")}` : ""}${c.audience.viewId ? "; filtered by a saved view" : ""})`,
    when ? `for ${inZone(when, tz)}.` : "— it starts going out immediately.",
    `Subject: "${c.subject}". From: ${sender(c)}.`,
    allowanceLine(allowance, ready.recipients),
    when ? "Eligibility (consent, subscription, suppressions) is checked again for each person as it sends." : "Eligibility is checked again for each person as it sends.",
  ].join(" ");
  return {
    summary,
    details: {
      campaignId: c.id,
      name: c.name,
      subject: c.subject,
      from: sender(c),
      recipients: ready.recipients,
      lists: include,
      excludeLists: exclude,
      ...(when ? { scheduledAt: when.toISOString(), scheduledLocal: inZone(when, tz) } : {}),
      allowance,
    },
    version: versionOf(c),
  };
}

export const CAMPAIGN_TOOLS = [
  defineTool({
    name: "list_marketing_campaigns",
    title: "List email campaigns",
    description: "Marketing (newsletter) campaigns, newest first: id, name, status, subject, sender, schedule and headline numbers. Filter by status. (Outreach sequences are separate tools.)",
    input: z.object({ status: z.enum(MARKETING_CAMPAIGN_STATUSES).optional(), search: z.string().trim().max(120).optional(), ...pageInput }),
    permission: "marketing.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const q = args.search?.toLowerCase();
      const rows = (await deps.get(MarketingCampaignsService).list(ctx)).filter((c) => (!args.status || c.status === args.status) && (!q || c.name.toLowerCase().includes(q) || c.subject.toLowerCase().includes(q)));
      const start = (args.page - 1) * args.limit;
      return paged(rows.slice(start, start + args.limit).map((c) => brief(c, ctx.workspace.timezone)), rows.length, args.page, args.limit);
    },
  }),

  defineTool({
    name: "get_marketing_campaign",
    title: "Get an email campaign",
    description: "One campaign: subject, preheader, sender, audience lists, an outline of its content, numbers once sent — and, for a draft, its readiness (problems that stop it from sending, and how many people it would reach).",
    input: z.object({ campaignId }),
    permission: "marketing.read",
    risk: "read",
    handler: async (ctx, args, deps) => detail(ctx, deps, await deps.get(MarketingCampaignsService).get(ctx, args.campaignId), true),
  }),

  defineTool({
    name: "create_marketing_campaign",
    title: "Create an email campaign (draft)",
    description:
      "Creates a draft marketing campaign. Typically: name, subject, preheader, designId (its content is copied in), listIds. Sender defaults to the workspace's from-name and news@ its first verified sending domain. Nothing is sent. Returns the campaign with its readiness.",
    input: z.object({ name: S.name, ...campaignFields }),
    permission: "marketing.write",
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => {
      const svc = deps.get(MarketingCampaignsService);
      const input = parseWith(MarketingCampaignInput, await toCampaignInput(ctx, deps, args));
      return detail(ctx, deps, await svc.create(ctx, input), true);
    },
  }),

  defineTool({
    name: "update_marketing_campaign",
    title: "Edit an email campaign",
    description:
      "Changes a draft campaign; only the fields given change (listIds/excludeListIds/viewId each replace that part of the audience). To change the content, edit the design and pass designId again. A scheduled campaign must be unscheduled first; a sent one can only be duplicated. Returns the campaign with its readiness.",
    input: z.object({ campaignId, name: S.name.optional(), ...campaignFields }),
    permission: "marketing.write",
    risk: "write",
    handler: async (ctx, { campaignId: id, ...args }, deps) => {
      const svc = deps.get(MarketingCampaignsService);
      const before = await svc.get(ctx, id);
      const input = parseWith(patchOf(MarketingCampaignInput), await toCampaignInput(ctx, deps, args, before));
      if (!Object.keys(input).length) throw badRequest("Nothing to change.");
      return detail(ctx, deps, await svc.update(ctx, id, input), true);
    },
  }),

  defineTool({
    name: "marketing_campaign_readiness",
    title: "Check a campaign is ready",
    description: "Everything that stops a campaign from being sent (email service, verified domain, sender, subject, company address, content, lists), in plain words, and how many people it would reach right now. Empty problems = ready.",
    input: z.object({ campaignId }),
    permission: "marketing.read",
    risk: "read",
    handler: async (ctx, args, deps) => deps.get(MarketingCampaignsService).readiness(ctx, args.campaignId),
  }),

  defineTool({
    name: "send_test_email",
    title: "Send a test email",
    description:
      "Sends the campaign's current content, marked [Test], to up to 5 addresses — by default only to you (the connected user). Needs a connected email service and a verified sending domain. Each test email counts against the month's marketing email allowance.",
    input: z.object({ campaignId, emails: MarketingTestInput.shape.emails.optional().describe("Up to 5 addresses. Leave out to send only to yourself.") }),
    permission: "marketing.send",
    risk: "write",
    idempotent: false,
    annotations: { openWorldHint: true },
    handler: async (ctx, args, deps) => {
      const emails = args.emails?.length ? args.emails : [ctx.identity.email];
      const r = await deps.get(MarketingCampaignsService).testSend(ctx, args.campaignId, parseWith(MarketingTestInput, { emails }).emails);
      const allowance = await emailAllowance(ctx, deps);
      return {
        results: r.results,
        note: `Test emails count against the monthly marketing email allowance${allowance.left === null ? " (this plan has no limit)" : ` — ${allowance.left.toLocaleString()} left this month`}.`,
      };
    },
  }),

  defineTool({
    name: "schedule_marketing_campaign",
    title: "Schedule an email campaign",
    description:
      "Schedules a ready draft to go out at a set time. scheduledAt is an ISO 8601 date-time with its UTC offset (e.g. 2026-10-20T09:00:00-04:00); convert the user's wording using the workspace timezone (whoami). At least 2 minutes ahead. The user sees recipients, sender, time and allowance before approving.",
    input: z.object({ campaignId, scheduledAt: z.iso.datetime({ offset: true }).describe("When to send, ISO 8601 with offset."), campaignVersion: version }),
    permission: "marketing.send",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const at = new Date(args.scheduledAt);
      const trouble = scheduleTrouble(at);
      if (trouble) throw badRequest(trouble, { scheduledAt: trouble });
      const p = await sendPreview(ctx, deps, args.campaignId, at);
      return { summary: p.summary, details: p.details, args: { ...args, campaignVersion: p.version } };
    },
    handler: async (ctx, args, deps) => {
      await current(ctx, deps, args.campaignId, args.campaignVersion);
      const at = new Date(args.scheduledAt);
      if (!scheduleStillValid(at)) throw conflict(`The approved time (${inZone(at, ctx.workspace.timezone)}) is now less than a minute away or past. Prepare the schedule again with a new time.`);
      const c = await deps.get(MarketingCampaignsService).send(ctx, args.campaignId, at);
      return brief(c, ctx.workspace.timezone);
    },
  }),

  defineTool({
    name: "send_marketing_campaign_now",
    title: "Send an email campaign now",
    description: "Starts sending a ready draft immediately to everyone eligible on its lists. The user sees recipients, sender, subject and allowance before approving.",
    input: z.object({ campaignId, campaignVersion: version }),
    permission: "marketing.send",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const p = await sendPreview(ctx, deps, args.campaignId, null);
      return { summary: p.summary, details: p.details, args: { ...args, campaignVersion: p.version } };
    },
    handler: async (ctx, args, deps) => {
      await current(ctx, deps, args.campaignId, args.campaignVersion);
      const c = await deps.get(MarketingCampaignsService).send(ctx, args.campaignId);
      return { ...brief(c, ctx.workspace.timezone), note: "Sending has started; it goes out in batches. Check progress with marketing_campaign_report." };
    },
  }),

  defineTool({
    name: "unschedule_marketing_campaign",
    title: "Unschedule an email campaign",
    description: "Takes a scheduled campaign back to a draft (nothing is sent), so it can be edited or rescheduled.",
    input: z.object({ campaignId }),
    permission: "marketing.send",
    risk: "write",
    handler: async (ctx, args, deps) => brief(await deps.get(MarketingCampaignsService).unschedule(ctx, args.campaignId), ctx.workspace.timezone),
  }),

  defineTool({
    name: "pause_marketing_campaign",
    title: "Pause an email campaign",
    description: "Pauses a sending or scheduled campaign at once (safe: it stops email going out). resume_marketing_campaign continues it; cancel_marketing_campaign stops it for good.",
    input: z.object({ campaignId }),
    permission: "marketing.send",
    risk: "write",
    handler: async (ctx, args, deps) => brief(await deps.get(MarketingCampaignsService).pause(ctx, args.campaignId), ctx.workspace.timezone),
  }),

  defineTool({
    name: "resume_marketing_campaign",
    title: "Resume an email campaign",
    description: "Resumes a paused campaign: sending continues (or it goes back to its schedule). The user sees how many emails are still to go and the reason it was paused before approving.",
    input: z.object({ campaignId }),
    permission: "marketing.send",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const c = await deps.get(MarketingCampaignsService).get(ctx, args.campaignId);
      if (c.status !== "paused") throw conflict(`Only a paused campaign can be resumed; "${c.name}" is ${c.status}.`);
      const tz = ctx.workspace.timezone;
      const allowance = await emailAllowance(ctx, deps);
      let toGo: number;
      let what: string;
      if (c.startedAt) {
        toGo = await deps.prisma.db.marketingSend.count({ where: { workspaceId: ctx.workspace.id, campaignId: c.id, status: "queued", sentAt: null } });
        what = `Resume sending "${c.name}": ${toGo.toLocaleString()} emails still to go (${c.stats.sent.toLocaleString()} already sent).`;
      } else {
        toGo = (await deps.get(MarketingCampaignsService).readiness(ctx, c.id)).recipients;
        what = c.scheduledAt
          ? `Put "${c.name}" back on its schedule (${inZone(c.scheduledAt, tz)}${new Date(c.scheduledAt).getTime() <= Date.now() ? " — that time has passed, so it starts sending right away" : ""}) to about ${toGo.toLocaleString()} people.`
          : `Start sending "${c.name}" now to about ${toGo.toLocaleString()} people.`;
      }
      return {
        summary: `${what} It was paused: ${c.pausedReason || "no reason recorded"}. From: ${sender(c)}. ${allowanceLine(allowance, toGo)}`,
        details: { campaignId: c.id, name: c.name, emailsToGo: toGo, pausedReason: c.pausedReason, allowance },
      };
    },
    // No version pin here: opens and clicks arriving on a paused campaign update it. The service re-checks the status.
    handler: async (ctx, args, deps) => brief(await deps.get(MarketingCampaignsService).resume(ctx, args.campaignId), ctx.workspace.timezone),
  }),

  defineTool({
    name: "cancel_marketing_campaign",
    title: "Cancel an email campaign",
    description: "Stops a sending, scheduled or paused campaign for good: emails not yet sent are skipped. It cannot be restarted (duplicate it to send again).",
    input: z.object({ campaignId }),
    permission: "marketing.send",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const c = await deps.get(MarketingCampaignsService).get(ctx, args.campaignId);
      if (!["sending", "scheduled", "paused"].includes(c.status)) throw conflict(`Only a sending, scheduled or paused campaign can be canceled; "${c.name}" is ${c.status}.`);
      const queued = c.startedAt ? await deps.prisma.db.marketingSend.count({ where: { workspaceId: ctx.workspace.id, campaignId: c.id, status: "queued", sentAt: null } }) : 0;
      const summary = c.startedAt
        ? `Cancel "${c.name}" for good: ${queued.toLocaleString()} emails not yet sent are skipped; the ${c.stats.sent.toLocaleString()} already sent stay sent.`
        : `Cancel "${c.name}" for good (${c.status}${c.scheduledAt ? `, due ${inZone(c.scheduledAt, ctx.workspace.timezone)}` : ""}): nothing will be sent. To send it later instead, use unschedule_marketing_campaign.`;
      return { summary, details: { campaignId: c.id, name: c.name, status: c.status, notYetSent: queued, alreadySent: c.stats.sent } };
    },
    handler: async (ctx, args, deps) => brief(await deps.get(MarketingCampaignsService).cancel(ctx, args.campaignId), ctx.workspace.timezone),
  }),

  defineTool({
    name: "duplicate_marketing_campaign",
    title: "Duplicate an email campaign",
    description: "Copies a campaign (content, sender, audience) as a new draft named \"<name> (copy)\" — the way to send a sent or canceled campaign again.",
    input: z.object({ campaignId }),
    permission: "marketing.write",
    risk: "write",
    idempotent: false,
    handler: async (ctx, args, deps) => brief(await deps.get(MarketingCampaignsService).duplicate(ctx, args.campaignId), ctx.workspace.timezone),
  }),

  defineTool({
    name: "delete_marketing_campaign",
    title: "Delete an email campaign",
    description: "Deletes a draft, sent or canceled campaign (a scheduled, sending or paused one must be canceled first). Its report goes with it.",
    input: z.object({ campaignId }),
    permission: "marketing.write",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const c = await deps.get(MarketingCampaignsService).get(ctx, args.campaignId);
      if (["sending", "scheduled", "paused"].includes(c.status)) throw conflict(`"${c.name}" is ${c.status}. Cancel it before deleting it.`);
      return {
        summary: `Delete the ${c.status} campaign "${c.name}"${c.status === "draft" ? "" : ` (sent to ${c.stats.sent.toLocaleString()} people; its report is removed too)`}.`,
        details: { campaignId: c.id, name: c.name, status: c.status },
      };
    },
    handler: async (ctx, args, deps) => ({ campaignId: args.campaignId, ...(await deps.get(MarketingCampaignsService).remove(ctx, args.campaignId)) }),
  }),

  defineTool({
    name: "marketing_campaign_report",
    title: "Email campaign report",
    description: "How a campaign did: recipients, sent, delivered, failed/skipped, unique opens and clicks (with rates), unsubscribes, bounces, complaints, the most-clicked links, and recipients by status.",
    input: z.object({ campaignId }),
    permission: "marketing.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const c = await deps.get(MarketingCampaignsService).get(ctx, args.campaignId);
      const db = deps.prisma.db;
      const [byStatus, clicks] = await Promise.all([
        db.marketingSend.groupBy({ by: ["status"], where: { workspaceId: ctx.workspace.id, campaignId: c.id }, _count: { _all: true } }),
        db.domainEvent.findMany({ where: { workspaceId: ctx.workspace.id, type: "marketing.clicked", payload: { path: ["campaignId"], equals: c.id } }, select: { payload: true }, take: 5000 }),
      ]);
      const s = c.stats;
      const delivered = Math.max(0, s.sent - s.bounces);
      const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(1)}%` : "—");
      const links = new Map<string, number>();
      for (const e of clicks) {
        const url = (e.payload as { url?: unknown }).url;
        if (typeof url === "string") links.set(url, (links.get(url) ?? 0) + 1);
      }
      return {
        campaign: brief(c, ctx.workspace.timezone),
        numbers: {
          recipients: s.recipients,
          sent: s.sent,
          delivered,
          failed: s.failed,
          skipped: s.skipped,
          uniqueOpens: s.uniqueOpens,
          uniqueClicks: s.uniqueClicks,
          unsubscribes: s.unsubscribes,
          bounces: s.bounces,
          complaints: s.complaints,
        },
        rates: {
          open: pct(s.uniqueOpens, delivered),
          click: pct(s.uniqueClicks, delivered),
          clickToOpen: pct(s.uniqueClicks, s.uniqueOpens),
          unsubscribe: pct(s.unsubscribes, delivered),
          bounce: pct(s.bounces, s.sent),
          complaint: pct(s.complaints, delivered),
        },
        topLinks: [...links.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([url, firstClicks]) => ({ url, firstClicks })),
        recipientsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
        notes: [
          "Opens are approximate: some mail apps block tracking pixels and some privacy features pre-load them (machine opens are filtered out).",
          "topLinks counts each recipient's first click.",
          ...(c.status === "sending" ? ["Still sending — numbers will grow."] : []),
        ],
      };
    },
  }),

  defineTool({
    name: "list_campaign_recipients",
    title: "List a campaign's recipients",
    description: "The people a campaign was sent to, one row each: email, status (queued/sent/failed/skipped/bounced/complained), the error or skip reason, and when they opened, clicked, unsubscribed, bounced or complained.",
    input: z.object({ campaignId, status: z.enum(MARKETING_SEND_STATUSES).optional(), ...pageInput }),
    permission: "marketing.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const r = await deps.get(MarketingCampaignsService).recipients(ctx, args.campaignId, { page: args.page, pageSize: args.limit, status: args.status });
      const items = r.items.map((s) => ({
        email: s.email,
        contactId: s.contact.id,
        name: s.contact.fullName,
        status: s.status,
        ...(s.error ? { reason: s.error } : {}),
        sentAt: s.sentAt,
        ...(s.openedAt ? { openedAt: s.openedAt } : {}),
        ...(s.clickedAt ? { clickedAt: s.clickedAt } : {}),
        ...(s.unsubscribedAt ? { unsubscribedAt: s.unsubscribedAt } : {}),
        ...(s.bouncedAt ? { bouncedAt: s.bouncedAt } : {}),
        ...(s.complainedAt ? { complainedAt: s.complainedAt } : {}),
      }));
      return paged(items, r.total, args.page, args.limit);
    },
  }),
];
