import { Inject, Injectable } from "@nestjs/common";
import { emailDomain, type EspConnectionInput, type SendingDomainInput, type SendingDomainUpdate } from "@growthdesk/shared";
import type { z } from "zod";
import type { EspConnection, SendingDomain } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { AuditService } from "../core/audit.service.js";
import { assertReachableTarget, isLocalHost } from "../mailboxes/net-guard.js";
import { newToken, open, seal } from "../common/crypto.js";
import { badRequest, conflict, notFound } from "../common/errors.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { checkDomain, DnsResolver, domainVerified, type DomainChecks } from "./dns.js";
import { dropEspTransport, sesHost, verifyEsp, type EspSmtp } from "./esp.js";

type EspSettings = { host: string; port: number; security: "ssl" | "starttls" | "none"; username: string; region?: string };

/*
 * Marketing's sending setup: the workspace's email service (ESP) and its
 * sending domains. Kept apart from outreach mailboxes on purpose (R1): a
 * domain registered here cannot also be an outreach mailbox's domain.
 */
@Injectable()
export class MarketingSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly dns: DnsResolver,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ─── Email service ─────────────────────────────────────────────────────────

  webhookUrl(token: string) {
    return `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/api/m/hooks/${token}`;
  }

  espDto(c: EspConnection | null) {
    if (!c) return null;
    const s = c.settings as EspSettings;
    return {
      id: c.id,
      provider: c.provider,
      host: s.host,
      port: s.port,
      security: s.security,
      username: s.username,
      region: s.region ?? null,
      hasPassword: Boolean(c.secretSealed),
      status: c.status,
      lastError: c.lastError,
      lastCheckedAt: c.lastCheckedAt,
      webhookUrl: this.webhookUrl(c.webhookToken),
    };
  }

  /** SMTP settings for sending; null when the stored password no longer opens (key changed). */
  smtpFor(c: EspConnection): EspSmtp | null {
    const s = c.settings as EspSettings;
    const password = c.secretSealed ? open(c.secretSealed) : "";
    if (password === null) return null;
    return {
      connectionId: c.id,
      host: s.host,
      port: s.port,
      security: s.security,
      username: s.username,
      password,
      allowSelfSigned: isLocalHost(s.host) && this.config.ALLOW_PRIVATE_MAIL_HOSTS,
    };
  }

  async setup(ctx: RequestContext) {
    const w = ws(ctx);
    const [esp, domains] = await Promise.all([
      this.prisma.db.espConnection.findUnique({ where: { workspaceId: w.id } }),
      this.prisma.db.sendingDomain.findMany({ where: { workspaceId: w.id, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    ]);
    return { esp: this.espDto(esp), domains: domains.map((d) => this.domainDto(d)), dnsChecksSkipped: this.skipDns() };
  }

  async connectEsp(ctx: RequestContext, input: z.infer<typeof EspConnectionInput>) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "marketing");
    const current = await this.prisma.db.espConnection.findUnique({ where: { workspaceId: w.id } });

    const settings: EspSettings =
      input.provider === "ses"
        ? { host: sesHost(input.region), port: 587, security: "starttls", username: input.username, region: input.region }
        : { host: input.host.trim().toLowerCase(), port: input.port, security: input.security, username: input.username };
    await assertReachableTarget(settings.host, settings.port, "SMTP", this.config.ALLOW_PRIVATE_MAIL_HOSTS);

    const sameEndpoint = current && current.provider === input.provider && (current.settings as EspSettings).host === settings.host && (current.settings as EspSettings).username === settings.username;
    let password = input.password ?? null;
    if (password === null && sameEndpoint && current?.secretSealed) password = open(current.secretSealed);
    if (input.provider === "ses" && !password) throw badRequest("Enter the SMTP password for these SES credentials", { password: "Required" });

    const smtp: EspSmtp = { connectionId: current?.id ?? "new", ...settings, password: password ?? "", allowSelfSigned: isLocalHost(settings.host) && this.config.ALLOW_PRIVATE_MAIL_HOSTS };
    const verified = await verifyEsp(smtp);
    if (!verified.ok) throw badRequest(`Could not sign in to ${settings.host}: ${verified.error}`);

    const data = { provider: input.provider, settings, secretSealed: password ? seal(password) : null, status: "connected" as const, lastError: "", lastCheckedAt: new Date() };
    const row = current
      ? await this.prisma.db.espConnection.update({ where: { workspaceId: w.id }, data })
      : await this.prisma.db.espConnection.create({ data: { ...data, workspaceId: w.id, webhookToken: newToken(24), createdById: actorId(ctx) } });
    if (current) dropEspTransport(current.id);
    await this.audit.record(ctx, { action: "marketing.esp_connected", targetType: "esp_connection", targetId: row.id, metadata: { provider: input.provider, host: settings.host } });
    return this.espDto(row);
  }

  async disconnectEsp(ctx: RequestContext) {
    const w = ws(ctx);
    const current = await this.prisma.db.espConnection.findUnique({ where: { workspaceId: w.id } });
    if (!current) throw notFound("An email service");
    const sending = await this.prisma.db.marketingCampaign.count({ where: { workspaceId: w.id, status: { in: ["sending", "scheduled"] }, deletedAt: null } });
    if (sending) throw conflict("A marketing campaign is sending or scheduled. Pause or cancel it before disconnecting.");
    await this.prisma.db.espConnection.delete({ where: { workspaceId: w.id } });
    dropEspTransport(current.id);
    await this.audit.record(ctx, { action: "marketing.esp_disconnected", targetType: "esp_connection", targetId: current.id });
    return { disconnected: true };
  }

  // ─── Sending domains ───────────────────────────────────────────────────────

  private skipDns() {
    return this.config.MARKETING_SKIP_DNS_CHECKS && this.config.NODE_ENV !== "production";
  }

  domainDto(d: SendingDomain) {
    return {
      id: d.id,
      domain: d.domain,
      status: d.status,
      dkimSelectors: d.dkimSelectors,
      checks: d.checks as Partial<DomainChecks>,
      records: {
        ownership: { type: "TXT", name: `_growthdesk.${d.domain}`, value: `growthdesk-verification=${d.verificationToken}` },
        dmarc: { type: "TXT", name: `_dmarc.${d.domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${d.domain}` },
      },
      lastCheckedAt: d.lastCheckedAt,
      verifiedAt: d.verifiedAt,
      pausedAt: d.pausedAt,
      pausedReason: d.pausedReason,
      createdAt: d.createdAt,
    };
  }

  private async findDomain(ctx: RequestContext, id: string) {
    const d = await this.prisma.db.sendingDomain.findFirst({ where: { id, workspaceId: ws(ctx).id, deletedAt: null } });
    if (!d) throw notFound("That sending domain");
    return d;
  }

  async addDomain(ctx: RequestContext, input: z.infer<typeof SendingDomainInput>) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "marketing");
    // R1: an outreach mailbox's domain is never also a marketing sending domain.
    const mailboxes = await this.prisma.db.mailbox.findMany({ where: { workspaceId: w.id, deletedAt: null }, select: { email: true } });
    if (mailboxes.some((m) => emailDomain(m.email) === input.domain)) {
      throw badRequest(`${input.domain} is used by an outreach mailbox. Send marketing from a different subdomain, such as news.${input.domain}, so cold outreach never affects your newsletter's reputation.`, { domain: "Used for outreach" });
    }
    const existing = await this.prisma.db.sendingDomain.findUnique({ where: { workspaceId_domain: { workspaceId: w.id, domain: input.domain } } });
    if (existing && !existing.deletedAt) throw conflict(`${input.domain} is already added.`, { domain: "Already added" });
    await this.entitlements.assertCapacity(w.billingAccountId, "sendingDomains");
    const row = existing
      ? await this.prisma.db.sendingDomain.update({ where: { id: existing.id, workspaceId: w.id }, data: { deletedAt: null, status: "pending", dkimSelectors: input.dkimSelectors, checks: {}, verifiedAt: null, pausedAt: null, pausedReason: "" } })
      : await this.prisma.db.sendingDomain.create({ data: { workspaceId: w.id, domain: input.domain, verificationToken: newToken(18), dkimSelectors: input.dkimSelectors, createdById: actorId(ctx) } });
    await this.audit.record(ctx, { action: "marketing.domain_added", targetType: "sending_domain", targetId: row.id, metadata: { domain: row.domain } });
    return this.domainDto(row);
  }

  async updateDomain(ctx: RequestContext, id: string, input: z.infer<typeof SendingDomainUpdate>) {
    const d = await this.findDomain(ctx, id);
    const row = await this.prisma.db.sendingDomain.update({
      where: { id, workspaceId: d.workspaceId },
      data: {
        ...(input.dkimSelectors ? { dkimSelectors: input.dkimSelectors } : {}),
        ...(input.paused === false ? { pausedAt: null, pausedReason: "" } : {}),
      },
    });
    if (input.paused === false && d.pausedAt) await this.audit.record(ctx, { action: "marketing.domain_unpaused", targetType: "sending_domain", targetId: id, metadata: { reason: d.pausedReason } });
    // New selectors were never looked up: check DNS again rather than keep a stale "verified".
    const changed = input.dkimSelectors && [...input.dkimSelectors].sort().join() !== [...d.dkimSelectors].sort().join();
    return changed ? this.verifyDomain(ctx, id) : this.domainDto(row);
  }

  /** Looks the DNS records up again and updates the status. */
  async verifyDomain(ctx: RequestContext, id: string) {
    const d = await this.findDomain(ctx, id);
    let checks: DomainChecks;
    if (this.skipDns()) {
      // Same expected records as a real check, every one marked as passing.
      const none: DnsResolver = { txt: async () => [], cname: async () => [] };
      const real = await checkDomain(none, d.domain, d.verificationToken, d.dkimSelectors.length ? d.dkimSelectors : ["s1"]);
      const pass = (c: DomainChecks[keyof DomainChecks]) => ({ ...c, ok: true, found: ["skipped in development (MARKETING_SKIP_DNS_CHECKS)"] });
      checks = { ownership: pass(real.ownership), dkim: pass(real.dkim), dmarc: pass(real.dmarc), spf: pass(real.spf) };
    } else {
      checks = await checkDomain(this.dns, d.domain, d.verificationToken, d.dkimSelectors);
    }
    const verified = domainVerified(checks);
    const now = new Date();
    const row = await this.prisma.db.sendingDomain.update({
      where: { id, workspaceId: d.workspaceId },
      data: {
        checks: checks as never,
        lastCheckedAt: now,
        status: verified ? "verified" : d.status === "verified" ? "failed" : "pending",
        verifiedAt: verified ? (d.verifiedAt ?? now) : null,
      },
    });
    return this.domainDto(row);
  }

  async removeDomain(ctx: RequestContext, id: string) {
    const d = await this.findDomain(ctx, id);
    const busy = await this.prisma.db.marketingCampaign.count({ where: { workspaceId: d.workspaceId, sendingDomainId: id, status: { in: ["sending", "scheduled", "paused"] }, deletedAt: null } });
    if (busy) throw conflict("A campaign that is sending, scheduled or paused uses this domain. Finish or cancel it first.");
    await this.prisma.db.sendingDomain.update({ where: { id, workspaceId: d.workspaceId }, data: { deletedAt: new Date(), status: "pending" } });
    await this.audit.record(ctx, { action: "marketing.domain_removed", targetType: "sending_domain", targetId: id, metadata: { domain: d.domain } });
    return { removed: true };
  }
}
