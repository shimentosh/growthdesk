import { Injectable } from "@nestjs/common";
import { ContactFilter, emailDomain, type MarketingAudienceT } from "@growthdesk/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { ContactsService } from "../crm/contacts.service.js";
import { CrmExtrasService } from "../crm/crm-extras.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { parseWith } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";

/** A campaign's audience as stored: the input plus, once launched, the saved view's filter frozen as a Prisma where. */
export type StoredAudience = MarketingAudienceT & { segmentWhere?: Prisma.ContactWhereInput | null };

export const readAudience = (raw: unknown): StoredAudience => {
  const a = (raw && typeof raw === "object" ? raw : {}) as Partial<StoredAudience>;
  return { listIds: a.listIds ?? [], excludeListIds: a.excludeListIds ?? [], viewId: a.viewId ?? null, segmentWhere: a.segmentWhere ?? null };
};

/*
 * Who a marketing campaign may reach (R2/R3): a live contact with an email,
 * recorded consent, not do-not-contact, never hard-bounced, subscribed to at
 * least one included list, in no excluded list, matched by the segment when
 * one is set, and on no suppression that stops marketing.
 */
@Injectable()
export class AudienceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
    private readonly extras: CrmExtrasService,
  ) {}

  /** The contact filter for a request: freezes the saved view (segment) into a where the worker can run later. */
  async resolve(ctx: RequestContext, audience: MarketingAudienceT): Promise<StoredAudience> {
    let segmentWhere: Prisma.ContactWhereInput | null = null;
    if (audience.viewId) {
      const view = await this.extras.getView(ctx, audience.viewId);
      segmentWhere = this.contacts.where(ctx, parseWith(ContactFilter, view.filters ?? {}));
    }
    return { listIds: audience.listIds, excludeListIds: audience.excludeListIds, viewId: audience.viewId ?? null, segmentWhere };
  }

  where(workspaceId: string, a: StoredAudience): Prisma.ContactWhereInput {
    const and: Prisma.ContactWhereInput[] = [
      { workspaceId, deletedAt: null, archivedAt: null, email: { not: null }, doNotContact: false, bouncedAt: null, consentStatus: "granted" },
      { listMemberships: { some: { workspaceId, listId: { in: a.listIds }, status: "subscribed", list: { archivedAt: null } } } },
    ];
    if (a.excludeListIds.length) and.push({ NOT: { listMemberships: { some: { workspaceId, listId: { in: a.excludeListIds }, status: "subscribed" } } } });
    if (a.segmentWhere) and.push(a.segmentWhere);
    return { AND: and };
  }

  /** Emails and domains a marketing send must skip (scope all or marketing). */
  async suppressed(workspaceId: string, tx?: Tx): Promise<{ emails: Set<string>; domains: Set<string> }> {
    const db = tx ?? this.prisma.db;
    const rows = await db.suppression.findMany({
      where: { workspaceId, kind: { in: ["email", "domain"] }, scope: { in: SuppressionService.scopesFor("marketing") } },
      select: { kind: true, value: true },
    });
    return {
      emails: new Set(rows.filter((r) => r.kind === "email").map((r) => r.value)),
      domains: new Set(rows.filter((r) => r.kind === "domain").map((r) => r.value)),
    };
  }

  /** The eligible contacts, as id + email, in id order. */
  async recipients(workspaceId: string, a: StoredAudience, tx?: Tx): Promise<{ id: string; email: string }[]> {
    if (!a.listIds.length) return [];
    const db = tx ?? this.prisma.db;
    const [rows, sup] = await Promise.all([
      db.contact.findMany({ where: this.where(workspaceId, a), select: { id: true, email: true }, orderBy: { id: "asc" } }),
      this.suppressed(workspaceId, tx),
    ]);
    return rows
      .filter((r): r is { id: string; email: string } => Boolean(r.email))
      .filter((r) => !sup.emails.has(r.email) && !sup.domains.has(emailDomain(r.email)));
  }

  async count(ctx: RequestContext, workspaceId: string, audience: MarketingAudienceT): Promise<number> {
    return (await this.recipients(workspaceId, await this.resolve(ctx, audience))).length;
  }
}
