import { Injectable } from "@nestjs/common";
import { normalizeEmail, normalizePhone } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { actorId, ownershipScope, ws, type RequestContext } from "../common/context.js";
import { notFound } from "../common/errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * GDPR data-subject requests for one person (docs/PRIVACY_OPS.md):
 *
 * - export: everything the workspace holds about a contact, as one JSON
 *   document, including full message bodies (it is their own correspondence).
 * - erase: a hard delete of the contact, the records merged into it, their
 *   conversations and messages, calls and events, plus a suppression entry
 *   per address and number keyed on a hash (SuppressionService.erasureValue),
 *   so the person is never imported, created or contacted again while the
 *   workspace keeps no readable copy of the address. Deals, tasks and
 *   meetings stay as the company's records, unlinked from the person.
 *
 * Both respect record ownership (roles without records.view_all only reach
 * their own and unowned contacts), like every other contact route.
 */
@Injectable()
export class ContactPrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly suppression: SuppressionService,
  ) {}

  /** The contact plus every contact merged into it (the same person under older records). */
  private async subject(ctx: RequestContext, contactId: string) {
    const w = ws(ctx);
    if (!UUID.test(contactId)) throw notFound("That contact");
    const contact = await this.prisma.db.contact.findFirst({ where: { id: contactId, workspaceId: w.id, ...ownershipScope(ctx) } });
    if (!contact) throw notFound("That contact");
    const merged = await this.prisma.db.contact.findMany({ where: { workspaceId: w.id, mergedIntoId: contact.id }, select: { id: true } });
    return { w, contact, ids: [contact.id, ...merged.map((m) => m.id)] };
  }

  async exportContact(ctx: RequestContext, contactId: string) {
    const { w, contact, ids } = await this.subject(ctx, contactId);
    const workspaceId = w.id;
    const byContact = { workspaceId, contactId: { in: ids } };
    const [identifiers, sources, tags, notes, activities, consentEvents, deals, tasks, meetings, calls, enrollments, listMemberships, marketingSends, conversations, company] =
      await Promise.all([
        this.prisma.db.contactIdentifier.findMany({ where: byContact }),
        this.prisma.db.contactSource.findMany({ where: byContact }),
        this.prisma.db.contactTag.findMany({ where: byContact, include: { tag: { select: { name: true } } } }),
        this.prisma.db.note.findMany({ where: byContact, orderBy: { createdAt: "asc" } }),
        this.prisma.db.activity.findMany({ where: byContact, orderBy: { occurredAt: "asc" } }),
        this.prisma.db.consentEvent.findMany({ where: byContact, orderBy: { createdAt: "asc" } }),
        this.prisma.db.deal.findMany({ where: byContact }),
        this.prisma.db.task.findMany({ where: byContact }),
        this.prisma.db.meeting.findMany({ where: byContact }),
        this.prisma.db.call.findMany({ where: byContact }),
        this.prisma.db.enrollment.findMany({ where: byContact }),
        this.prisma.db.listMembership.findMany({ where: byContact, include: { list: { select: { name: true } } } }),
        this.prisma.db.marketingSend.findMany({ where: byContact }),
        this.prisma.db.conversation.findMany({ where: byContact, include: { messages: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "asc" } }),
        contact.companyId ? this.prisma.db.company.findFirst({ where: { id: contact.companyId, workspaceId }, select: { id: true, name: true, domain: true } }) : null,
      ]);
    const emails = [contact.email, ...identifiers.filter((i) => i.kind === "email").map((i) => i.value)].filter((v): v is string => Boolean(v));
    const phones = [contact.phone, ...identifiers.filter((i) => i.kind === "phone").map((i) => i.value)].filter((v): v is string => Boolean(v));
    const suppressions = await this.prisma.db.suppression.findMany({
      where: { workspaceId, OR: [{ kind: "email", value: { in: emails } }, { kind: "phone", value: { in: phones } }] },
    });
    await this.audit.record(ctx, { action: "contact.data_exported", targetType: "contact", targetId: contact.id });
    return {
      format: "growthdesk-contact-export",
      version: 1,
      exportedAt: new Date(),
      workspace: { id: w.id, name: w.name },
      contact,
      company,
      mergedContactIds: ids.slice(1),
      identifiers,
      sources,
      tags: tags.map((t) => ({ tagId: t.tagId, name: t.tag.name, contactId: t.contactId })),
      notes,
      activities,
      consentEvents,
      suppressions,
      deals,
      tasks,
      meetings,
      calls,
      enrollments,
      listMemberships: listMemberships.map(({ list, ...m }) => ({ ...m, listName: list.name })),
      marketingSends,
      conversations,
    };
  }

  async erase(ctx: RequestContext, contactId: string, reason?: string) {
    const { w, contact, ids } = await this.subject(ctx, contactId);
    const workspaceId = w.id;
    const identifiers = await this.prisma.db.contactIdentifier.findMany({ where: { workspaceId, contactId: { in: ids } } });
    const merged = ids.length > 1 ? await this.prisma.db.contact.findMany({ where: { workspaceId, id: { in: ids.slice(1) } }, select: { email: true, phone: true } }) : [];
    const emails = [
      ...new Set(
        [contact.email, ...merged.map((m) => m.email), ...identifiers.filter((i) => i.kind === "email").map((i) => i.value)]
          .map((e) => normalizeEmail(e ?? null))
          .filter((e): e is string => Boolean(e)),
      ),
    ];
    const phones = [
      ...new Set(
        [contact.phone, ...merged.map((m) => m.phone), ...identifiers.filter((i) => i.kind === "phone").map((i) => i.value)]
          .map((p) => normalizePhone(p ?? null))
          .filter((p): p is string => Boolean(p)),
      ),
    ];

    const result = await this.prisma.db.$transaction(async (tx) => {
      // Their correspondence: threads linked to them, or held with one of their addresses or numbers (messages cascade).
      const peers = [...emails, ...phones];
      const conversations = await tx.conversation.deleteMany({
        where: { workspaceId, OR: [{ contactId: { in: ids } }, ...(peers.length ? [{ peer: { in: peers } }] : [])] },
      });
      const calls = await tx.call.deleteMany({ where: { workspaceId, contactId: { in: ids } } });
      await tx.domainEvent.deleteMany({ where: { workspaceId, subjectType: "contact", subjectId: { in: ids } } });
      await tx.duplicateCandidate.deleteMany({ where: { workspaceId, OR: [{ contactId: { in: ids } }, { duplicateId: { in: ids } }] } });
      // Plain-text suppression rows would keep the address; the hashed entries below replace them.
      await tx.suppression.deleteMany({
        where: { workspaceId, OR: [{ kind: "email", value: { in: emails } }, { kind: "phone", value: { in: phones } }] },
      });
      const suppressed = await this.suppression.addErased(tx, workspaceId, emails, phones, actorId(ctx));
      // Identifiers, sources, tags, notes, activities, consent history, enrollments and list memberships cascade.
      const contacts = await tx.contact.deleteMany({ where: { workspaceId, id: { in: ids } } });
      return { contacts: contacts.count, conversations: conversations.count, calls: calls.count, suppressed };
    });
    // No personal data in the audit row: the id that no longer resolves, and counts.
    await this.audit.record(ctx, { action: "contact.erased", targetType: "contact", targetId: contact.id, metadata: { ...result, ...(reason ? { reason } : {}) } });
    return { erased: true, ...result };
  }
}
