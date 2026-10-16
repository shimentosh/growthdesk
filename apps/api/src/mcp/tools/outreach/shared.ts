import { z } from "zod";
import { CampaignSettingsInput, STEP_TYPES, StepInput, nextOpening } from "@growthdesk/shared";
import { parseWith } from "../../../common/decorators.js";
import { configOf, readSchedule, readSettings } from "../../../campaigns/campaign-config.js";
import type { McpCtx, McpDeps } from "../../tool.js";

/*
 * Helpers shared by the outreach (cold email sequences / campaigns) tools:
 * argument pieces with descriptions written for the model, and the compact
 * shapes results are cut down to. Validation always ends at the same shared
 * schemas the HTTP controllers use (parseWith + the service's own merge).
 */

/** Parses with a controller's schema; a failure is the same 400 (with field errors) the HTTP API answers. */
export const validate = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => parseWith(schema, value);

export const id = (what: string) => z.string().uuid().describe(`The ${what} id (from the matching list_ tool).`);

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2d 3h", "45m", "now". */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (!m) return "0m";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const r = m % 60;
  return [d ? `${d}d` : "", h ? `${h}h` : "", r ? `${r}m` : ""].filter(Boolean).join(" ");
}

/** "Mon–Fri 09:00–17:00 (Europe/London)" for a stored schedule. */
export function describeWindow(raw: unknown): string {
  const s = readSchedule(raw);
  const days = [...s.days].sort((a, b) => a - b);
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  const dayText = days.length === 7 ? "every day" : contiguous && days.length > 2 ? `${DAY_NAMES[days[0]!]}–${DAY_NAMES[days[days.length - 1]!]}` : days.map((d) => DAY_NAMES[d]).join(", ");
  const hours = s.from === s.to ? "all day" : `${s.from}–${s.to}`;
  return `${dayText}, ${hours} (${s.timezone})`;
}

/** One line per step, for previews: "1. email “Quick question” · 2. wait 2d · 3. email (reply in thread)". */
export function describeSteps(steps: { type: string; config: unknown }[]): string {
  if (!steps.length) return "no steps";
  return steps
    .map((s, i) => {
      const cfg = configOf(s);
      const delay = Number(cfg.delayMinutes ?? 0);
      const wait = delay > 0 && s.type !== "wait" ? ` after ${duration(delay)}` : "";
      if (s.type === "wait") return `${i + 1}. wait ${duration(delay)}`;
      if (s.type === "email") {
        const subject = cfg.subject?.trim() ? `“${cfg.subject.trim().slice(0, 60)}”` : cfg.templateId ? "(template)" : "(reply in thread)";
        return `${i + 1}. email ${subject}${wait}`;
      }
      return `${i + 1}. ${s.type.replace("_", " ")}${wait}`;
    })
    .join(" · ");
}

/** A step as the model reads it: position (0-based, as send_test_step wants), kind, config. */
export const stepOut = (s: { position: number; type: string; config: unknown }) => ({ position: s.position, type: s.type, config: s.config });

/** When the first contacts would start, given the campaign's schedule, start date and first step's delay. */
export function firstSendAt(c: { schedule: unknown; startAt: Date | string | null }, steps: { config: unknown }[], now = new Date()): Date {
  const start = c.startAt ? new Date(c.startAt).getTime() : 0;
  const delay = Math.max(0, Number(configOf(steps[0] ?? { config: {} }).delayMinutes ?? 0)) * 60_000;
  return nextOpening(readSchedule(c.schedule), new Date(Math.max(now.getTime(), start) + delay));
}

/** The limits a preview states: daily new contacts, gap, window, stop rules, always-on. */
export function describeLimits(c: { schedule: unknown; settings: unknown }): string {
  const s = readSettings(c.settings);
  const stops = [s.stopOnReply && "reply", s.stopOnAutoReply && "auto-reply", s.stopOnMeeting && "meeting booked", s.stopOnDealWon && "deal won"].filter(Boolean);
  return [
    `at most ${s.dailyNewLimit} new contact${s.dailyNewLimit === 1 ? "" : "s"} a day, ${s.gapSeconds}s apart`,
    `sending ${describeWindow(c.schedule)}`,
    stops.length ? `stops on ${stops.join(", ")}` : "never stops early",
    s.keepOpen ? "Always on (stays open for people enrolled later)" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** The sending mailboxes a campaign would use: its chosen ones, else every connected mailbox in the workspace. */
export async function sendingMailboxes(ctx: McpCtx, deps: McpDeps, chosen: { email: string; status: string }[]): Promise<string> {
  if (chosen.length) {
    const ok = chosen.filter((m) => m.status === "connected").map((m) => m.email);
    const down = chosen.filter((m) => m.status !== "connected").map((m) => `${m.email} (${m.status})`);
    return [ok.join(", "), down.length ? `not connected: ${down.join(", ")}` : ""].filter(Boolean).join("; ") || "none connected";
  }
  const boxes = await deps.prisma.db.mailbox.findMany({ where: { workspaceId: ctx.workspace.id, deletedAt: null, status: "connected" }, select: { email: true }, orderBy: { email: "asc" }, take: 20 });
  return boxes.length ? `any connected mailbox (${boxes.map((b) => b.email).join(", ")})` : "no connected mailbox";
}

/* ─── Argument pieces ─────────────────────────────────────────────────────── */

export const STEP_REFERENCE = `Steps run top to bottom; each step's config.delayMinutes waits before it runs (two messages of the same kind back to back are always ≥ 1 day apart). Kinds:
- email: {subject, body} or {templateId}. The FIRST email needs a subject; a later email with an empty subject replies in the same thread ("Re: …"). Plain text; personalize with {{first_name|there}} (always give a fallback after "|", or contacts missing that value fail at that step).
- wait: {delayMinutes} only (e.g. 2 days = 2880).
- whatsapp / telegram: {body} or {templateId}; optional integrationId. Skipped when no such channel is connected. Plan feature "multichannel".
- call_task: creates a call task for the contact's owner: {taskTitle, description, taskDueMinutes}. Multichannel.
- create_task: {taskTitle, taskType (email|follow_up|call|meeting|proposal|review_reply|qualify|custom), description, taskDueMinutes}.
- update_field: {field: status|qualification|priority|leadSource|custom.<key>, value}.
- assign_owner: {strategy: user|round_robin|campaign_owner, userId when "user"}.
- notify: tells a teammate: {message, userId (default: the contact's owner)}.
- branch: {logic: {match: all|any, rules: [{field, op, value}]}, thenLength, elseLength}: the next thenLength steps run when the rules match, the elseLength after them when not; then both rejoin. Fields: replied, opened, clicked, has_phone, has_email, status, qualification, priority, job_title, company, country, tag, custom.<key>; ops: is, is_not, contains, gt, lt. No branch inside a branch. Plan feature "branching".
- end: finishes the contact's run.
Variables: first_name, last_name, full_name, email, phone, job_title, company, company_domain, website, city, country, owner_name, sender_name, sender_email, unsubscribe_url, custom.<key> (see get_step_reference).`;

export const stepsInput = z
  .array(StepInput)
  .max(50)
  .describe(`The whole list of steps, in order (it replaces any existing list). Example: [{"type":"email","config":{"subject":"Quick question, {{first_name|there}}","body":"Hi {{first_name|there}}, …"}},{"type":"wait","config":{"delayMinutes":2880}},{"type":"email","config":{"body":"Just bumping this up, {{first_name|there}}."}}].\n${STEP_REFERENCE}`);

/** Step kinds, for descriptions. */
export const STEP_KINDS = STEP_TYPES.join(", ");

export const scheduleInput = z
  .object({
    timezone: z.string().max(64).optional().describe("IANA time zone the window is in, e.g. Europe/London. Defaults to the workspace's."),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional().describe("Days it sends on: 0 = Sunday … 6 = Saturday. Default Monday–Friday [1,2,3,4,5]."),
    from: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('Window opens, "HH:MM" 24h. Default "09:00".'),
    to: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('Window closes, "HH:MM". Default "17:00". Equal from/to = all day.'),
  })
  .describe("The send window. Only the fields given change; the rest keep their current (or the workspace default) values.");

const settingsShape = CampaignSettingsInput.shape;
export const settingsInput = z
  .object({
    keepOpen: z.boolean().optional().describe('"Always on": stays running after everyone finishes, waiting for people a workflow or a teammate enrolls later (e.g. new inbound leads); may launch with an empty audience.'),
    dailyNewLimit: z.number().int().min(1).max(5000).optional().describe("New contacts started per day (default 50). Keep it modest per mailbox for deliverability (20–50)."),
    gapSeconds: z.number().int().min(0).max(3600).optional().describe("Seconds between two new starts (default 120)."),
    stopOnReply: z.boolean().optional().describe("Stop a contact's sequence when they reply (default true; needs reply tracking/IMAP on the mailbox)."),
    stopOnAutoReply: z.boolean().optional().describe("Also stop on out-of-office/auto replies (default false)."),
    stopOnMeeting: z.boolean().optional().describe("Stop when a meeting is booked (default true)."),
    stopOnDealWon: z.boolean().optional().describe("Stop when the contact's deal is won (default true)."),
    trackOpens: z.boolean().optional().describe("Open tracking pixel (default false; off is better for cold email deliverability)."),
    trackClicks: z.boolean().optional().describe("Rewrite links for click tracking (default false)."),
    unsubscribeLink: z.boolean().optional().describe("Add an unsubscribe footer (default true)."),
  })
  .describe("Campaign settings. Only the fields given change.");

// Every shared campaign setting is offered (compile-time check against CampaignSettingsInput).
const _allSettingsOffered: [Exclude<keyof typeof settingsShape, keyof typeof settingsInput.shape>] extends [never] ? true : false = true;
void _allSettingsOffered;

export const audienceInput = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("contacts"), contactIds: z.array(z.string().uuid()).max(50000).describe("Contact ids (search_contacts / resolve them first).") }),
    z.object({ type: z.literal("lists"), listIds: z.array(z.string().uuid()).min(1).max(50).describe("Lead list ids; only contacts at the lead stage on them are enrolled.") }),
    z.object({ type: z.literal("view"), viewId: z.string().uuid().describe("A saved contact view's id.") }),
    z.object({
      type: z.literal("filter"),
      filter: z
        .record(z.string(), z.unknown())
        .describe(
          'A contact filter, e.g. {"tag":["webinar"],"stage":["lead"],"hasEmail":true}. Keys: q, status[], qualification[], priority[], ownerId (uuid|"me"|"none"), companyId, tag[], leadSource, hasEmail, hasPhone, noNextAction, createdAfter, createdBefore, campaignId, stage[], listId, archived.',
        ),
    }),
  ])
  .describe("Who the campaign starts with when it launches. Eligibility (unsubscribed, bounced, suppressed, do-not-contact, no email) is applied at launch.");

/** Compact list row of a campaign DTO (CampaignsService.list/get). */
export function campaignRow(c: {
  id: string;
  name: string;
  status: string;
  audienceDescription: string;
  settings: { keepOpen: boolean; dailyNewLimit: number };
  mailboxes: { email: string; status: string }[];
  stepCount: number;
  stepTypes: string[];
  stats: Record<string, unknown>;
  enrollments: Record<string, number>;
  startAt: Date | null;
  startedAt: Date | null;
  updatedAt: Date;
}) {
  const { updatedAt: _u, ...stats } = c.stats;
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    alwaysOn: c.settings.keepOpen,
    audience: c.audienceDescription,
    stepCount: c.stepCount,
    channels: [...new Set(c.stepTypes)],
    mailboxes: c.mailboxes.map((m) => (m.status === "connected" ? m.email : `${m.email} (${m.status})`)),
    stats,
    enrollments: c.enrollments,
    ...(c.startAt ? { startAt: c.startAt } : {}),
    ...(c.startedAt ? { startedAt: c.startedAt } : {}),
    updatedAt: c.updatedAt,
  };
}

export const preview = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);
