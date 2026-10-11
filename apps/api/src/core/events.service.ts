import { Injectable, Logger } from "@nestjs/common";
import { PrismaService, type Tx } from "../prisma/prisma.service.js";
import { Queues } from "../queues/queues.js";

export type DomainEventInput = {
  workspaceId: string;
  type: string;
  subjectType?: string;
  subjectId?: string;
  actorId?: string | null;
  payload?: Record<string, unknown>;
};

/*
 * Transactional outbox. A domain event is written in the same transaction as
 * the change it describes, so it exists if and only if the change committed.
 * The worker's dispatcher drains undispatched events into workflows, outgoing
 * webhooks and notifications; `kick()` asks it to look now, and a recurring
 * sweep catches anything a lost kick would have missed.
 */
@Injectable()
export class EventsService {
  private readonly log = new Logger("events");

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: Queues,
  ) {}

  /** Write an event inside an existing transaction. Call kick() after the transaction commits. */
  async emitIn(tx: Tx, event: DomainEventInput) {
    return tx.domainEvent.create({
      data: {
        workspaceId: event.workspaceId,
        type: event.type,
        subjectType: event.subjectType ?? "",
        subjectId: event.subjectId ?? "",
        actorId: event.actorId ?? null,
        payload: (event.payload ?? {}) as never,
      },
    });
  }

  /** Write an event outside a transaction and dispatch it promptly. */
  async emit(event: DomainEventInput) {
    const row = await this.prisma.db.domainEvent.create({
      data: {
        workspaceId: event.workspaceId,
        type: event.type,
        subjectType: event.subjectType ?? "",
        subjectId: event.subjectId ?? "",
        actorId: event.actorId ?? null,
        payload: (event.payload ?? {}) as never,
      },
    });
    await this.kick();
    return row;
  }

  async kick() {
    try {
      // The fixed jobId collapses a burst of kicks into one pending dispatch.
      await this.queues.add("events", "dispatch", {}, { jobId: "dispatch", attempts: 1, removeOnComplete: true, removeOnFail: true });
    } catch (e) {
      this.log.warn(`could not kick the dispatcher: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
