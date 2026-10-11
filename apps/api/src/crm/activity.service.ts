import { Injectable } from "@nestjs/common";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";

export type ActivityInput = {
  workspaceId: string;
  type: string;
  summary: string;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  actorId?: string | null;
  data?: Record<string, unknown>;
  occurredAt?: Date;
};

/** The timeline every contact, company and deal page shows. Written next to the change it describes. */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: ActivityInput, tx?: Tx) {
    const db = tx ?? this.prisma.db;
    return db.activity.create({
      data: {
        workspaceId: input.workspaceId,
        type: input.type,
        summary: input.summary.slice(0, 500),
        contactId: input.contactId ?? null,
        companyId: input.companyId ?? null,
        dealId: input.dealId ?? null,
        actorId: input.actorId ?? null,
        data: (input.data ?? {}) as never,
        occurredAt: input.occurredAt ?? new Date(),
      },
    });
  }

  async forContact(workspaceId: string, contactId: string, take = 100) {
    return this.prisma.db.activity.findMany({
      where: { workspaceId, contactId },
      orderBy: { occurredAt: "desc" },
      take,
    });
  }
}
