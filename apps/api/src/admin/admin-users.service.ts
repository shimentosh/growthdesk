import { Inject, Injectable } from "@nestjs/common";
import type { Response } from "express";
import type { WaitlistStatus } from "@growthdesk/shared";
import { Prisma } from "../generated/prisma/client.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService, type AuditInput } from "../core/audit.service.js";
import { MailService } from "../core/mail.service.js";
import { SessionService } from "../auth/session.service.js";
import { AuthService } from "../auth/auth.service.js";
import { hashToken, newToken } from "../common/crypto.js";
import { PLATFORM_RANK, me, type RequestContext } from "../common/context.js";
import { badRequest, conflict, forbidden, notFound, tooMany } from "../common/errors.js";
import { AdminService } from "./admin.service.js";
import { userFromWhere, type UserFilter } from "./user-profile.js";

/*
 * Platform user management beyond the basics in AdminService (super-admin
 * Phase 3): notes and tags (support), verification, password reset, change
 * email, CSV export, the waitlist and sign-up invitations (admin), and
 * deletion by anonymisation (owner).
 *
 * The per-target rank rules are AdminService.assertMayManage: nobody acts on
 * their own account here, and only a platform owner acts on staff at or above
 * their own rank. Every change is audited as a platform_admin action.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const insensitive = (q: string) => ({ contains: q, mode: "insensitive" as const });
const DAY = 86_400_000;
const EXPORT_BATCH = 500;

type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };
const paged = <T>(items: T[], total: number, page: number, pageSize: number): Paged<T> => ({ items, total, page, pageSize });

/** A spreadsheet must never run a cell as a formula: = + - @ (and tab/CR) at the start are neutralised with a quote. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(" ") : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const csvRow = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;

const EXPORT_COLUMNS = [
  "id",
  "email",
  "name",
  "platform_role",
  "email_verified",
  "disabled",
  "last_login_at",
  "created_at",
  "workspaces",
  "signup_source",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "referrer",
  "marketing_consent",
  "consent_at",
  "tags",
  "anonymised_at",
];

type ExportRow = {
  id: string;
  email: string;
  name: string;
  platformRole: string;
  emailVerifiedAt: Date | null;
  suspendedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  workspaces: number;
  signupSource: string | null;
  utm: Record<string, string> | null;
  referrer: string | null;
  marketingConsent: boolean | null;
  consentAt: Date | null;
  tags: string[] | null;
  anonymisedAt: Date | null;
};

type InviteRow = Prisma.PlatformSignupInviteGetPayload<object>;
type WaitlistRow = Prisma.PlatformWaitlistEntryGetPayload<object>;

function inviteStatus(i: InviteRow): "pending" | "used" | "expired" {
  if (i.usedAt) return "used";
  return i.expiresAt.getTime() <= Date.now() ? "expired" : "pending";
}

function waitlistDto(e: WaitlistRow) {
  return { id: e.id, email: e.email, name: e.name, utm: e.utm, status: e.status as WaitlistStatus, invitedAt: e.invitedAt, createdAt: e.createdAt };
}

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly admin: AdminService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private record(ctx: RequestContext, input: AuditInput) {
    return this.audit.record(ctx, { workspaceId: null, ...input }, "platform_admin");
  }

  private async findUser(id: string) {
    if (!UUID.test(id)) throw notFound("That user");
    const [user, profile] = await Promise.all([
      this.prisma.db.user.findUnique({ where: { id } }),
      this.prisma.db.platformUserProfile.findUnique({ where: { userId: id } }),
    ]);
    if (!user) throw notFound("That user");
    return { user, profile };
  }

  /** The account a staff member acts on: exists, is within their rank, and has not been deleted. */
  private async manageable(ctx: RequestContext, id: string, verb: string) {
    const found = await this.findUser(id);
    this.admin.assertMayManage(me(ctx), found.user, verb);
    if (found.profile?.anonymisedAt) throw conflict("This account was deleted.");
    return found;
  }

  // ─── Support: verification resend, notes, tags ─────────────────────────────

  async resendVerification(ctx: RequestContext, id: string) {
    const { user } = await this.manageable(ctx, id, "send a verification email to");
    if (user.emailVerifiedAt) throw conflict("This email address is already confirmed.");
    await this.auth.resendVerification(id);
    await this.record(ctx, { action: "platform.user_verification_resent", targetType: "user", targetId: id, metadata: { email: user.email } });
    return { sent: true };
  }

  async listNotes(id: string) {
    await this.findUser(id);
    const notes = await this.prisma.db.platformUserNote.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 200 });
    const authorIds = [...new Set(notes.map((n) => n.authorId).filter((v): v is string => Boolean(v)))];
    const authors = await this.prisma.db.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, email: true } });
    const byId = new Map(authors.map((a) => [a.id, a]));
    return notes.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt, author: n.authorId ? (byId.get(n.authorId) ?? null) : null }));
  }

  async addNote(ctx: RequestContext, id: string, body: string) {
    const { profile } = await this.findUser(id);
    if (profile?.anonymisedAt) throw conflict("This account was deleted.");
    const actor = me(ctx);
    const note = await this.prisma.db.platformUserNote.create({ data: { userId: id, authorId: actor.userId, body } });
    await this.record(ctx, { action: "platform.user_note_added", targetType: "user", targetId: id, metadata: { noteId: note.id } });
    return { id: note.id, body: note.body, createdAt: note.createdAt, author: { id: actor.userId, name: actor.name, email: actor.email } };
  }

  async setTags(ctx: RequestContext, id: string, tags: string[]) {
    const { profile } = await this.findUser(id);
    if (profile?.anonymisedAt) throw conflict("This account was deleted.");
    const next = [...new Set(tags)].sort();
    const before = profile?.tags ?? [];
    await this.prisma.db.platformUserProfile.upsert({ where: { userId: id }, create: { userId: id, tags: next }, update: { tags: next } });
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      await this.record(ctx, { action: "platform.user_tags_updated", targetType: "user", targetId: id, metadata: { from: before, to: next } });
    }
    return { tags: next };
  }

  // ─── Admin: verify, password reset, change email ───────────────────────────

  async verifyEmail(ctx: RequestContext, id: string) {
    const { user } = await this.manageable(ctx, id, "confirm the email of");
    if (!user.emailVerifiedAt) {
      await this.prisma.db.$transaction([
        this.prisma.db.user.update({ where: { id }, data: { emailVerifiedAt: new Date() } }),
        this.prisma.db.authToken.updateMany({ where: { userId: id, kind: "verify_email", usedAt: null }, data: { usedAt: new Date() } }),
      ]);
      await this.record(ctx, { action: "platform.user_email_verified", targetType: "user", targetId: id, metadata: { email: user.email } });
    }
    return this.admin.userDetail(id);
  }

  async sendPasswordReset(ctx: RequestContext, id: string) {
    const { user } = await this.manageable(ctx, id, "reset the password of");
    if (user.suspendedAt) throw conflict("This account is disabled. Enable it before sending a password reset.");
    const sent = await this.auth.issuePasswordReset(id, user.email);
    if (!sent) throw tooMany("Three reset links went out in the last 10 minutes. Wait a few minutes before sending another.");
    await this.record(ctx, { action: "platform.user_password_reset_sent", targetType: "user", targetId: id, metadata: { email: user.email } });
    return { sent: true };
  }

  /**
   * Moves the account to a new address: the old address is told, the new one
   * must be confirmed again, open links (verify/reset) stop working and every
   * session ends. A linked Google account stays linked (it is matched by its
   * Google id, not the address).
   */
  async changeEmail(ctx: RequestContext, id: string, email: string) {
    const { user } = await this.manageable(ctx, id, "change the email of");
    if (email === user.email) throw badRequest("That is already this account's email address.", { email: "Unchanged" });
    if (await this.prisma.db.user.findUnique({ where: { email }, select: { id: true } })) {
      throw conflict("Another account already uses that email address.", { email: "Already registered" });
    }
    try {
      await this.prisma.db.$transaction([
        this.prisma.db.user.update({ where: { id }, data: { email, emailVerifiedAt: null } }),
        this.prisma.db.authToken.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: new Date() } }),
        this.prisma.db.signInFailure.deleteMany({ where: { userId: id } }),
      ]);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw conflict("Another account already uses that email address.", { email: "Already registered" });
      }
      throw e;
    }
    await this.sessions.revokeAllFor(id);
    await this.mail.sendTemplate("email_changed", user.email, { name: user.name, old_email: user.email, new_email: email }, { userId: id });
    await this.auth.sendVerification(id, email, user.name);
    await this.record(ctx, { action: "platform.user_email_changed", targetType: "user", targetId: id, metadata: { from: user.email, to: email } });
    return this.admin.userDetail(id);
  }

  // ─── Admin: CSV export ─────────────────────────────────────────────────────

  /** Streams every matching user (newest first) in batches, so a large install never builds the file in memory. */
  async exportCsv(ctx: RequestContext, filter: UserFilter, res: Response) {
    res.status(200);
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader("cache-control", "no-store");
    const write = (chunk: string) => (res.write(chunk) ? Promise.resolve() : new Promise<void>((r) => res.once("drain", () => r())));
    await write(`﻿${csvRow(EXPORT_COLUMNS)}`);
    let cursor: { createdAt: Date; id: string } | null = null;
    let count = 0;
    for (;;) {
      const after: Prisma.Sql = cursor
        ? Prisma.sql`(u."createdAt", u.id) < (${cursor.createdAt.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${cursor.id}::uuid)`
        : Prisma.sql`TRUE`;
      const rows: ExportRow[] = await this.prisma.db.$queryRaw<ExportRow[]>`
        SELECT u.id, u.email, u.name, u."platformRole"::text AS "platformRole", u."emailVerifiedAt", u."suspendedAt", u."lastLoginAt", u."createdAt",
               (SELECT count(*)::int FROM "Membership" m WHERE m."userId" = u.id) AS workspaces,
               p."signupSource", p.utm, p.referrer, p."marketingConsent", p."consentAt", p.tags, p."anonymisedAt"
        ${userFromWhere(filter, after)}
        ORDER BY u."createdAt" DESC, u.id DESC
        LIMIT ${EXPORT_BATCH}`;
      for (const r of rows) {
        const utm = r.utm ?? {};
        await write(
          csvRow([
            r.id,
            r.email,
            r.name,
            r.platformRole,
            r.emailVerifiedAt ? "yes" : "no",
            r.suspendedAt ? "yes" : "no",
            r.lastLoginAt,
            r.createdAt,
            r.workspaces,
            r.signupSource ?? "",
            utm.utm_source ?? "",
            utm.utm_medium ?? "",
            utm.utm_campaign ?? "",
            r.referrer ?? "",
            r.marketingConsent ? "yes" : "no",
            r.consentAt,
            r.tags ?? [],
            r.anonymisedAt,
          ]),
        );
      }
      count += rows.length;
      if (rows.length < EXPORT_BATCH) break;
      const last = rows[rows.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    // Recorded before the response ends, so the audit row exists by the time the download completes.
    const filters = Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined));
    await this.record(ctx, { action: "platform.users_exported", targetType: "user", metadata: { rows: count, filters } });
    res.end();
  }

  // ─── Admin: waitlist and sign-up invitations ───────────────────────────────

  async listWaitlist(q: { page: number; pageSize: number; q?: string; status?: WaitlistStatus }) {
    const where: Prisma.PlatformWaitlistEntryWhereInput = {};
    if (q.q) where.OR = [{ email: insensitive(q.q) }, { name: insensitive(q.q) }];
    if (q.status) where.status = q.status;
    const [rows, total, counts] = await Promise.all([
      this.prisma.db.platformWaitlistEntry.findMany({ where, orderBy: { createdAt: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.db.platformWaitlistEntry.count({ where }),
      this.prisma.db.platformWaitlistEntry.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Record<string, number>;
    return {
      ...paged(rows.map(waitlistDto), total, q.page, q.pageSize),
      counts: { pending: byStatus.pending ?? 0, invited: byStatus.invited ?? 0, rejected: byStatus.rejected ?? 0 },
    };
  }

  private async findWaitlistEntry(id: string) {
    if (!UUID.test(id)) throw notFound("That waitlist entry");
    const row = await this.prisma.db.platformWaitlistEntry.findUnique({ where: { id } });
    if (!row) throw notFound("That waitlist entry");
    return row;
  }

  async inviteFromWaitlist(ctx: RequestContext, id: string, expiresDays: number) {
    const entry = await this.findWaitlistEntry(id);
    const created = await this.createInvite(ctx, entry.email, expiresDays, entry.name, entry.id);
    const updated = await this.prisma.db.platformWaitlistEntry.update({ where: { id }, data: { status: "invited", invitedAt: new Date() } });
    return { entry: waitlistDto(updated), ...created };
  }

  async rejectWaitlist(ctx: RequestContext, id: string) {
    const entry = await this.findWaitlistEntry(id);
    if (entry.status === "rejected") return waitlistDto(entry);
    const updated = await this.prisma.db.platformWaitlistEntry.update({ where: { id }, data: { status: "rejected" } });
    await this.record(ctx, { action: "platform.waitlist_rejected", targetType: "waitlist_entry", targetId: id, metadata: { email: entry.email } });
    return waitlistDto(updated);
  }

  private async inviteDto(rows: InviteRow[]) {
    const ids = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => Boolean(v)))];
    const people = await this.prisma.db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
    const byId = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      status: inviteStatus(r),
      expiresAt: r.expiresAt,
      usedAt: r.usedAt,
      createdAt: r.createdAt,
      createdBy: r.createdById ? (byId.get(r.createdById) ?? null) : null,
    }));
  }

  /**
   * A one-time sign-up link for one address, emailed to it. The link is also
   * returned once, so staff can pass it on if the email does not arrive.
   */
  async createInvite(ctx: RequestContext, email: string, expiresDays: number, name = "", waitlistEntryId?: string) {
    if (await this.prisma.db.user.findUnique({ where: { email }, select: { id: true } })) {
      throw conflict("An account with this email address already exists.", { email: "Already registered" });
    }
    const token = newToken();
    const row = await this.prisma.db.platformSignupInvite.create({
      data: { email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + expiresDays * DAY), createdById: me(ctx).userId },
    });
    const url = `${this.config.PUBLIC_APP_URL.replace(/\/$/, "")}/register?invite=${encodeURIComponent(token)}`;
    const emailed = await this.mail.sendTemplate("signup_invite", email, { name, action_url: url, expires_days: String(expiresDays) });
    await this.record(ctx, {
      action: "platform.signup_invite_created",
      targetType: "signup_invite",
      targetId: row.id,
      metadata: { email, expiresDays, ...(waitlistEntryId ? { waitlistEntryId } : {}) },
    });
    const [invite] = await this.inviteDto([row]);
    return { invite: invite!, url, emailed: emailed !== false };
  }

  async listInvites(q: { page: number; pageSize: number; q?: string; status?: "pending" | "used" | "expired" }) {
    const now = new Date();
    const where: Prisma.PlatformSignupInviteWhereInput = {};
    if (q.q) where.email = insensitive(q.q);
    if (q.status === "used") where.usedAt = { not: null };
    if (q.status === "pending") Object.assign(where, { usedAt: null, expiresAt: { gt: now } });
    if (q.status === "expired") Object.assign(where, { usedAt: null, expiresAt: { lte: now } });
    const [rows, total] = await Promise.all([
      this.prisma.db.platformSignupInvite.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.db.platformSignupInvite.count({ where }),
    ]);
    return paged(await this.inviteDto(rows), total, q.page, q.pageSize);
  }

  async revokeInvite(ctx: RequestContext, id: string) {
    if (!UUID.test(id)) throw notFound("That invitation");
    const row = await this.prisma.db.platformSignupInvite.findUnique({ where: { id } });
    if (!row) throw notFound("That invitation");
    if (row.usedAt) throw conflict("This invitation was already used to create an account.");
    await this.prisma.db.platformSignupInvite.delete({ where: { id } });
    await this.record(ctx, { action: "platform.signup_invite_revoked", targetType: "signup_invite", targetId: id, metadata: { email: row.email } });
    return { revoked: true };
  }

  // ─── Owner: delete (anonymise) ─────────────────────────────────────────────

  /**
   * GDPR erasure that keeps the row (billing accounts and records still point
   * at it): the address, name and credentials are wiped, sessions, links and
   * the API keys they created stop working, the platform email log forgets the
   * address, and the profile is marked anonymised. The person is told at their
   * original address first. Their own single-person workspaces are suspended
   * so nothing keeps sending in the name of a deleted account.
   *
   * Refused while they own a live paid subscription or a workspace other
   * people use — those need a cancellation or an ownership decision first.
   */
  async anonymise(ctx: RequestContext, id: string) {
    const actor = me(ctx);
    const { user, profile } = await this.findUser(id);
    this.admin.assertMayManage(actor, user, "delete");
    if (user.platformRole !== "none" && PLATFORM_RANK[user.platformRole] >= PLATFORM_RANK[actor.platformRole]) {
      throw forbidden(`A platform ${user.platformRole} can't be deleted. Change their platform role first.`);
    }
    if (profile?.anonymisedAt) throw conflict("This account was already deleted.");

    const live = await this.prisma.db.subscription.findFirst({
      where: { billingAccount: { ownerId: id }, provider: { not: "none" }, status: { in: ["trialing", "active", "past_due", "incomplete"] } },
      select: { billingAccountId: true, provider: true, status: true },
    });
    if (live) {
      throw conflict(
        `This person owns a billing account with a live ${live.provider} subscription (${live.status}). Cancel it first, then delete the account.`,
        undefined,
        { billingAccountId: live.billingAccountId },
      );
    }
    const shared = await this.prisma.db.workspace.findFirst({
      where: {
        OR: [{ billingAccount: { ownerId: id } }, { memberships: { some: { userId: id, role: "owner" } } }],
        memberships: { some: { userId: { not: id } } },
      },
      select: { id: true, name: true },
    });
    if (shared) {
      throw conflict(
        `This person owns the workspace "${shared.name}", which other people use. Transfer it or remove its other members first.`,
        undefined,
        { workspaceId: shared.id },
      );
    }

    const original = user.email;
    // Told before the address is erased; a failed send never blocks the erasure (sendTemplate does not throw).
    await this.mail.sendTemplate("account_deleted", original, { name: user.name }, { userId: id });

    const anon = `deleted+${id}@invalid`;
    const now = new Date();
    const { suspended } = await this.prisma.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { email: anon, name: "", passwordHash: null, googleSub: null, avatarUrl: "", emailVerifiedAt: null, suspendedAt: user.suspendedAt ?? now, suspendedReason: "Account deleted" },
      });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
      await tx.authToken.deleteMany({ where: { userId: id } });
      await tx.signInFailure.deleteMany({ where: { OR: [{ userId: id }, { email: original }] } });
      await tx.emailLog.updateMany({ where: { OR: [{ userId: id }, { to: original }] }, data: { to: anon } });
      await tx.billingAccount.updateMany({ where: { ownerId: id, billingEmail: original }, data: { billingEmail: "" } });
      await tx.platformUserNote.deleteMany({ where: { userId: id } });
      await tx.platformWaitlistEntry.deleteMany({ where: { email: original } });
      await tx.platformSignupInvite.deleteMany({ where: { email: original } });
      const erased = { utm: {}, referrer: "", landingPath: "", marketingConsent: false, consentAt: null, consentSource: "", tags: [], anonymisedAt: now };
      await tx.platformUserProfile.upsert({ where: { userId: id }, create: { userId: id, ...erased }, update: erased });
      const ws = await tx.workspace.updateMany({
        where: { billingAccount: { ownerId: id }, status: "active" },
        data: { status: "suspended", suspendedAt: now, suspendedReason: "The owner's account was deleted." },
      });
      return { suspended: ws.count };
    });
    // GAP 2.2: keys outlive their creator otherwise. ApiKey is not a guarded tenant model, so the cross-workspace update is allowed.
    const keys = await this.prisma.db.apiKey.updateMany({ where: { createdById: id, revokedAt: null }, data: { revokedAt: now } });
    await this.record(ctx, {
      action: "platform.user_anonymised",
      targetType: "user",
      targetId: id,
      metadata: { apiKeysRevoked: keys.count, workspacesSuspended: suspended },
    });
    return { anonymised: true, apiKeysRevoked: keys.count, workspacesSuspended: suspended };
  }
}
