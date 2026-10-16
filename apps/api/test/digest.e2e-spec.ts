import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { DIGEST_CLOCK, DigestService, type DigestClock } from "../src/digest/digest.service.js";
import { digestPeriod, isDue, readDigestSettings, renderDigest } from "../src/digest/digest.policy.js";

/*
 * The CEO's digest: the numbers in the preview, the settings endpoints, and
 * the sweep (DigestService.runDue, what the `digest` queue's 15-minute job
 * runs) — who it goes to, once per period, weekly only on Mondays. The
 * workspace is in Asia/Dhaka (UTC+6, no DST); the clock is injected.
 */

const H = 3_600_000;
const DAY = 24 * H;

/** 03:00 UTC (09:00 in Dhaka) on the first `weekday` (0 = Sunday) at least `minDays` after today, so rows the API writes "now" fall outside the period. */
function upcoming(weekday: number, minDays = 3): Date {
  const d = new Date(Date.now() + minDays * DAY);
  d.setUTCHours(3, 0, 0, 0);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

describe("Digest", () => {
  let t: TestApp;
  let owner: Agent;
  let admin: Agent;
  let manager: Agent;
  let member: Agent;
  let paused: Agent;
  let w: string;
  let clock: DigestClock;
  let digest: DigestService;
  /** A Thursday, 09:00 local. "Yesterday" is the Wednesday. */
  let now: Date;
  let yesterday: (hours: number) => Date;

  beforeAll(async () => {
    t = await bootApp();
    clock = t.app.get(DIGEST_CLOCK);
    digest = t.app.get(DigestService);
    owner = await signUp(t, "digest-owner@acme.test", "Olive Owner");
    w = await createWorkspace(owner, "Digest Co");
    await setPlan(t, w, "growth");
    admin = await addMember(t, owner, w, "digest-admin@acme.test", "admin");
    manager = await addMember(t, owner, w, "digest-manager@acme.test", "manager");
    member = await addMember(t, owner, w, "digest-member@acme.test", "member");
    paused = await addMember(t, owner, w, "digest-paused@acme.test", "manager");
    await t.prisma.db.membership.updateMany({ where: { workspaceId: w, userId: paused.userId }, data: { deactivatedAt: new Date() } });
    await t.prisma.db.workspace.update({ where: { id: w }, data: { timezone: "Asia/Dhaka", currency: "USD" } });

    now = upcoming(4);
    clock.now = () => now;
    // Yesterday in Dhaka began at 18:00 UTC two days before `now`'s date.
    const startOfYesterday = new Date(now.getTime() - 3 * H - 6 * H - DAY);
    yesterday = (hours: number) => new Date(startOfYesterday.getTime() + hours * H);

    const db = t.prisma.db;
    const p = (await owner.get(`/v1/workspaces/${w}/pipelines`).expect(200)).body.data[0];
    const stage = (kind: string) => p.stages.find((s: { kind: string }) => s.kind === kind).id as string;

    // Leads: three yesterday (two still unowned), one stale, one old but recently touched.
    const lead = (o: { name: string; source?: string; ownerId?: string | null; createdAt: Date; stage?: "lead" | "sales" | "contact" }) =>
      db.contact.create({ data: { workspaceId: w, fullName: o.name, leadSource: o.source ?? "", ownerId: o.ownerId ?? null, createdAt: o.createdAt, lifecycleStage: o.stage ?? "lead" } });
    await lead({ name: "Ada", source: "Website", ownerId: owner.userId, createdAt: yesterday(2) });
    await lead({ name: "Ben", source: "Website", createdAt: yesterday(5) });
    await lead({ name: "Cy", source: "Referral", createdAt: yesterday(10) });
    await lead({ name: "Old Stale", createdAt: new Date(now.getTime() - 30 * DAY), stage: "sales" });
    const touched = await lead({ name: "Old Touched", createdAt: new Date(now.getTime() - 30 * DAY) });
    await lead({ name: "Customer", createdAt: new Date(now.getTime() - 30 * DAY), stage: "contact" });

    // Activity yesterday, by every kind of actor; one entry three days back (outside the day).
    const act = (o: { actorType: string; actorId?: string | null; onBehalfOfId?: string | null; at: Date; contactId?: string }) =>
      db.activity.create({ data: { workspaceId: w, type: "note.added", summary: "Did a thing", actorType: o.actorType, actorId: o.actorId ?? null, onBehalfOfId: o.onBehalfOfId ?? null, occurredAt: o.at, contactId: o.contactId ?? null } });
    for (const h of [1, 2, 3, 3.5]) await act({ actorType: "user", actorId: owner.userId, at: yesterday(h) });
    await act({ actorType: "user", actorId: manager.userId, at: yesterday(4) });
    for (const h of [5, 6]) await act({ actorType: "ai_agent", actorId: "00000000-0000-7000-8000-000000000001", onBehalfOfId: manager.userId, at: yesterday(h) });
    await act({ actorType: "workflow", actorId: "00000000-0000-7000-8000-000000000002", at: yesterday(7) });
    await act({ actorType: "integration", actorId: "00000000-0000-7000-8000-000000000003", at: yesterday(8) });
    await act({ actorType: "system", at: yesterday(9) });
    await act({ actorType: "user", actorId: member.userId, at: new Date(now.getTime() - 3 * DAY), contactId: touched.id });

    // Deals: won (USD and EUR) and lost yesterday, one new yesterday with a next step, one open without.
    const deal = (o: { name: string; status: "open" | "won" | "lost"; value?: number; currency?: string; createdAt: Date; closedAt?: Date }) =>
      db.deal.create({
        data: { workspaceId: w, pipelineId: p.id, stageId: stage(o.status), name: o.name, status: o.status, value: o.value ?? 0, currency: o.currency ?? "USD", createdAt: o.createdAt, closedAt: o.closedAt ?? null },
      });
    await deal({ name: "Big win", status: "won", value: 5000, createdAt: new Date(now.getTime() - 10 * DAY), closedAt: yesterday(12) });
    await deal({ name: "Euro win", status: "won", value: 100, currency: "EUR", createdAt: new Date(now.getTime() - 10 * DAY), closedAt: yesterday(13) });
    await deal({ name: "Lost one", status: "lost", createdAt: new Date(now.getTime() - 10 * DAY), closedAt: yesterday(14) });
    const planned = await deal({ name: "Fresh", status: "open", createdAt: yesterday(15) });
    await deal({ name: "Drifting", status: "open", createdAt: new Date(now.getTime() - 5 * DAY) });

    // Tasks: six overdue (member 3, owner 2, manager 1), one done, one upcoming (the fresh deal's next step).
    const task = (assigneeId: string, dueAt: Date, status: "open" | "done" = "open", dealId?: string) =>
      db.task.create({ data: { workspaceId: w, title: "Follow up", assigneeId, dueAt, status, dealId: dealId ?? null } });
    for (let i = 0; i < 3; i++) await task(member.userId, new Date(now.getTime() - (i + 1) * DAY));
    for (let i = 0; i < 2; i++) await task(owner.userId, new Date(now.getTime() - (i + 1) * H));
    await task(manager.userId, new Date(now.getTime() - 2 * DAY));
    await task(owner.userId, new Date(now.getTime() - 2 * DAY), "done");
    await task(owner.userId, new Date(now.getTime() + 2 * DAY), "open", planned.id);

    // Conversations: one waiting 30 hours; recent, read and closed ones do not count.
    const convo = (key: string, o: { unread: boolean; inboundHoursAgo: number; status?: "open" | "closed" }) =>
      db.conversation.create({
        data: { workspaceId: w, channel: "email", externalKey: `digest:${key}`, unread: o.unread, status: o.status ?? "open", lastInboundAt: new Date(now.getTime() - o.inboundHoursAgo * H), lastMessageAt: new Date(now.getTime() - o.inboundHoursAgo * H) },
      });
    await convo("waiting", { unread: true, inboundHoursAgo: 30 });
    await convo("recent", { unread: true, inboundHoursAgo: 2 });
    await convo("read", { unread: false, inboundHoursAgo: 30 });
    await convo("closed", { unread: true, inboundHoursAgo: 30, status: "closed" });
  });
  afterAll(async () => t.close());

  it("previews yesterday's numbers in the workspace's time zone", async () => {
    const res = await owner.get(`/v1/workspaces/${w}/digest/preview?frequency=daily`).expect(200);
    const { data, title, body } = res.body.data;
    expect(data.period.from).toBe(digestPeriod("daily", now, "Asia/Dhaka").from);
    expect(data.empty).toBe(false);
    expect(data.leads).toEqual({ created: 3, topSources: [{ source: "Website", count: 2 }, { source: "Referral", count: 1 }], unownedNow: 2 });
    expect(data.deals).toEqual({ won: 2, wonValue: 5000, wonOtherCurrency: 1, lost: 1, created: 1 });
    expect(data.activity.total).toBe(10);
    expect(data.activity.byActorType).toEqual({ user: 5, ai_agent: 2, workflow: 1, integration: 1, system: 1 });
    expect(data.activity.aiActions).toBe(2);
    expect(data.activity.topPeople.map((p: { userId: string; own: number; byAi: number }) => [p.userId, p.own, p.byAi])).toEqual([
      [owner.userId, 4, 0],
      [manager.userId, 1, 2],
    ]);
    expect(data.attention.overdueTasks.total).toBe(6);
    expect(data.attention.overdueTasks.top.map((p: { userId: string; count: number }) => [p.userId, p.count])).toEqual([
      [member.userId, 3],
      [owner.userId, 2],
      [manager.userId, 1],
    ]);
    expect(data.attention.waitingConversations).toBe(1);
    expect(data.attention.staleLeads).toBe(1);
    expect(data.attention.dealsWithoutNextStep).toBe(1);
    expect(title).toContain("Daily digest for Digest Co");
    expect(body).toContain("3 new leads — top sources: Website (2), Referral (1)");
    expect(body).toContain("$5,000");
    expect(body).toContain(`/w/${w}/leads?owner=none`);
    expect(body).toContain(`/w/${w}/tasks?view=overdue`);
    expect(body).toContain(`/w/${w}/inbox?unread=1`);
    expect(body).toContain(`/w/${w}/activity`);

    // The week: also the entry three days back.
    const week = (await manager.get(`/v1/workspaces/${w}/digest/preview?frequency=weekly`).expect(200)).body.data;
    expect(week.data.activity.total).toBe(11);
    expect(week.title).toContain("Weekly digest");
  });

  it("guards preview and settings by permission and validates the settings", async () => {
    await member.get(`/v1/workspaces/${w}/digest/preview`).expect(403);
    await member.get(`/v1/workspaces/${w}/digest/settings`).expect(403);
    const s = (await manager.get(`/v1/workspaces/${w}/digest/settings`).expect(200)).body.data;
    expect(s).toMatchObject({ enabled: true, frequency: "daily", hour: 8, lastSentAt: null, timezone: "Asia/Dhaka" });
    await manager.put(`/v1/workspaces/${w}/digest/settings`).send({ hour: 9 }).expect(403);
    await admin.put(`/v1/workspaces/${w}/digest/settings`).send({ hour: 24 }).expect(400);
    await admin.put(`/v1/workspaces/${w}/digest/settings`).send({ frequency: "monthly" }).expect(400);
    await admin.put(`/v1/workspaces/${w}/digest/settings`).send({}).expect(400);
    // Other settings survive a digest change.
    await t.prisma.db.workspace.update({ where: { id: w }, data: { settings: { notifications: { email: true } } } });
    const saved = (await admin.put(`/v1/workspaces/${w}/digest/settings`).send({ hour: 10 }).expect(200)).body.data;
    expect(saved).toMatchObject({ enabled: true, frequency: "daily", hour: 10 });
    const row = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w }, select: { settings: true } });
    expect(row.settings).toEqual({ notifications: { email: true }, digest: { hour: 10 } });
    await admin.put(`/v1/workspaces/${w}/digest/settings`).send({ hour: 8 }).expect(200);
  });

  it("sends once to owners, admins and managers when the local hour comes, and records lastSentAt", async () => {
    const before = new Date(now.getTime() - 2 * H); // 07:00 local: not yet
    expect((await digest.runDue(before)).sent).toBe(0);

    const outboxStart = t.mail.outbox.length;
    const first = await digest.runDue(now);
    expect(first.sent).toBe(1);
    const sent = t.mail.outbox.slice(outboxStart).filter((m) => m.template === "notification");
    expect(sent.map((m) => m.to).sort()).toEqual(["digest-admin@acme.test", "digest-manager@acme.test", "digest-owner@acme.test"]);
    expect(sent[0]!.subject).toContain("Daily digest for Digest Co");
    expect(sent[0]!.text).toContain("Needs attention");

    const bells = await t.prisma.db.notification.findMany({ where: { workspaceId: w, type: "digest" } });
    expect(bells.map((b) => b.userId).sort()).toEqual([owner.userId, admin.userId, manager.userId].sort());
    expect(bells[0]!.link).toBe(`/w/${w}/activity`);
    expect(bells.some((b) => b.userId === member.userId || b.userId === paused.userId)).toBe(false);

    const row = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w }, select: { settings: true } });
    expect(readDigestSettings(row.settings).lastSentAt).toBe(now.toISOString());
    expect((row.settings as { notifications?: unknown }).notifications).toEqual({ email: true });

    // Later the same day, or two workers at once: nothing more.
    const again = await Promise.all([digest.runDue(new Date(now.getTime() + 15 * 60_000)), digest.runDue(new Date(now.getTime() + 15 * 60_000))]);
    expect(again.reduce((a, r) => a + r.sent, 0)).toBe(0);
    expect(t.mail.outbox.length - outboxStart).toBe(3);
    expect(await t.prisma.db.notification.count({ where: { workspaceId: w, type: "digest" } })).toBe(3);
  });

  it("does not let two racing claims both win the same period", async () => {
    const row = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w }, select: { settings: true } });
    const prev = readDigestSettings(row.settings).lastSentAt;
    const at = new Date(now.getTime() + DAY);
    const wins = await Promise.all([digest.claim(w, prev, at), digest.claim(w, prev, at), digest.claim(w, prev, at)]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("sends weekly digests only on Mondays", async () => {
    await admin.put(`/v1/workspaces/${w}/digest/settings`).send({ frequency: "weekly" }).expect(200);
    const tuesday = upcoming(2, 10);
    const monday = upcoming(1, 10);
    expect((await digest.runDue(tuesday)).sent).toBe(0);
    const s = readDigestSettings((await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } })).settings);
    expect(isDue(s, tuesday, "Asia/Dhaka")).toBe(false);
    expect(isDue(s, monday, "Asia/Dhaka")).toBe(true);
    const r = await digest.runDue(monday);
    expect(r.sent + r.empty).toBe(1);
    expect(readDigestSettings((await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } })).settings).lastSentAt).toBe(monday.toISOString());
    expect((await digest.runDue(new Date(monday.getTime() + H))).sent).toBe(0);
  });

  it("sends nothing when off, when suspended, or when there is nothing to report", async () => {
    const quiet = await signUp(t, "digest-quiet@else.test", "Quinn Quiet");
    const q = await createWorkspace(quiet, "Quiet Ltd");
    const later = upcoming(3, 20);
    const startBells = await t.prisma.db.notification.count({ where: { workspaceId: q, type: "digest" } });
    await digest.runDue(later);
    expect(await t.prisma.db.notification.count({ where: { workspaceId: q, type: "digest" } })).toBe(startBells);

    // Suspended: not even considered.
    await admin.put(`/v1/workspaces/${w}/digest/settings`).send({ frequency: "daily" }).expect(200);
    await t.prisma.db.workspace.update({ where: { id: w }, data: { status: "suspended" } });
    const bells = await t.prisma.db.notification.count({ where: { workspaceId: w, type: "digest" } });
    await digest.runDue(upcoming(5, 25));
    expect(await t.prisma.db.notification.count({ where: { workspaceId: w, type: "digest" } })).toBe(bells);
    await t.prisma.db.workspace.update({ where: { id: w }, data: { status: "active" } });

    // Off.
    await owner.put(`/v1/workspaces/${w}/digest/settings`).send({ enabled: false }).expect(200);
    await digest.runDue(upcoming(5, 32));
    expect(await t.prisma.db.notification.count({ where: { workspaceId: w, type: "digest" } })).toBe(bells);
    await owner.put(`/v1/workspaces/${w}/digest/settings`).send({ enabled: true }).expect(200);
  });

  it("renders a plain-text body with one link per line", () => {
    const period = digestPeriod("daily", now, "Asia/Dhaka");
    const r = renderDigest(
      {
        workspace: { id: "w1", name: "Acme", timezone: "Asia/Dhaka", currency: "USD" },
        period: { ...period, start: period.start.toISOString(), end: period.end.toISOString() },
        leads: { created: 1, topSources: [], unownedNow: 1 },
        deals: { won: 0, wonValue: 0, wonOtherCurrency: 0, lost: 0, created: 0 },
        activity: { total: 0, byActorType: { user: 0, ai_agent: 0, workflow: 0, integration: 0, system: 0 }, topPeople: [], aiActions: 0 },
        attention: { overdueTasks: { total: 0, top: [] }, waitingConversations: 0, staleLeads: 0, dealsWithoutNextStep: 0 },
        links: { activity: "/a", leads: "/l", unownedLeads: "/u", deals: "/d", openDeals: "/o", tasks: "/t", inbox: "/i" },
        empty: false,
      },
      (p) => `https://app.test${p}`,
    );
    expect(r.body).toBe(`Here is what happened in Acme on ${period.label}.\n\n**New leads**\n• 1 new lead: https://app.test/l\n• 1 of them still has no owner: https://app.test/u`);
    expect(r.inApp).not.toContain("https://");
  });
});
