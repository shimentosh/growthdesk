import { Injectable } from "@nestjs/common";
import { ContactFilter, emailDomain, nextOpening, normalizeEmail, normalizePhone } from "@growthdesk/shared";
import type { Campaign, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ContactsService } from "../crm/contacts.service.js";
import { CrmExtrasService } from "../crm/crm-extras.service.js";
import { parseWith } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { type AudienceT, configOf, firstActionStep, readSchedule, readSettings } from "./campaign-config.js";

export const SKIP_REASONS = ["not_found", "deleted", "do_not_contact", "unsubscribed", "bounced", "suppressed", "no_email", "already_enrolled"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export type Skipped = Partial<Record<SkipReason, number>>;

export const SKIP_LABELS: Record<SkipReason, string> = {
  not_found: "not in this workspace",
  deleted: "deleted",
  do_not_contact: "marked do-not-contact",
  unsubscribed: "unsubscribed",
  bounced: "bounced",
  suppressed: "on the suppression list",
  no_email: "no email address",
  already_enrolled: "already enrolled",
};

const BATCH = 1000;
const DAY_MS = 86_400_000;

const chunks = <T>(list: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/*
 * Who a campaign is for, who of them may be contacted, and putting them on
 * the clock. Shared by readiness, launch and manual enrollment so all three
 * apply exactly the same exclusions.
 */
@Injectable()
export class EnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
    private readonly extras: CrmExtrasService,
  ) {}

  /** Contact ids the audience names (before eligibility). A saved view or filter is resolved with the caller's visibility. */
  async candidates(ctx: RequestContext, audience: AudienceT | null): Promise<string[]> {
    if (!audience) return [];
    if (audience.type === "contacts") return [...new Set(audience.contactIds)];
    if (audience.type === "view") {
      const view = await this.extras.getView(ctx, audience.viewId);
      return this.contacts.idsFor(ctx, parseWith(ContactFilter, view.filters ?? {}));
    }
    return this.contacts.idsFor(ctx, audience.filter);
  }

  /** Whether the first acting step needs an email address. */
  static requiresEmail(steps: { type: string; config: unknown }[]): boolean {
    return firstActionStep(steps)?.type === "email";
  }

  /** Splits ids into those that may be contacted and counts of why the rest may not. Suppression is checked in one query per batch. */
  async eligible(workspaceId: string, ids: string[], requireEmail: boolean): Promise<{ eligible: string[]; skipped: Skipped }> {
    const skipped: Skipped = {};
    const skip = (r: SkipReason) => (skipped[r] = (skipped[r] ?? 0) + 1);
    const eligible: string[] = [];
    for (const batch of chunks([...new Set(ids)], 5000)) {
      const rows = await this.prisma.db.contact.findMany({
        where: { workspaceId, id: { in: batch } },
        select: { id: true, email: true, phone: true, deletedAt: true, doNotContact: true, unsubscribedAt: true, bouncedAt: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const open: typeof rows = [];
      for (const id of batch) {
        const c = byId.get(id);
        if (!c) skip("not_found");
        else if (c.deletedAt) skip("deleted");
        else if (c.doNotContact) skip("do_not_contact");
        else if (c.unsubscribedAt) skip("unsubscribed");
        else if (c.bouncedAt) skip("bounced");
        else if (requireEmail && !c.email) skip("no_email");
        else open.push(c);
      }
      const emails = [...new Set(open.map((c) => normalizeEmail(c.email)).filter((v): v is string => Boolean(v)))];
      const domains = [...new Set(emails.map(emailDomain))];
      const phones = [...new Set(open.map((c) => normalizePhone(c.phone)).filter((v): v is string => Boolean(v)))];
      const or: Prisma.SuppressionWhereInput[] = [];
      if (emails.length) or.push({ kind: "email", value: { in: emails } }, { kind: "domain", value: { in: domains } });
      if (phones.length) or.push({ kind: "phone", value: { in: phones } });
      const hits = or.length ? await this.prisma.db.suppression.findMany({ where: { workspaceId, OR: or }, select: { kind: true, value: true } }) : [];
      const blocked = new Set(hits.map((h) => `${h.kind}:${h.value}`));
      for (const c of open) {
        const email = normalizeEmail(c.email);
        const phone = normalizePhone(c.phone);
        const isBlocked =
          (email && (blocked.has(`email:${email}`) || blocked.has(`domain:${emailDomain(email)}`))) || (phone && blocked.has(`phone:${phone}`));
        if (isBlocked) skip("suppressed");
        else eligible.push(c.id);
      }
    }
    return { eligible, skipped };
  }

  /**
   * Enrolls eligible contacts. Starts are staggered so at most
   * `dailyNewLimit` contacts begin per day, `gapSeconds` apart, each inside
   * the send window: enrollment i starts on day floor(i / limit), slot
   * i % limit. Counting continues after the enrollments still waiting for
   * their first step, so a later batch queues behind the earlier one.
   */
  async enroll(
    workspaceId: string,
    campaign: Campaign,
    contactIds: string[],
    opts: { source: "manual" | "automation" | "api"; enrolledById: string | null },
  ): Promise<{ enrolled: number; enrolledIds: string[]; skipped: Skipped }> {
    const steps = await this.prisma.db.sequenceStep.findMany({ where: { workspaceId, sequenceId: campaign.sequenceId }, orderBy: { position: "asc" } });
    const { eligible, skipped } = await this.eligible(workspaceId, contactIds, EnrollmentService.requiresEmail(steps));

    const already = new Set<string>();
    for (const batch of chunks(eligible, 5000)) {
      const rows = await this.prisma.db.enrollment.findMany({ where: { workspaceId, campaignId: campaign.id, contactId: { in: batch } }, select: { contactId: true } });
      for (const r of rows) already.add(r.contactId);
    }
    if (already.size) skipped.already_enrolled = (skipped.already_enrolled ?? 0) + already.size;
    const fresh = eligible.filter((id) => !already.has(id));

    const schedule = readSchedule(campaign.schedule);
    const settings = readSettings(campaign.settings);
    const now = Date.now();
    const base = Math.max(now, campaign.startAt?.getTime() ?? now);
    const firstDelayMs = Math.max(0, Number(configOf(steps[0] ?? { config: {} }).delayMinutes ?? 0)) * 60_000;
    const waiting = await this.prisma.db.enrollment.count({ where: { workspaceId, campaignId: campaign.id, status: "active", stepRun: 0 } });
    const limit = Math.max(1, settings.dailyNewLimit);
    const startOf = (i: number) => {
      const dayOpens = nextOpening(schedule, new Date(base + Math.floor(i / limit) * DAY_MS + firstDelayMs));
      return nextOpening(schedule, new Date(dayOpens.getTime() + (i % limit) * settings.gapSeconds * 1000));
    };

    let enrolled = 0;
    const enrolledIds: string[] = [];
    for (const [b, batch] of chunks(fresh, BATCH).entries()) {
      const res = await this.prisma.db.enrollment.createMany({
        data: batch.map((contactId, k) => ({
          workspaceId,
          campaignId: campaign.id,
          contactId,
          status: "active" as const,
          position: 0,
          stepRun: 0,
          nextRunAt: startOf(waiting + b * BATCH + k),
          source: opts.source,
          enrolledById: opts.enrolledById,
        })),
        skipDuplicates: true,
      });
      enrolled += res.count;
      enrolledIds.push(...batch);
      // The timeline entry for each contact, written in bulk (one row per contact, as ActivityService.log would).
      await this.prisma.db.activity.createMany({
        data: batch.map((contactId) => ({
          workspaceId,
          contactId,
          actorId: opts.enrolledById,
          type: "campaign.enrolled",
          summary: `Enrolled in the campaign “${campaign.name}”`.slice(0, 500),
          data: { campaignId: campaign.id },
        })),
      });
    }
    const total = await this.prisma.db.enrollment.count({ where: { workspaceId, campaignId: campaign.id } });
    await this.prisma.db.campaign.updateMany({ where: { id: campaign.id, workspaceId }, data: { enrolledCount: total } });
    return { enrolled, enrolledIds, skipped };
  }
}
