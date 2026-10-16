import { z } from "zod";
import { SUPPRESSION_KINDS, SUPPRESSION_SCOPES, SuppressionInput, isUnlimited } from "@growthdesk/shared";
import { notFound } from "../../../common/errors.js";
import { EntitlementsService } from "../../../billing/entitlements.service.js";
import { SuppressionService } from "../../../crm/suppression.service.js";
import { MarketingSetupService } from "../../../marketing/setup.service.js";
import { DoubleOptInService } from "../../../marketing/double-opt-in.service.js";
import { defineTool, pageInput, paged } from "../../tool.js";
import { emailAllowance } from "./helpers.js";

/*
 * Sending setup status (read-only: connecting an email service or adding a
 * domain stays in the app — they involve credentials and DNS) and the
 * suppression (do-not-contact) list, with the CRM routes' permissions.
 */

export const SETUP_TOOLS = [
  defineTool({
    name: "marketing_setup_status",
    title: "Email marketing setup status",
    description:
      "Whether the workspace can send marketing email, and what is missing: the email service connection, each sending domain with its DNS checks, the company legal name and postal address (required in every email), double opt-in readiness, and this month's allowances (marketing emails, marketing contacts). Call it first when planning a newsletter. Setup itself (connecting the service, DNS) is done in the app under Settings → Sending domains.",
    input: z.object({}),
    permission: "marketing.read",
    risk: "read",
    handler: async (ctx, _args, deps) => {
      const w = ctx.workspace;
      const ent = deps.get(EntitlementsService);
      const [setup, e, contactsUsed, emails, doi, profile] = await Promise.all([
        deps.get(MarketingSetupService).setup(ctx),
        ent.forAccount(w.billingAccountId),
        ent.usage(w.billingAccountId, "marketingContacts"),
        emailAllowance(ctx, deps),
        deps.get(DoubleOptInService).notReady(w.id),
        deps.prisma.db.workspace.findUniqueOrThrow({ where: { id: w.id }, select: { legalName: true, postalAddress: true, marketingFromName: true, marketingReplyTo: true } }),
      ]);
      const domains = setup.domains.map((d) => {
        const checks = Object.fromEntries(
          Object.entries(d.checks ?? {}).map(([k, c]) => [k, c ? (c.ok ? "ok" : c.required ? "missing (required)" : "missing (optional)") : "not checked"]),
        );
        return {
          id: d.id,
          domain: d.domain,
          status: d.status,
          ...(d.pausedAt ? { paused: d.pausedReason || "paused" } : {}),
          dns: checks,
          ...(d.status === "verified" ? {} : { recordsToAdd: d.esp ? d.esp.records : d.records }),
          lastCheckedAt: d.lastCheckedAt,
        };
      });
      const verified = setup.domains.filter((d) => d.status === "verified" && !d.pausedAt);
      const cap = e.limits.marketingContacts;
      const missing = [
        ...(!e.features.marketing ? [`Email marketing is not included in the ${e.effectivePlan.name} plan.`] : []),
        ...(e.access !== "full" ? [e.reason] : []),
        ...(!setup.esp ? ["Connect an email service (Amazon SES, Resend or an SMTP relay) in Settings → Sending domains."] : setup.esp.status !== "connected" ? [`The email service is ${setup.esp.status}${setup.esp.lastError ? `: ${setup.esp.lastError}` : ""}. Reconnect it in Settings → Sending domains.`] : []),
        ...(!verified.length ? ["Add and verify a sending domain (DNS records) in Settings → Sending domains."] : []),
        ...(!profile.legalName.trim() || !profile.postalAddress.trim() ? ["Add the legal company name and postal address in Settings → Company profile."] : []),
      ];
      return {
        readyToSend: missing.length === 0,
        missing,
        plan: e.effectivePlan.name,
        emailService: setup.esp ? { provider: setup.esp.provider, status: setup.esp.status, ...(setup.esp.lastError ? { lastError: setup.esp.lastError } : {}) } : null,
        sendingDomains: domains,
        ...(setup.dnsChecksSkipped ? { note: "DNS checks are skipped on this server (development)." } : {}),
        companyProfile: { legalName: profile.legalName || null, postalAddress: profile.postalAddress || null, defaultFromName: profile.marketingFromName || ctx.workspace.name, defaultReplyTo: profile.marketingReplyTo || null },
        doubleOptIn: doi ? { ready: false, why: doi } : { ready: true },
        allowances: {
          marketingEmailsThisMonth: emails,
          marketingContacts: { used: contactsUsed, limit: isUnlimited(cap) ? null : cap },
        },
      };
    },
  }),

  defineTool({
    name: "list_suppressions",
    title: "List suppressed addresses",
    description: "The do-not-contact list: emails, domains and phone numbers that must not be contacted, with scope (all / outreach / marketing), reason (unsubscribed, bounced, complained, manual…) and when. Search by value.",
    input: z.object({ search: z.string().trim().max(200).optional(), ...pageInput }),
    permission: "contacts.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const r = await deps.get(SuppressionService).list(ctx.workspace.id, args.search || undefined, args.page, args.limit);
      return paged(
        r.items.map((s) => ({ id: s.id, kind: s.kind, value: s.value.startsWith("erased:") ? "(erased person)" : s.value, scope: s.scope, reason: s.reason, source: s.source, createdAt: s.createdAt })),
        r.total,
        args.page,
        args.limit,
      );
    },
  }),

  defineTool({
    name: "add_suppression",
    title: "Suppress an address",
    description: "Adds an email, a whole domain or a phone number to the do-not-contact list. scope: all (default — every channel), marketing (newsletters only) or outreach (sales sequences only). Takes effect immediately, including for campaigns already sending.",
    input: z.object({
      kind: z.enum(SUPPRESSION_KINDS),
      value: SuppressionInput.shape.value,
      reason: SuppressionInput.shape.reason,
      scope: z.enum(SUPPRESSION_SCOPES).default("all"),
    }),
    permission: "contacts.write",
    risk: "write",
    handler: async (ctx, args, deps) => {
      const body = SuppressionInput.parse(args);
      const row = await deps.get(SuppressionService).add(ctx.workspace.id, body.kind, body.value, body.reason, "manual", ctx.identity.userId, undefined, body.scope);
      return { id: row.id, kind: row.kind, value: row.value, scope: row.scope, reason: row.reason };
    },
  }),

  defineTool({
    name: "remove_suppression",
    title: "Remove a suppression",
    description: "Takes an entry off the do-not-contact list (id from list_suppressions), so that address can be contacted again. Only do this when the person has clearly asked to hear from you again.",
    input: z.object({ suppressionId: z.string().uuid() }),
    permission: "contacts.delete",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const s = await deps.prisma.db.suppression.findFirst({ where: { id: args.suppressionId, workspaceId: ctx.workspace.id } });
      if (!s) throw notFound("That suppression entry");
      const value = s.value.startsWith("erased:") ? "an erased person's address" : s.value;
      return {
        summary: `Remove ${value} (${s.kind}, scope ${s.scope}, reason "${s.reason}") from the do-not-contact list — ${s.scope === "all" ? "every channel" : s.scope} may contact it again.${["unsubscribed", "complained", "bounced"].includes(s.reason) ? ` Careful: it was added because of "${s.reason}".` : ""}`,
        details: { suppressionId: s.id, kind: s.kind, value, scope: s.scope, reason: s.reason },
      };
    },
    handler: async (ctx, args, deps) => {
      await deps.get(SuppressionService).remove(ctx.workspace.id, args.suppressionId);
      return { deleted: true, suppressionId: args.suppressionId };
    },
  }),
];
