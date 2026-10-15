import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { detectMailProvider, type SmtpMailboxInput, type TestSendInput, type UpdateMailboxInput } from "@growthdesk/shared";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { Mailbox, Prisma } from "../generated/prisma/client.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../core/audit.service.js";
import { BrandingService } from "../core/branding.service.js";
import { OutboundEmailService } from "../messaging/outbound-email.service.js";
import { MailboxAuthService } from "../messaging/mailbox-auth.service.js";
import { dropTransport, verifySmtp } from "../messaging/smtp.js";
import { Queues } from "../queues/queues.js";
import { seal } from "../common/crypto.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { badRequest, conflict, notFound, tooMany } from "../common/errors.js";
import { assertReachableTarget, isLocalHost, resolvePinnedTarget } from "./net-guard.js";
import { verifyImap } from "./imap.js";
import { domainAuth, domainOf, lookupMx, systemResolver, type DnsResolver } from "./domain-auth.js";

type SmtpMailboxInputT = z.infer<typeof SmtpMailboxInput>;
type UpdateMailboxInputT = z.infer<typeof UpdateMailboxInput>;
type TestSendInputT = z.infer<typeof TestSendInput>;

/** Test messages a mailbox may send per hour: proving a connection takes a handful; more is not a test. */
export const TEST_SENDS_PER_HOUR = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a client may see of a mailbox. Secrets (password, tokens) never leave the server. */
export function mailboxDto(b: Mailbox, sentToday = 0) {
  return {
    id: b.id,
    provider: b.provider,
    email: b.email,
    displayName: b.displayName,
    status: b.status,
    lastError: b.lastError,
    lastCheckedAt: b.lastCheckedAt,
    dailyLimit: b.dailyLimit,
    sentToday,
    minDelaySeconds: b.minDelaySeconds,
    signature: b.signature,
    smtpHost: b.smtpHost,
    smtpPort: b.smtpPort,
    smtpSecurity: b.smtpSecurity,
    smtpUser: b.smtpUser,
    imapEnabled: b.imapEnabled,
    imapHost: b.imapHost,
    imapPort: b.imapPort,
    imapSecurity: b.imapSecurity,
    imapUser: b.imapUser,
    lastSyncedAt: b.lastSyncedAt,
    syncError: b.syncError,
    createdAt: b.createdAt,
  };
}

/*
 * Connected sending mailboxes. Adapted from LinkDesk MailboxesService:
 * a password is proved against the real SMTP and IMAP servers BEFORE it is
 * stored ("connected" means connected, not "we wrote down what you typed"),
 * and every host is checked by the SSRF guard first.
 */
@Injectable()
export class MailboxesService {
  private readonly log = new Logger("mailboxes");
  /** DNS lookups for the domain report; replaceable so the report can be exercised without the network. */
  resolver: DnsResolver = systemResolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly outbound: OutboundEmailService,
    private readonly auth: MailboxAuthService,
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly branding: BrandingService,
  ) {}

  private get allowPrivate() {
    return this.config.ALLOW_PRIVATE_MAIL_HOSTS;
  }

  private selfSigned(host: string) {
    return isLocalHost(host) && this.allowPrivate;
  }

  async find(workspaceId: string, id: string): Promise<Mailbox> {
    if (!UUID.test(id)) throw notFound("That mailbox");
    const box = await this.prisma.db.mailbox.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!box) throw notFound("That mailbox");
    return box;
  }

  async list(ctx: RequestContext) {
    const w = ws(ctx);
    const boxes = await this.prisma.db.mailbox.findMany({ where: { workspaceId: w.id, deletedAt: null }, orderBy: { createdAt: "asc" } });
    const sent = boxes.length ? await this.outbound.sentToday(w.id, boxes.map((b) => b.id)) : new Map<string, number>();
    return boxes.map((b) => mailboxDto(b, sent.get(b.id) ?? 0));
  }

  async get(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const box = await this.find(w.id, id);
    const sent = await this.outbound.sentToday(w.id, [box.id]);
    return mailboxDto(box, sent.get(box.id) ?? 0);
  }

  /** Proves SMTP (and IMAP, when reply tracking is on) with these credentials; throws 400 with the server's answer. */
  private async proveCredentials(s: {
    smtpHost: string;
    smtpPort: number;
    smtpSecurity: string;
    smtpUser: string;
    imap: { host: string; port: number; security: string; user: string } | null;
    password: string;
  }) {
    // The SMTP probe connects to the address just vetted, so a rebinding answer cannot aim it elsewhere.
    const pinned = await resolvePinnedTarget(s.smtpHost, s.smtpPort, "SMTP", this.allowPrivate);
    if (s.imap) await assertReachableTarget(s.imap.host, s.imap.port, "IMAP", this.allowPrivate);
    const smtp = await verifySmtp({
      mailboxId: `probe-${randomUUID()}`,
      host: s.smtpHost,
      address: pinned.address,
      port: s.smtpPort,
      security: s.smtpSecurity,
      auth: { user: s.smtpUser, pass: s.password },
      allowSelfSigned: this.selfSigned(s.smtpHost),
    });
    if (!smtp.ok) throw badRequest(`The SMTP server did not accept the sign-in: ${smtp.error}`, { smtp: smtp.error.slice(0, 500) });
    if (s.imap) {
      const imap = await verifyImap({
        host: s.imap.host,
        port: s.imap.port,
        security: s.imap.security,
        auth: { user: s.imap.user, pass: s.password },
        allowSelfSigned: this.selfSigned(s.imap.host),
      });
      if (!imap.ok) throw badRequest(`The IMAP server did not accept the sign-in: ${imap.error}`, { imap: imap.error });
    }
  }

  async connectSmtp(ctx: RequestContext, input: SmtpMailboxInputT) {
    const w = ws(ctx);
    await this.entitlements.assertFullAccess(w.billingAccountId, "Connecting a mailbox");
    const email = input.email.trim().toLowerCase();
    // (workspaceId, email) is unique including soft-deleted rows: a removed mailbox is revived, not duplicated.
    const existing = await this.prisma.db.mailbox.findFirst({ where: { workspaceId: w.id, email } });
    if (existing && !existing.deletedAt) throw conflict(`${email} is already connected to this workspace.`, { email: "Already connected" });
    await this.entitlements.assertCapacity(w.billingAccountId, "mailboxes");

    const imap = input.imapEnabled
      ? { host: (input.imapHost ?? "").trim(), port: input.imapPort ?? 993, security: input.imapSecurity ?? "ssl", user: (input.imapUser ?? "").trim() || input.smtpUser }
      : null;
    if (imap && !imap.host) throw badRequest("Name the IMAP server, or turn reply tracking off", { imapHost: "Required" });

    await this.proveCredentials({ smtpHost: input.smtpHost, smtpPort: input.smtpPort, smtpSecurity: input.smtpSecurity, smtpUser: input.smtpUser, imap, password: input.password });

    const now = new Date();
    const data = {
      provider: "smtp" as const,
      email,
      displayName: input.displayName ?? "",
      status: "connected" as const,
      lastError: "",
      lastCheckedAt: now,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpSecurity: input.smtpSecurity,
      smtpUser: input.smtpUser,
      imapEnabled: Boolean(imap),
      imapHost: imap?.host ?? "",
      imapPort: imap?.port ?? 993,
      imapSecurity: imap?.security ?? "ssl",
      imapUser: imap?.user ?? "",
      secretSealed: seal(input.password),
      oauthAccessSealed: null,
      oauthExpiresAt: null,
      oauthScope: "",
      dailyLimit: input.dailyLimit,
      minDelaySeconds: input.minDelaySeconds,
      signature: input.signature ?? "",
      imapUidValidity: null,
      imapUidNext: null,
      lastSyncedAt: null,
      syncError: "",
      deletedAt: null,
    };
    let box: Mailbox;
    try {
      box = existing
        ? await this.prisma.db.mailbox.update({ where: { id: existing.id, workspaceId: w.id }, data })
        : await this.prisma.db.mailbox.create({ data: { workspaceId: w.id, createdById: actorId(ctx), ...data } });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw conflict(`${email} is already connected to this workspace.`, { email: "Already connected" });
      throw e;
    }
    dropTransport(box.id);
    await this.audit.record(ctx, { action: "mailbox.connected", targetType: "mailbox", targetId: box.id, metadata: { email, provider: "smtp", smtpHost: box.smtpHost, imapHost: box.imapHost } });
    if (box.imapEnabled) await this.enqueueSync(w.id, box.id);
    return mailboxDto(box);
  }

  async update(ctx: RequestContext, id: string, input: UpdateMailboxInputT) {
    const w = ws(ctx);
    const box = await this.find(w.id, id);
    const data: Prisma.MailboxUpdateInput = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.dailyLimit !== undefined) data.dailyLimit = input.dailyLimit;
    if (input.minDelaySeconds !== undefined) data.minDelaySeconds = input.minDelaySeconds;
    if (input.signature !== undefined) data.signature = input.signature;
    if (input.password !== undefined) {
      if (box.provider !== "smtp") throw badRequest("This mailbox signs in through its provider — reconnect it instead of setting a password.");
      await this.proveCredentials({
        smtpHost: box.smtpHost,
        smtpPort: box.smtpPort,
        smtpSecurity: box.smtpSecurity,
        smtpUser: box.smtpUser || box.email,
        imap: box.imapEnabled && box.imapHost ? { host: box.imapHost, port: box.imapPort, security: box.imapSecurity, user: box.imapUser || box.smtpUser || box.email } : null,
        password: input.password,
      });
      Object.assign(data, { secretSealed: seal(input.password), status: "connected", lastError: "", lastCheckedAt: new Date() });
    }
    const updated = await this.prisma.db.mailbox.update({ where: { id: box.id, workspaceId: w.id }, data });
    if (input.password !== undefined) dropTransport(box.id);
    await this.audit.record(ctx, {
      action: "mailbox.updated",
      targetType: "mailbox",
      targetId: box.id,
      metadata: { email: box.email, fields: Object.keys(input).filter((k) => k !== "password"), passwordChanged: input.password !== undefined },
    });
    const sent = await this.outbound.sentToday(w.id, [box.id]);
    return mailboxDto(updated, sent.get(box.id) ?? 0);
  }

  /** Soft delete. Campaign links stay; the sender skips deleted mailboxes. Credentials are wiped. */
  async remove(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const box = await this.find(w.id, id);
    // Campaigns that chose it forget it too: a deleted mailbox can never send, and a link the
    // Mailboxes tab no longer shows could not be cleared from there.
    await this.prisma.db.$transaction(async (tx) => {
      await tx.mailbox.update({
        where: { id: box.id, workspaceId: w.id },
        data: { deletedAt: new Date(), status: "disconnected", secretSealed: null, oauthAccessSealed: null, oauthExpiresAt: null },
      });
      await tx.campaignMailbox.deleteMany({ where: { workspaceId: w.id, mailboxId: box.id } });
    });
    dropTransport(box.id);
    await this.audit.record(ctx, { action: "mailbox.deleted", targetType: "mailbox", targetId: box.id, metadata: { email: box.email } });
  }

  /** Re-checks SMTP and IMAP with the stored credentials and records the result. */
  async verify(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const box = await this.find(w.id, id);
    const { updated, checks } = await this.checkAndRecord(box);
    const sent = await this.outbound.sentToday(w.id, [box.id]);
    return { ...mailboxDto(updated, sent.get(box.id) ?? 0), checks };
  }

  /**
   * Worker: the periodic health check (mailboxes.processors.ts). Same checks
   * and bookkeeping as "Verify"; returns the status before and after so the
   * caller can tell people when a mailbox stops working. Null when the
   * mailbox is gone or was disconnected meanwhile.
   */
  async healthCheck(workspaceId: string, mailboxId: string) {
    const box = await this.prisma.db.mailbox.findFirst({ where: { id: mailboxId, workspaceId, deletedAt: null } });
    if (!box || box.status === "disconnected") return null;
    const { updated, checks } = await this.checkAndRecord(box);
    return { mailbox: updated, before: box.status, after: updated.status, checks };
  }

  private async checkAndRecord(box: Mailbox) {
    const checks = await this.check(box);
    const ok = checks.smtp.ok && (!checks.imap || checks.imap.ok);
    const lastError = ok ? "" : !checks.smtp.ok ? `SMTP — ${checks.smtp.error}` : `IMAP — ${checks.imap?.error ?? "refused"}`;
    const updated = await this.prisma.db.mailbox.update({
      where: { id: box.id, workspaceId: box.workspaceId },
      data: { status: ok ? "connected" : "error", lastError: lastError.slice(0, 500), lastCheckedAt: new Date() },
    });
    dropTransport(box.id);
    return { updated, checks };
  }

  private async check(box: Mailbox): Promise<{ smtp: { ok: boolean; error: string }; imap: { ok: boolean; error: string } | null }> {
    const smtp = await (async () => {
      try {
        const pinned = await resolvePinnedTarget(box.smtpHost, box.smtpPort, "SMTP", this.allowPrivate);
        const settings = await this.auth.smtpSettings(box);
        const r = await verifySmtp({ ...settings, address: pinned.address, mailboxId: `probe-${randomUUID()}` });
        return r.ok ? { ok: true, error: "" } : { ok: false, error: r.error };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })();
    if (!box.imapEnabled || !box.imapHost) return { smtp, imap: null };
    const imap = await (async () => {
      try {
        await assertReachableTarget(box.imapHost, box.imapPort, "IMAP", this.allowPrivate);
        const auth = await this.auth.imapAuth(box);
        const r = await verifyImap({ host: box.imapHost, port: box.imapPort, security: box.imapSecurity, auth, allowSelfSigned: this.selfSigned(box.imapHost) });
        return r.ok ? { ok: true, error: "" } : { ok: false, error: r.error };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })();
    return { smtp, imap };
  }

  /** A real message through the shared send path, to prove relaying (not just the login). */
  async testSend(ctx: RequestContext, id: string, input: TestSendInputT) {
    const w = ws(ctx);
    const box = await this.find(w.id, id);
    // Counted from the audit trail: every attempt is recorded before it is made.
    const recent = await this.prisma.db.auditEvent.count({
      where: { workspaceId: w.id, action: "mailbox.test_send", targetId: box.id, createdAt: { gte: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= TEST_SENDS_PER_HOUR) {
      throw tooMany(`${box.email} has sent ${TEST_SENDS_PER_HOUR} test messages in the last hour — wait before sending more.`);
    }
    await this.audit.record(ctx, { action: "mailbox.test_send", targetType: "mailbox", targetId: box.id, metadata: { to: input.to } });
    const result = await this.outbound.send({
      workspaceId: w.id,
      mailboxId: box.id,
      to: input.to,
      subject: input.subject || `Test from ${box.email}`,
      body:
        input.body ||
        [
          `This is a test from ${box.email}, sent through ${box.smtpHost} by ${(await this.branding.get()).productName}.`,
          "",
          "If you are reading it, outreach can go out from this address.",
        ].join("\n"),
      kind: "manual",
      contactId: null,
      authorId: actorId(ctx),
    });
    return {
      sent: result.status === "sent",
      status: result.status,
      to: input.to,
      reason: "reason" in result ? result.reason : "",
      messageId: "messageRowId" in result ? (result.messageRowId ?? null) : null,
    };
  }

  async syncNow(ctx: RequestContext, id: string) {
    const w = ws(ctx);
    const box = await this.find(w.id, id);
    if (!box.imapEnabled || !box.imapHost) throw conflict("Reply tracking (IMAP) is off for this mailbox, so there is nothing to read.");
    await this.enqueueSync(w.id, box.id, true);
    return { queued: true };
  }

  /**
   * Which provider an address is on, and the servers that go with it, for the
   * connect dialog: free-mail domains by name, any other domain by its MX.
   * Nothing is stored and no server is contacted beyond DNS.
   */
  async detect(email: string) {
    const domain = domainOf(email);
    const mx = domain ? await lookupMx(domain, this.resolver) : [];
    return { email, domain, mx: mx.slice(0, 5), ...detectMailProvider(email, mx) };
  }

  async dns(ctx: RequestContext, id: string) {
    const box = await this.find(ws(ctx).id, id);
    return domainAuth(box.email, box.smtpHost, this.resolver);
  }

  /**
   * Queues a sync. The fixed job id means a sync already waiting or running
   * absorbs this one; removed on completion so the id frees for the next.
   * BullMQ refuses custom ids containing ":", hence "sync-<id>".
   */
  async enqueueSync(workspaceId: string, mailboxId: string, strict = false) {
    try {
      await this.queues.add("mail", "sync-mailbox", { workspaceId, mailboxId }, { jobId: `sync-${mailboxId}`, attempts: 1, removeOnComplete: true, removeOnFail: true });
    } catch (e) {
      this.log.warn(`could not queue a sync for ${mailboxId}: ${e instanceof Error ? e.message : String(e)}`);
      if (strict) throw e;
    }
  }
}
