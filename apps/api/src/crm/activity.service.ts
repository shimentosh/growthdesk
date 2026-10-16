import { Injectable } from "@nestjs/common";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { currentActor, type Actor } from "../common/actor.js";

export type ActivityInput = {
  workspaceId: string;
  type: string;
  summary: string;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  actorId?: string | null;
  /** Who acted, when the caller knows better than the current scope (src/common/actor.ts). */
  actor?: Actor;
  data?: Record<string, unknown>;
  occurredAt?: Date;
};

/** The timeline every contact, company and deal page shows. Written next to the change it describes. */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: ActivityInput, tx?: Tx) {
    const db = tx ?? this.prisma.db;
    const who = resolveActor(input);
    return db.activity.create({
      data: {
        workspaceId: input.workspaceId,
        type: input.type,
        summary: input.summary.slice(0, 500),
        contactId: input.contactId ?? null,
        companyId: input.companyId ?? null,
        dealId: input.dealId ?? null,
        actorId: who.actorId,
        actorType: who.actorType,
        actorName: who.actorName,
        actorRef: who.actorRef,
        onBehalfOfId: who.onBehalfOfId,
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

/**
 * Who a timeline entry is by. An explicit `actor` wins; then the scope's
 * (the request's person, AI agent or API key; a workflow run; a voice
 * agent); then an `actorId` passed on its own is that person; else the
 * system. An AI agent's entry keeps its teammate as actorId (so existing
 * per-person views still see it) and says it was the agent.
 */
export function resolveActor(input: Pick<ActivityInput, "actor" | "actorId">) {
  const a = input.actor ?? currentActor();
  const explicitId = input.actorId ?? null;
  if (!a) {
    return { actorId: explicitId, actorType: explicitId ? "user" : "system", actorName: "", actorRef: "", onBehalfOfId: null as string | null };
  }
  const name = (a.name ?? "").slice(0, 120);
  const ref = (a.ref ?? "").slice(0, 200);
  switch (a.type) {
    case "user":
      // A person's request may write entries about someone else's action (an explicit actorId); keep that person.
      return { actorId: explicitId ?? a.id ?? null, actorType: "user", actorName: explicitId && explicitId !== a.id ? "" : name, actorRef: ref, onBehalfOfId: null };
    case "ai_agent":
      return { actorId: explicitId ?? a.onBehalfOf?.id ?? null, actorType: "ai_agent", actorName: name || "AI agent", actorRef: ref, onBehalfOfId: a.onBehalfOf?.id ?? explicitId };
    default:
      return { actorId: explicitId, actorType: a.type, actorName: name, actorRef: ref, onBehalfOfId: a.onBehalfOf?.id ?? null };
  }
}
