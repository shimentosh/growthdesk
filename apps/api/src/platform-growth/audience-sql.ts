import type { PlatformAudienceFilter } from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";

/*
 * The ONE place that decides who platform marketing may reach. Used for the
 * audience preview (count + samples), the broadcast recipient snapshot, the
 * send-time re-check of a batch, and drip enrollment / step eligibility.
 *
 * Every query is the marketing rule AND the audience filter. The rule cannot
 * be switched off by a filter:
 *   - PlatformUserProfile.marketingConsent is true (no profile = never asked = no)
 *   - not unsubscribed, not suppressed (hard bounce, complaint, admin), not anonymised
 *   - the account is not suspended and its email address is verified
 *
 * Timestamps are stored as UTC without a zone (Prisma's default), so instants
 * are converted the same way before comparing (as in admin/user-profile.ts).
 */

export const utc = (d: Date | string) => Prisma.sql`(${new Date(d).toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** The marketing rule over `"User" u` JOIN `"PlatformUserProfile" p`. */
export function marketingRule(): Prisma.Sql {
  return Prisma.sql`p."marketingConsent" IS TRUE AND p."unsubscribedAt" IS NULL AND p."suppressedAt" IS NULL AND p."anonymisedAt" IS NULL AND u."suspendedAt" IS NULL AND u."emailVerifiedAt" IS NOT NULL`;
}

/** The audience filter's own conditions (without the rule); empty when the filter is empty. */
export function filterConditions(f: Partial<PlatformAudienceFilter>): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  const plans = f.plans ?? [];
  const statuses = f.subscriptionStatuses ?? [];
  if (plans.length || statuses.length) {
    // One subscription must satisfy both lists: "on Pro AND trialing" means the same account.
    const conds: Prisma.Sql[] = [];
    if (plans.length) conds.push(Prisma.sql`pl.key IN (${Prisma.join(plans)})`);
    if (statuses.length) conds.push(Prisma.sql`s.status::text IN (${Prisma.join(statuses)})`);
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Membership" m
      JOIN "Workspace" w ON w.id = m."workspaceId"
      JOIN "Subscription" s ON s."billingAccountId" = w."billingAccountId"
      JOIN "Plan" pl ON pl.id = s."planId"
      WHERE m."userId" = u.id AND ${Prisma.join(conds, " AND ")})`);
  }
  if (f.signedUpAfter) parts.push(Prisma.sql`u."createdAt" >= ${utc(f.signedUpAfter)}`);
  if (f.signedUpBefore) parts.push(Prisma.sql`u."createdAt" <= ${utc(f.signedUpBefore)}`);
  if (f.lastLoginAfter) parts.push(Prisma.sql`u."lastLoginAt" >= ${utc(f.lastLoginAfter)}`);
  if (f.lastLoginBefore) parts.push(Prisma.sql`u."lastLoginAt" <= ${utc(f.lastLoginBefore)}`);
  const workspaces = Prisma.sql`(SELECT count(*) FROM "Membership" mc WHERE mc."userId" = u.id)`;
  if (f.workspacesMin !== undefined && f.workspacesMin !== null) parts.push(Prisma.sql`${workspaces} >= ${f.workspacesMin}`);
  if (f.workspacesMax !== undefined && f.workspacesMax !== null) parts.push(Prisma.sql`${workspaces} <= ${f.workspacesMax}`);
  if (f.tagsAny?.length) parts.push(Prisma.sql`p.tags && ARRAY[${Prisma.join(f.tagsAny)}]::text[]`);
  if (f.signupSources?.length) parts.push(Prisma.sql`p."signupSource" IN (${Prisma.join(f.signupSources)})`);
  return parts;
}

/** FROM … WHERE … for an audience: the rule, the filter, and optional extra conditions (an id list, a search). */
export function audienceFromWhere(f: Partial<PlatformAudienceFilter> | null, extra: Prisma.Sql[] = []): Prisma.Sql {
  const parts = [marketingRule(), ...filterConditions(f ?? {}), ...extra];
  return Prisma.sql`FROM "User" u JOIN "PlatformUserProfile" p ON p."userId" = u.id WHERE ${Prisma.join(parts, " AND ")}`;
}

/** Restricts to these user ids. */
export const userIdIn = (ids: string[]) => Prisma.sql`u.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`;

/** A stored filter (Json) back into the shape the builder reads; anything malformed is dropped, never widened into "everyone". */
export function storedFilter(raw: unknown): Partial<PlatformAudienceFilter> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Partial<PlatformAudienceFilter>;
}
