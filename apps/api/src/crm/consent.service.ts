import { Injectable } from "@nestjs/common";
import type { ConsentStatus } from "@growthdesk/shared";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { notFound } from "../common/errors.js";
import { ActivityService } from "./activity.service.js";

export type ConsentChange = {
  workspaceId: string;
  contactId: string;
  status: ConsentStatus;
  /** Shown to people: "Web form", "Import", "Unsubscribe link". */
  source?: string;
  ip?: string;
  userAgent?: string;
  /** Structured context: { via, listId, formId, importId, messageId }. */
  detail?: Record<string, unknown>;
  actorId?: string | null;
  at?: Date;
};

const SUMMARY: Record<ConsentStatus, string> = {
  granted: "Marketing consent granted",
  denied: "Marketing consent withdrawn",
  unknown: "Marketing consent cleared",
};

/*
 * Marketing consent (R2 in docs/PRODUCT_PLAN.md). Contact.consentStatus,
 * consentSource and consentAt hold the current value; every change also
 * writes a ConsentEvent so the workspace can prove when, how and from where
 * someone agreed. All consent writes go through `setIn`, never a raw update.
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Moves a contact to `status` inside `tx`, with a history row and a timeline
   * entry. A repeat of the current status with the same source changes nothing
   * and returns false.
   */
  async setIn(tx: Tx, c: ConsentChange): Promise<boolean> {
    const current = await tx.contact.findFirst({
      where: { id: c.contactId, workspaceId: c.workspaceId },
      select: { consentStatus: true, consentSource: true },
    });
    if (!current) throw notFound("That contact");
    const source = (c.source ?? current.consentSource).slice(0, 200);
    if (current.consentStatus === c.status && current.consentSource === source) return false;

    const at = c.at ?? new Date();
    await tx.contact.update({
      where: { id: c.contactId, workspaceId: c.workspaceId },
      data: { consentStatus: c.status, consentSource: source, ...(current.consentStatus !== c.status ? { consentAt: at } : {}) },
    });
    await tx.consentEvent.create({
      data: {
        workspaceId: c.workspaceId,
        contactId: c.contactId,
        status: c.status,
        source,
        ip: (c.ip ?? "").slice(0, 64),
        userAgent: (c.userAgent ?? "").slice(0, 500),
        detail: (c.detail ?? {}) as never,
        actorId: c.actorId ?? null,
        createdAt: at,
      },
    });
    if (current.consentStatus !== c.status) {
      await this.activity.log(
        {
          workspaceId: c.workspaceId,
          contactId: c.contactId,
          actorId: c.actorId,
          type: "contact.consent",
          summary: source ? `${SUMMARY[c.status]} (${source})` : SUMMARY[c.status],
          data: { status: c.status, from: current.consentStatus, source },
          occurredAt: at,
        },
        tx,
      );
    }
    return true;
  }

  /** The contact's consent history, newest first. */
  async history(workspaceId: string, contactId: string) {
    const rows = await this.prisma.db.consentEvent.findMany({
      where: { workspaceId, contactId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((v): v is string => Boolean(v)))];
    const actors = actorIds.length ? await this.prisma.db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
    const byId = new Map(actors.map((a) => [a.id, a]));
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      source: r.source,
      ip: r.ip,
      userAgent: r.userAgent,
      detail: r.detail,
      actor: r.actorId ? (byId.get(r.actorId) ?? null) : null,
      createdAt: r.createdAt,
    }));
  }
}
