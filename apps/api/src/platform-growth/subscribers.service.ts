import { Injectable } from "@nestjs/common";
import type { PlatformEmailPreferencesDetails, PlatformSubscriberTab } from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { Tx } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { BrandingService } from "../core/branding.service.js";
import { me, type RequestContext } from "../common/context.js";
import { ApiError, notFound } from "../common/errors.js";
import { readMarketingToken } from "./unsubscribe-token.js";

/*
 * Who receives product emails, and the ways that changes:
 *
 *   - the preferences page / RFC 8058 one-click (signed token, no session):
 *     unsubscribe → unsubscribedAt, marketingConsent=false, consentSource
 *     "preference_page"; resubscribe → consent back on, same source.
 *     GET only describes, it never changes anything (link scanners fetch it).
 *   - the account page toggle (session): consentSource "account_settings".
 *   - admin suppress / unsuppress (suppressedAt, reason "admin").
 *
 * Every opt-out also stops the person's active drip enrollments at once.
 * None of this affects transactional (system) mail.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const linkGone = () => new ApiError(404, "not_found", "This link is incomplete or no longer valid.");

const stopDrips = (tx: Pick<Tx, "platformDripEnrollment">, userId: string) =>
  tx.platformDripEnrollment.updateMany({ where: { userId, status: "active" }, data: { status: "stopped", nextRunAt: null } });

@Injectable()
export class SubscribersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly branding: BrandingService,
  ) {}

  // ─── Admin ─────────────────────────────────────────────────────────────────

  private tabWhere(tab: PlatformSubscriberTab): Prisma.Sql {
    switch (tab) {
      case "consented":
        return Prisma.sql`p."marketingConsent" IS TRUE AND p."unsubscribedAt" IS NULL AND p."suppressedAt" IS NULL AND p."anonymisedAt" IS NULL`;
      case "unsubscribed":
        return Prisma.sql`p."unsubscribedAt" IS NOT NULL AND p."anonymisedAt" IS NULL`;
      case "suppressed":
        return Prisma.sql`p."suppressedAt" IS NOT NULL AND p."anonymisedAt" IS NULL`;
    }
  }

  async list(q: { tab: PlatformSubscriberTab; q?: string; page: number; pageSize: number }) {
    const from = Prisma.sql`FROM "User" u JOIN "PlatformUserProfile" p ON p."userId" = u.id`;
    const conds = [this.tabWhere(q.tab)];
    if (q.q) {
      const like = `%${likeEscape(q.q)}%`;
      conds.push(Prisma.sql`(u.email ILIKE ${like} OR u.name ILIKE ${like}${UUID.test(q.q) ? Prisma.sql` OR u.id = ${q.q}::uuid` : Prisma.empty})`);
    }
    const where = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;
    const order = q.tab === "consented" ? Prisma.sql`p."consentAt" DESC NULLS LAST` : q.tab === "unsubscribed" ? Prisma.sql`p."unsubscribedAt" DESC` : Prisma.sql`p."suppressedAt" DESC`;
    const [items, total, counts] = await Promise.all([
      this.prisma.db.$queryRaw<
        {
          userId: string;
          email: string;
          name: string;
          emailVerified: boolean;
          suspended: boolean;
          marketingConsent: boolean;
          consentAt: Date | null;
          consentSource: string;
          unsubscribedAt: Date | null;
          suppressedAt: Date | null;
          suppressionReason: string;
        }[]
      >`SELECT u.id AS "userId", u.email, u.name, (u."emailVerifiedAt" IS NOT NULL) AS "emailVerified", (u."suspendedAt" IS NOT NULL) AS suspended,
          p."marketingConsent", p."consentAt", p."consentSource", p."unsubscribedAt", p."suppressedAt", p."suppressionReason"
        ${from} ${where} ORDER BY ${order}, u.id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      this.prisma.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n ${from} ${where}`,
      this.prisma.db.$queryRaw<{ consented: number; unsubscribed: number; suppressed: number }[]>`
        SELECT count(*) FILTER (WHERE ${this.tabWhere("consented")})::int AS consented,
               count(*) FILTER (WHERE ${this.tabWhere("unsubscribed")})::int AS unsubscribed,
               count(*) FILTER (WHERE ${this.tabWhere("suppressed")})::int AS suppressed
        ${from}`,
    ]);
    return { items, total: total[0]?.n ?? 0, page: q.page, pageSize: q.pageSize, counts: counts[0] ?? { consented: 0, unsubscribed: 0, suppressed: 0 } };
  }

  private async user(userId: string) {
    if (!UUID.test(userId)) throw notFound("That user");
    const user = await this.prisma.db.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) throw notFound("That user");
    return user;
  }

  async suppress(ctx: RequestContext, userId: string) {
    const user = await this.user(userId);
    const at = new Date();
    await this.prisma.db.$transaction(async (tx) => {
      const p = await tx.platformUserProfile.findUnique({ where: { userId }, select: { suppressedAt: true } });
      if (!p?.suppressedAt) {
        await tx.platformUserProfile.upsert({ where: { userId }, create: { userId, suppressedAt: at, suppressionReason: "admin" }, update: { suppressedAt: at, suppressionReason: "admin" } });
      }
      await stopDrips(tx, userId);
    });
    await this.audit.record(ctx, { workspaceId: null, action: "platform.growth_user_suppressed", targetType: "user", targetId: userId, metadata: { email: user.email } }, "platform_admin");
    return this.adminState(userId);
  }

  async unsuppress(ctx: RequestContext, userId: string) {
    const user = await this.user(userId);
    await this.prisma.db.platformUserProfile.updateMany({ where: { userId }, data: { suppressedAt: null, suppressionReason: "" } });
    await this.audit.record(ctx, { workspaceId: null, action: "platform.growth_user_unsuppressed", targetType: "user", targetId: userId, metadata: { email: user.email } }, "platform_admin");
    return this.adminState(userId);
  }

  private async adminState(userId: string) {
    const p = await this.prisma.db.platformUserProfile.findUnique({ where: { userId } });
    return {
      userId,
      marketingConsent: p?.marketingConsent ?? false,
      unsubscribedAt: p?.unsubscribedAt ?? null,
      suppressedAt: p?.suppressedAt ?? null,
      suppressionReason: p?.suppressionReason ?? "",
    };
  }

  // ─── Token (preferences page, one-click) ───────────────────────────────────

  private async fromToken(token: string) {
    const t = readMarketingToken(token);
    if (!t) throw linkGone();
    const user = await this.prisma.db.user.findUnique({ where: { id: t.userId }, select: { id: true, email: true } });
    const profile = user ? await this.prisma.db.platformUserProfile.findUnique({ where: { userId: user.id } }) : null;
    if (!user || profile?.anonymisedAt) throw linkGone();
    return { token: t, user, profile };
  }

  private async describe(user: { email: string }, p: { marketingConsent: boolean; unsubscribedAt: Date | null; suppressedAt: Date | null } | null): Promise<PlatformEmailPreferencesDetails> {
    return {
      email: user.email,
      productName: (await this.branding.get()).productName,
      subscribed: Boolean(p?.marketingConsent && !p.unsubscribedAt && !p.suppressedAt),
      suppressed: Boolean(p?.suppressedAt),
    };
  }

  /** What the page shows. Never changes anything. */
  async details(token: string) {
    const { user, profile } = await this.fromToken(token);
    return this.describe(user, profile);
  }

  /** Idempotent: a second call changes nothing and keeps the first unsubscribedAt. */
  async unsubscribe(token: string, via: "page" | "one_click") {
    const { token: t, user } = await this.fromToken(token);
    const at = new Date();
    const changed = await this.prisma.db.$transaction(async (tx) => {
      const p = await tx.platformUserProfile.findUnique({ where: { userId: user.id } });
      const already = Boolean(p?.unsubscribedAt) && !p?.marketingConsent;
      if (!already) {
        const data = { marketingConsent: false, unsubscribedAt: p?.unsubscribedAt ?? at, consentSource: "preference_page" };
        await tx.platformUserProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
      }
      await stopDrips(tx, user.id);
      return !already;
    });
    if (changed && t.emailLogId) {
      // Attribution for broadcast / drip stats. The unique providerEventId makes it once per email.
      await this.prisma.db.platformEmailEvent
        .create({ data: { providerEventId: `unsubscribe:${t.emailLogId}`, emailLogId: t.emailLogId, type: "unsubscribed", payload: { via } as never, occurredAt: at } })
        .catch((e: unknown) => {
          if ((e as { code?: string }).code !== "P2002" && (e as { code?: string }).code !== "P2003") throw e;
        });
    }
    const p = await this.prisma.db.platformUserProfile.findUnique({ where: { userId: user.id } });
    return { ...(await this.describe(user, p)), changed };
  }

  async resubscribe(token: string) {
    const { user, profile } = await this.fromToken(token);
    if (profile?.suppressedAt) return { ...(await this.describe(user, profile)), changed: false };
    const changed = !(profile?.marketingConsent && !profile.unsubscribedAt);
    if (changed) await this.setConsent(user.id, true, "preference_page");
    const p = await this.prisma.db.platformUserProfile.findUnique({ where: { userId: user.id } });
    return { ...(await this.describe(user, p)), changed };
  }

  // ─── The signed-in user's own preference ───────────────────────────────────

  private async setConsent(userId: string, consent: boolean, source: "account_settings" | "preference_page") {
    const now = new Date();
    await this.prisma.db.$transaction(async (tx) => {
      const data = consent
        ? { marketingConsent: true, consentAt: now, consentSource: source, unsubscribedAt: null }
        : { marketingConsent: false, consentSource: source, unsubscribedAt: now };
      await tx.platformUserProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
      if (!consent) await stopDrips(tx, userId);
    });
  }

  async myPreferences(ctx: RequestContext) {
    const userId = me(ctx).userId;
    const p = await this.prisma.db.platformUserProfile.findUnique({ where: { userId } });
    return {
      marketingConsent: Boolean(p?.marketingConsent && !p.unsubscribedAt),
      consentAt: p?.consentAt ?? null,
      unsubscribedAt: p?.unsubscribedAt ?? null,
      suppressed: Boolean(p?.suppressedAt),
      productName: (await this.branding.get()).productName,
    };
  }

  async setMyPreferences(ctx: RequestContext, marketingConsent: boolean) {
    const userId = me(ctx).userId;
    const p = await this.prisma.db.platformUserProfile.findUnique({ where: { userId } });
    const current = Boolean(p?.marketingConsent && !p.unsubscribedAt);
    if (current !== marketingConsent) {
      await this.setConsent(userId, marketingConsent, "account_settings");
      await this.audit.record(ctx, { workspaceId: null, action: marketingConsent ? "account.marketing_opt_in" : "account.marketing_opt_out", targetType: "user", targetId: userId }, "user");
    }
    return this.myPreferences(ctx);
  }
}
