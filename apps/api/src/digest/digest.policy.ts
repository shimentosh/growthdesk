import { z } from "zod";
import { addLocalDays, isValidTimeZone, localDay, startOfLocalDay, zonedParts, zonedTime } from "@growthdesk/shared";
import { ACTOR_TYPES, type ActorType } from "../common/actor.js";

/*
 * The CEO's digest (pure parts: settings, periods, rendering).
 *
 * Settings live in Workspace.settings.digest:
 *   { enabled (default true), frequency "daily" | "weekly" (default daily),
 *     hour 0–23 in the workspace's time zone (default 8), lastSentAt? ISO }
 *
 * A daily digest covers yesterday (local); a weekly one goes out on Mondays
 * and covers the seven days before. A digest is due once the local clock has
 * reached `hour` on a send day and nothing was recorded for that local day
 * yet (lastSentAt falls on an earlier local day).
 */

export const DIGEST_FREQUENCIES = ["daily", "weekly"] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export type DigestSettings = { enabled: boolean; frequency: DigestFrequency; hour: number; lastSentAt: string | null };

export const DIGEST_DEFAULTS: DigestSettings = { enabled: true, frequency: "daily", hour: 8, lastSentAt: null };

/** PUT /digest/settings: any of the three; the rest stay as they are. */
export const DigestSettingsInput = z
  .object({
    enabled: z.boolean().optional(),
    frequency: z.enum(DIGEST_FREQUENCIES).optional(),
    hour: z.number().int().min(0, "Pick an hour from 0 to 23").max(23, "Pick an hour from 0 to 23").optional(),
  })
  .strict()
  .refine((v) => v.enabled !== undefined || v.frequency !== undefined || v.hour !== undefined, "Change at least one of enabled, frequency or hour");
export type DigestSettingsInputT = z.infer<typeof DigestSettingsInput>;

export const DigestPreviewQuery = z.object({ frequency: z.enum(DIGEST_FREQUENCIES).optional() });

/** Workspace.settings → digest settings, defaults filled in; anything malformed falls back to the default. */
export function readDigestSettings(settings: unknown): DigestSettings {
  const raw = settings && typeof settings === "object" ? (settings as { digest?: unknown }).digest : undefined;
  const d = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const hour = typeof d.hour === "number" && Number.isInteger(d.hour) && d.hour >= 0 && d.hour <= 23 ? d.hour : DIGEST_DEFAULTS.hour;
  const lastSentAt = typeof d.lastSentAt === "string" && !Number.isNaN(Date.parse(d.lastSentAt)) ? d.lastSentAt : null;
  return {
    enabled: typeof d.enabled === "boolean" ? d.enabled : DIGEST_DEFAULTS.enabled,
    frequency: (DIGEST_FREQUENCIES as readonly unknown[]).includes(d.frequency) ? (d.frequency as DigestFrequency) : DIGEST_DEFAULTS.frequency,
    hour,
    lastSentAt,
  };
}

export const zoneOf = (tz: string | null | undefined) => (tz && isValidTimeZone(tz) ? tz : "UTC");

export type DigestPeriod = {
  frequency: DigestFrequency;
  timeZone: string;
  /** First local day covered, inclusive ("YYYY-MM-DD"). */
  from: string;
  /** Last local day covered, inclusive. */
  to: string;
  /** The local day the digest is sent on (the day after `to`). */
  sendDay: string;
  start: Date;
  /** Exclusive: the start of the send day. */
  end: Date;
  /** "Thursday 15 October 2026" or "5 – 11 October 2026". */
  label: string;
};

const DAY_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const SHORT_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const asUtc = (day: string) => new Date(`${day}T00:00:00Z`);

/** What a digest sent at `now` covers: yesterday, or the seven days before today. */
export function digestPeriod(frequency: DigestFrequency, now: Date, timeZone: string): DigestPeriod {
  const tz = zoneOf(timeZone);
  const today = localDay(now, tz);
  const to = addLocalDays(today, -1);
  const from = frequency === "weekly" ? addLocalDays(today, -7) : to;
  const label = frequency === "weekly" ? `${SHORT_FMT.format(asUtc(from))} – ${SHORT_FMT.format(asUtc(to))}` : DAY_FMT.format(asUtc(to));
  return { frequency, timeZone: tz, from, to, sendDay: today, start: startOfLocalDay(from, tz), end: startOfLocalDay(today, tz), label };
}

/** Weekly digests go out on Mondays (local). */
export const isSendDay = (frequency: DigestFrequency, now: Date, timeZone: string) => frequency === "daily" || zonedParts(now, zoneOf(timeZone)).weekday === 1;

/** Whether a digest should go out now: enabled, a send day, the hour reached, and nothing recorded for today (local). */
export function isDue(s: DigestSettings, now: Date, timeZone: string): boolean {
  const tz = zoneOf(timeZone);
  if (!s.enabled || !isSendDay(s.frequency, now, tz)) return false;
  if (zonedParts(now, tz).hour < s.hour) return false;
  return !s.lastSentAt || localDay(new Date(s.lastSentAt), tz) < localDay(now, tz);
}

/** When the next digest is due (for the settings card); null when it is off. */
export function nextSendAt(s: DigestSettings, now: Date, timeZone: string): Date | null {
  if (!s.enabled) return null;
  const tz = zoneOf(timeZone);
  const today = localDay(now, tz);
  const sentToday = Boolean(s.lastSentAt && localDay(new Date(s.lastSentAt), tz) >= today);
  for (let i = 0; i < 8; i++) {
    const day = addLocalDays(today, i);
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const at = zonedTime(y, m, d, s.hour, 0, tz);
    if (s.frequency === "weekly" && asUtc(day).getUTCDay() !== 1) continue;
    if (i === 0 && sentToday) continue;
    // Today, past the hour and not sent yet: the next sweep (within 15 minutes) sends it.
    return i === 0 && at < now ? now : at;
  }
  return null;
}

// ─── The digest's content ──────────────────────────────────────────────────

export type DigestPerson = { userId: string; name: string; email: string; count: number };

export type DigestData = {
  workspace: { id: string; name: string; timezone: string; currency: string };
  period: Omit<DigestPeriod, "start" | "end"> & { start: string; end: string };
  leads: { created: number; topSources: { source: string; count: number }[]; unownedNow: number };
  deals: { won: number; wonValue: number; wonOtherCurrency: number; lost: number; created: number };
  activity: {
    total: number;
    byActorType: Record<ActorType, number>;
    /** Teammates by entries: their own plus what an AI agent did for them. */
    topPeople: { userId: string; name: string; email: string; own: number; byAi: number; total: number }[];
    aiActions: number;
  };
  attention: {
    overdueTasks: { total: number; top: DigestPerson[] };
    /** Open, unread, last inbound message more than 24 hours ago. */
    waitingConversations: number;
    /** Leads (lead / sales stage) with no activity in 14 days. */
    staleLeads: number;
    /** Open deals with no open task. */
    dealsWithoutNextStep: number;
  };
  /** App paths (relative) each line points at. */
  links: { activity: string; leads: string; unownedLeads: string; deals: string; openDeals: string; tasks: string; inbox: string };
  /** Literally nothing to report: no digest is sent. */
  empty: boolean;
};

export const STALE_LEAD_DAYS = 14;
export const WAITING_HOURS = 24;

export function digestLinks(workspaceId: string): DigestData["links"] {
  const w = `/w/${workspaceId}`;
  return {
    activity: `${w}/activity`,
    leads: `${w}/leads`,
    unownedLeads: `${w}/leads?owner=none`,
    deals: `${w}/deals?view=list`,
    openDeals: `${w}/deals?view=list&status=open`,
    tasks: `${w}/tasks?view=overdue`,
    inbox: `${w}/inbox?unread=1`,
  };
}

export function isEmptyDigest(d: Pick<DigestData, "leads" | "deals" | "activity" | "attention">): boolean {
  return (
    d.leads.created === 0 &&
    d.deals.won === 0 &&
    d.deals.lost === 0 &&
    d.deals.created === 0 &&
    d.activity.total === 0 &&
    d.attention.overdueTasks.total === 0 &&
    d.attention.waitingConversations === 0 &&
    d.attention.staleLeads === 0 &&
    d.attention.dealsWithoutNextStep === 0
  );
}

const ACTOR_WORDS: Record<ActorType, string> = { user: "by teammates", ai_agent: "by AI agents", workflow: "by workflows", integration: "by integrations", system: "by Growthdesk" };

const n = (v: number) => new Intl.NumberFormat("en-US").format(v);
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

export function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: value % 1 === 0 ? 0 : 2 }).format(value);
  } catch {
    return `${n(value)} ${currency}`;
  }
}

export type RenderedDigest = { title: string; body: string; inApp: string };

/**
 * The digest as text. `body` is the email body (MailService.notification
 * renders it as one text block: line breaks kept, **bold** honoured, and in
 * plain-text mail it reads as written); each line ends with the absolute
 * link it points at, made by `url`. `inApp` is the same without the links,
 * for the bell (whose notification links to the team activity page).
 */
export function renderDigest(d: DigestData, url: (path: string) => string): RenderedDigest {
  const weekly = d.period.frequency === "weekly";
  const title = `${weekly ? "Weekly" : "Daily"} digest for ${d.workspace.name}: ${d.period.label}`;
  const sections: { heading: string; lines: { text: string; link?: string }[] }[] = [];

  const leads: { text: string; link?: string }[] = [];
  if (d.leads.created) {
    const sources = d.leads.topSources.length ? ` — top sources: ${d.leads.topSources.map((s) => `${s.source} (${n(s.count)})`).join(", ")}` : "";
    leads.push({ text: `${plural(d.leads.created, "new lead")}${sources}`, link: d.links.leads });
    if (d.leads.unownedNow) leads.push({ text: `${n(d.leads.unownedNow)} of them still ${d.leads.unownedNow === 1 ? "has" : "have"} no owner`, link: d.links.unownedLeads });
  }
  if (leads.length) sections.push({ heading: "New leads", lines: leads });

  const deals: { text: string; link?: string }[] = [];
  if (d.deals.won) {
    const other = d.deals.wonOtherCurrency ? ` (plus ${n(d.deals.wonOtherCurrency)} in other currencies)` : "";
    deals.push({ text: `${plural(d.deals.won, "deal")} won, worth ${formatMoney(d.deals.wonValue, d.workspace.currency)}${other}`, link: d.links.deals });
  }
  if (d.deals.lost) deals.push({ text: `${plural(d.deals.lost, "deal")} lost`, link: d.links.deals });
  if (d.deals.created) deals.push({ text: `${plural(d.deals.created, "new deal")}`, link: d.links.deals });
  if (deals.length) sections.push({ heading: "Deals", lines: deals });

  const activity: { text: string; link?: string }[] = [];
  if (d.activity.total) {
    const parts = ACTOR_TYPES.filter((t) => d.activity.byActorType[t]).map((t) => `${n(d.activity.byActorType[t])} ${ACTOR_WORDS[t]}`);
    activity.push({ text: `${plural(d.activity.total, "timeline entry", "timeline entries")}: ${parts.join(", ")}`, link: d.links.activity });
    if (d.activity.topPeople.length) {
      const people = d.activity.topPeople.map((p) => `${p.name || p.email} (${n(p.own)}${p.byAi ? ` + ${n(p.byAi)} by AI for them` : ""})`);
      activity.push({ text: `Most active: ${people.join(", ")}` });
    }
    if (d.activity.aiActions) activity.push({ text: `AI agents took ${plural(d.activity.aiActions, "action")}` });
  }
  if (activity.length) sections.push({ heading: "Team activity", lines: activity });

  const attention: { text: string; link?: string }[] = [];
  const a = d.attention;
  if (a.overdueTasks.total) {
    const who = a.overdueTasks.top.length ? ` — most: ${a.overdueTasks.top.map((p) => `${p.name || p.email} (${n(p.count)})`).join(", ")}` : "";
    attention.push({ text: `${plural(a.overdueTasks.total, "overdue task")}${who}`, link: d.links.tasks });
  }
  if (a.waitingConversations) attention.push({ text: `${plural(a.waitingConversations, "conversation")} unanswered for more than ${WAITING_HOURS} hours`, link: d.links.inbox });
  if (a.staleLeads) attention.push({ text: `${plural(a.staleLeads, "stale lead")} (no activity in ${STALE_LEAD_DAYS} days)`, link: d.links.leads });
  if (a.dealsWithoutNextStep) attention.push({ text: `${plural(a.dealsWithoutNextStep, "open deal")} with no next step (no open task)`, link: d.links.openDeals });
  if (attention.length) sections.push({ heading: "Needs attention", lines: attention });

  const intro = weekly ? `Here is what happened in ${d.workspace.name} from ${d.period.label}.` : `Here is what happened in ${d.workspace.name} on ${d.period.label}.`;
  const block = (withLinks: boolean, bold: boolean) =>
    [
      intro,
      ...sections.map((s) => [bold ? `**${s.heading}**` : s.heading, ...s.lines.map((l) => `• ${l.text}${withLinks && l.link ? `: ${url(l.link)}` : ""}`)].join("\n")),
    ].join("\n\n");
  return { title, body: block(true, true), inApp: block(false, false) };
}
