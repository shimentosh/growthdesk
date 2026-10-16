import type { Prisma } from "../generated/prisma/client.js";

/*
 * The dispatcher's Discord step (automation/dispatcher.service.ts), run inside
 * its outbox transaction: for each event, a pending DiscordDelivery per
 * enabled rule that lists the event's type × each of the rule's channels.
 * Rows are unique per (rule, channel, event) and the transaction also marks
 * the events dispatched, so an event is planned exactly once. Conditions and
 * templates are applied by the delivery job, with the records as they are then.
 *
 * Skipped here: channels of disconnected or lost servers, and channels deleted
 * in Discord (status "missing"). Channels the bot lost access to are still
 * tried — permissions may have been fixed — and fail fast if not.
 *
 * An event no enabled rule lists is "unrouted": ignored, counted per type
 * (settings.unrouted = log), or counted and posted to the fallback channel.
 */

type Event = { id: string; workspaceId: string; type: string };
type Rule = { id: string; events: string[]; destinationIds: string[] };
type WorkspacePlan = { rules: Rule[]; usable: Set<string>; unrouted: string; fallback: string | null };

export class DiscordPlanner {
  private readonly plans = new Map<string, WorkspacePlan | null>();
  private readonly unrouted = new Map<string, { workspaceId: string; eventType: string; count: number; lastEventId: string }>();
  readonly deliveries: { workspaceId: string; deliveryId: string }[] = [];

  // The dispatcher runs across workspaces in an unscoped transaction; every query here names its workspace.
  constructor(private readonly tx: Prisma.TransactionClient) {}

  /** The workspace's rules and usable channels, read once per batch; null when it has no Discord set up. */
  private async plan(workspaceId: string): Promise<WorkspacePlan | null> {
    if (this.plans.has(workspaceId)) return this.plans.get(workspaceId)!;
    const usable = await this.tx.discordDestination.findMany({
      where: { workspaceId, status: { not: "missing" }, connection: { status: "connected" } },
      select: { id: true },
    });
    let plan: WorkspacePlan | null = null;
    if (usable.length) {
      const [rules, settings] = await Promise.all([
        this.tx.discordRule.findMany({ where: { workspaceId, enabled: true }, select: { id: true, events: true, destinationIds: true } }),
        this.tx.discordSettings.findUnique({ where: { workspaceId } }),
      ]);
      plan = { rules, usable: new Set(usable.map((d) => d.id)), unrouted: settings?.unrouted ?? "ignore", fallback: settings?.fallbackDestinationId ?? null };
    }
    this.plans.set(workspaceId, plan);
    return plan;
  }

  async add(e: Event) {
    const plan = await this.plan(e.workspaceId);
    if (!plan) return;
    const matching = plan.rules.filter((r) => r.events.includes(e.type));
    const rows: { workspaceId: string; ruleId: string | null; destinationId: string; eventId: string; eventType: string }[] = [];
    for (const r of matching) {
      for (const destinationId of r.destinationIds) {
        if (plan.usable.has(destinationId)) rows.push({ workspaceId: e.workspaceId, ruleId: r.id, destinationId, eventId: e.id, eventType: e.type });
      }
    }
    if (!matching.length && plan.unrouted !== "ignore") {
      const key = `${e.workspaceId}|${e.type}`;
      const u = this.unrouted.get(key) ?? { workspaceId: e.workspaceId, eventType: e.type, count: 0, lastEventId: e.id };
      u.count++;
      u.lastEventId = e.id;
      this.unrouted.set(key, u);
      if (plan.unrouted === "fallback" && plan.fallback && plan.usable.has(plan.fallback)) {
        rows.push({ workspaceId: e.workspaceId, ruleId: null, destinationId: plan.fallback, eventId: e.id, eventType: e.type });
      }
    }
    if (!rows.length) return;
    const created = await this.tx.discordDelivery.createManyAndReturn({ data: rows.map((r) => ({ ...r, status: "pending" })), skipDuplicates: true, select: { id: true, workspaceId: true } });
    for (const c of created) this.deliveries.push({ workspaceId: c.workspaceId, deliveryId: c.id });
  }

  /** Writes the batch's unrouted counts (one upsert per workspace and type). */
  async flush() {
    const now = new Date();
    for (const u of this.unrouted.values()) {
      await this.tx.discordUnroutedEvent.upsert({
        where: { workspaceId_eventType: { workspaceId: u.workspaceId, eventType: u.eventType } },
        create: { workspaceId: u.workspaceId, eventType: u.eventType, count: u.count, lastEventId: u.lastEventId, lastAt: now },
        update: { count: { increment: u.count }, lastEventId: u.lastEventId, lastAt: now },
      });
    }
  }
}
