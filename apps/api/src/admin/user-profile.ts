import type { PlatformRole, SignupSource } from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma/prisma.service.js";

/*
 * Platform user filters and profile fields, shared by the user list
 * (AdminService.listUsers) and the CSV export (AdminUsersService). Profile
 * facts live in PlatformUserProfile, which has no relation to User, so the
 * filters are one SQL statement with a LEFT JOIN rather than an id list.
 */

export type UserFilter = {
  q?: string;
  role?: PlatformRole;
  scope?: "all" | "staff" | "disabled";
  verified?: boolean;
  lastLoginFrom?: Date;
  lastLoginTo?: Date;
  plan?: string;
  signupSource?: SignupSource;
  tag?: string;
  consent?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Timestamps are stored as UTC without a zone (Prisma's default), so parameters are converted the same way. */
const utc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** FROM … WHERE … over `"User" u` LEFT JOIN `"PlatformUserProfile" p`; `extra` is one more condition (the export's cursor). */
export function userFromWhere(f: UserFilter, extra?: Prisma.Sql): Prisma.Sql {
  const parts: Prisma.Sql[] = extra ? [extra] : [];
  if (f.q) {
    const like = `%${likeEscape(f.q)}%`;
    parts.push(Prisma.sql`(u.email ILIKE ${like} OR u.name ILIKE ${like}${UUID.test(f.q) ? Prisma.sql` OR u.id = ${f.q}::uuid` : Prisma.empty})`);
  }
  if (f.scope === "staff") parts.push(Prisma.sql`u."platformRole" <> 'none'`);
  if (f.scope === "disabled") parts.push(Prisma.sql`u."suspendedAt" IS NOT NULL`);
  if (f.role) parts.push(Prisma.sql`u."platformRole" = ${f.role}::"PlatformRole"`);
  if (f.verified !== undefined) parts.push(f.verified ? Prisma.sql`u."emailVerifiedAt" IS NOT NULL` : Prisma.sql`u."emailVerifiedAt" IS NULL`);
  if (f.lastLoginFrom) parts.push(Prisma.sql`u."lastLoginAt" >= ${utc(f.lastLoginFrom)}`);
  if (f.lastLoginTo) parts.push(Prisma.sql`u."lastLoginAt" <= ${utc(f.lastLoginTo)}`);
  if (f.plan) {
    // Anyone in a workspace whose billing account is on this plan.
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Membership" m
      JOIN "Workspace" w ON w.id = m."workspaceId"
      JOIN "Subscription" s ON s."billingAccountId" = w."billingAccountId"
      JOIN "Plan" pl ON pl.id = s."planId"
      WHERE m."userId" = u.id AND pl.key = ${f.plan})`);
  }
  if (f.signupSource) parts.push(Prisma.sql`p."signupSource" = ${f.signupSource}`);
  if (f.tag) parts.push(Prisma.sql`${f.tag} = ANY(p.tags)`);
  if (f.consent !== undefined) parts.push(f.consent ? Prisma.sql`p."marketingConsent" IS TRUE` : Prisma.sql`p."marketingConsent" IS NOT TRUE`);
  const from = Prisma.sql`FROM "User" u LEFT JOIN "PlatformUserProfile" p ON p."userId" = u.id`;
  return parts.length ? Prisma.sql`${from} WHERE ${Prisma.join(parts, " AND ")}` : from;
}

/** One page of matching user ids (newest first) and the total. */
export async function filteredUserIds(prisma: PrismaService, f: UserFilter, page: number, pageSize: number) {
  const fromWhere = userFromWhere(f);
  const [rows, count] = await Promise.all([
    prisma.db.$queryRaw<{ id: string }[]>`SELECT u.id ${fromWhere} ORDER BY u."createdAt" DESC, u.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n ${fromWhere}`,
  ]);
  return { ids: rows.map((r) => r.id), total: count[0]?.n ?? 0 };
}

export type ProfileRow = Prisma.PlatformUserProfileGetPayload<object>;

export async function profilesFor(prisma: PrismaService, userIds: string[]) {
  if (!userIds.length) return new Map<string, ProfileRow>();
  const rows = await prisma.db.platformUserProfile.findMany({ where: { userId: { in: userIds } } });
  return new Map(rows.map((r) => [r.userId, r]));
}

const utmOf = (p: ProfileRow | null | undefined) => (p?.utm && typeof p.utm === "object" && !Array.isArray(p.utm) ? (p.utm as Record<string, string>) : {});

/** The profile facts every user row carries (list and detail). No profile = an account from before Phase 3. */
export function profileSummary(p: ProfileRow | null | undefined) {
  return {
    signupSource: p?.signupSource || null,
    utmSource: utmOf(p).utm_source ?? null,
    tags: p?.tags ?? [],
    marketingConsent: p?.marketingConsent ?? false,
    anonymisedAt: p?.anonymisedAt ?? null,
  };
}

/** The full profile for the user detail page. */
export function profileDetail(p: ProfileRow | null | undefined) {
  if (!p) return null;
  return {
    signupSource: p.signupSource || null,
    utm: utmOf(p),
    referrer: p.referrer,
    landingPath: p.landingPath,
    marketingConsent: p.marketingConsent,
    consentAt: p.consentAt,
    consentSource: p.consentSource,
    unsubscribedAt: p.unsubscribedAt,
    suppressedAt: p.suppressedAt,
    suppressionReason: p.suppressionReason,
    tags: p.tags,
    anonymisedAt: p.anonymisedAt,
  };
}
