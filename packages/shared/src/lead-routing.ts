import { z } from "zod";
import { requiredText, text } from "./schemas.js";

/*
 * Lead routing: who owns a new lead. Rules are checked in order; the first
 * one whose conditions all hold assigns the lead — to one person, in turn
 * across a pool (round robin) or to whoever in the pool has the fewest open
 * leads (balanced). A lead no rule takes goes to the fallback, if any.
 *
 * It runs for every new, unowned contact, however it arrived (form, API,
 * Clientdesk, import, inbound message, an AI agent, by hand), shortly after
 * it lands — so list joins made in the same request count.
 */

export const ROUTING_MODES = ["round_robin", "balanced", "user"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const RoutingAssign = z
  .object({
    mode: z.enum(ROUTING_MODES).default("round_robin"),
    /** The pool: these people… */
    userIds: z.array(z.string().uuid()).max(50).default([]),
    /** …or everyone in this team (as it is when the lead arrives), instead of naming people. */
    teamId: z.string().uuid().nullable().optional(),
  })
  .refine((a) => Boolean(a.teamId) || a.userIds.length > 0, { message: "Choose a team or at least one person", path: ["userIds"] })
  .refine((a) => a.mode !== "user" || (!a.teamId && a.userIds.length === 1), { message: "Assign to one person, or use round robin for several", path: ["userIds"] });
export type RoutingAssignT = z.infer<typeof RoutingAssign>;

const words = (max: number) => z.array(text(max).transform((s) => s.trim())).max(20).default([]);

/** Every non-empty group must match (AND); within a group any value matches (OR). Text matches ignore case. */
export const RoutingWhen = z.object({
  /** The contact's lead source contains one of these ("Clientdesk", "Website", "Webinar"). */
  leadSources: words(100),
  /** On (or pending on) one of these lead lists, by name. */
  lists: words(120),
  /** Has one of these tags. */
  tags: words(50),
  /** Country is one of these. */
  countries: words(100),
});
export type RoutingWhenT = z.infer<typeof RoutingWhen>;

export const RoutingRule = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,40}$/),
  name: requiredText(120),
  enabled: z.boolean().default(true),
  when: RoutingWhen,
  assign: RoutingAssign,
});
export type RoutingRuleT = z.infer<typeof RoutingRule>;

export const LeadRoutingInput = z.object({
  enabled: z.boolean(),
  rules: z.array(RoutingRule).max(50).default([]),
  /** Where a lead no rule takes goes; null leaves it unowned. */
  fallback: RoutingAssign.nullable().default(null),
});
export type LeadRoutingT = z.infer<typeof LeadRoutingInput>;

export const DEFAULT_LEAD_ROUTING: LeadRoutingT = { enabled: false, rules: [], fallback: null };

/** What routing knows about a contact. */
export type RoutingFacts = { leadSource: string; lists: string[]; tags: string[]; country: string };

const norm = (s: string) => s.trim().toLowerCase();

export function ruleMatches(when: RoutingWhenT, f: RoutingFacts): boolean {
  if (when.leadSources.length && !when.leadSources.some((s) => s && norm(f.leadSource).includes(norm(s)))) return false;
  if (when.lists.length && !when.lists.some((l) => f.lists.some((x) => norm(x) === norm(l)))) return false;
  if (when.tags.length && !when.tags.some((t) => f.tags.some((x) => norm(x) === norm(t)))) return false;
  if (when.countries.length && !when.countries.some((c) => norm(c) === norm(f.country))) return false;
  return true;
}

/** The first enabled rule that matches, else the fallback (rule null), else nothing. */
export function routeFor(cfg: LeadRoutingT, f: RoutingFacts): { rule: RoutingRuleT | null; assign: RoutingAssignT } | null {
  for (const rule of cfg.rules) if (rule.enabled && ruleMatches(rule.when, f)) return { rule, assign: rule.assign };
  return cfg.fallback ? { rule: null, assign: cfg.fallback } : null;
}

/** Round robin: the person after `last` in the pool's order (the first when `last` is unknown). */
export function nextInTurn(pool: string[], last: string | null): string | null {
  if (!pool.length) return null;
  const at = last ? pool.indexOf(last) : -1;
  return pool[(at + 1) % pool.length]!;
}

/** Balanced: whoever holds the fewest open leads; ties go to the earlier in the pool. */
export function leastLoaded(pool: string[], load: Map<string, number>): string | null {
  let best: string | null = null;
  for (const u of pool) if (best === null || (load.get(u) ?? 0) < (load.get(best) ?? 0)) best = u;
  return best;
}
