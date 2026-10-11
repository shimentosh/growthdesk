import { DEFAULT_ROLE_PERMISSIONS } from "@growthdesk/shared";
import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Reports against hand-seeded rows with fixed timestamps. The workspace runs
 * on Asia/Dhaka (UTC+6, no DST), so a few rows sit on a different calendar day
 * in UTC than locally — they prove the range and the buckets follow the
 * workspace's zone. Range under test: 2026-09-01 … 2026-09-30 (local).
 */

const at = (iso: string) => new Date(iso);
const RANGE = "from=2026-09-01&to=2026-09-30";

describe("Analytics", () => {
  let t: TestApp;
  let owner: Agent;
  let member: Agent;
  let w: string;
  let other: Agent;
  let w2: string;
  let pipelineId: string;

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "analytics-owner@acme.test", "Olive Owner");
    w = await createWorkspace(owner, "Reports Co");
    await setPlan(t, w, "growth");
    member = await addMember(t, owner, w, "analytics-member@acme.test", "member");
    await t.prisma.db.workspace.update({ where: { id: w }, data: { timezone: "Asia/Dhaka", currency: "USD" } });
    await seedWorkspace(w);

    other = await signUp(t, "analytics-other@else.test", "Oscar Other");
    w2 = await createWorkspace(other, "Elsewhere Ltd");
    await setPlan(t, w2, "starter");
    await seedOther(w2);
  });
  afterAll(async () => t.close());

  async function seedWorkspace(workspaceId: string) {
    const db = t.prisma.db;
    const [c1, c2, c3] = await Promise.all(
      ["one", "two", "three"].map((n) => db.contact.create({ data: { workspaceId, fullName: `Contact ${n}`, email: `${n}@lead.test` } })),
    );
    await db.contact.update({ where: { id: c3!.id, workspaceId }, data: { unsubscribedAt: at("2026-09-10T00:00:00Z") } });

    const seq = await db.sequence.create({ data: { workspaceId, name: "K", kind: "campaign" } });
    await db.sequenceStep.createMany({
      data: [0, 1].map((position) => ({ workspaceId, sequenceId: seq.id, position, type: "email" as const, config: {} })),
    });
    const campaign = await db.campaign.create({
      data: { workspaceId, name: "Autumn push", status: "running", sequenceId: seq.id, ownerId: owner.userId, settings: { trackOpens: true, trackClicks: true } },
    });

    // One campaign conversation per contact, unassigned.
    const thread = async (contactId: string, key: string, assigneeId: string | null = null, campaignId: string | null = campaign.id) =>
      db.conversation.create({ data: { workspaceId, channel: "email", contactId, externalKey: key, campaignId, assigneeId } });
    const enroll = (contactId: string, repliedAt: Date | null = null) =>
      db.enrollment.create({ data: { workspaceId, campaignId: campaign.id, contactId, status: "active", repliedAt } });
    let run = 0;
    const send = async (o: {
      conversationId: string;
      enrollmentId?: string;
      position?: number;
      sentAt: string;
      status?: "sent" | "bounced";
      openedAt?: string;
      authorId?: string;
      campaign?: boolean;
    }) => {
      const m = await db.message.create({
        data: {
          workspaceId,
          conversationId: o.conversationId,
          channel: "email",
          direction: "outbound",
          status: o.status ?? "sent",
          campaignId: o.campaign === false ? null : campaign.id,
          enrollmentId: o.enrollmentId ?? null,
          authorId: o.authorId ?? null,
          sentAt: at(o.sentAt),
          createdAt: at(o.sentAt),
          bouncedAt: o.status === "bounced" ? at(o.sentAt) : null,
          openedAt: o.openedAt ? at(o.openedAt) : null,
        },
      });
      if (o.enrollmentId !== undefined && o.position !== undefined) {
        await db.stepExecution.create({
          data: { workspaceId, enrollmentId: o.enrollmentId, campaignId: campaign.id, position: o.position, stepType: "email", stepRun: ++run, status: "succeeded", messageId: m.id },
        });
      }
      return m;
    };
    const receive = (conversationId: string, createdAt: string, isAutoReply = false) =>
      db.message.create({ data: { workspaceId, conversationId, channel: "email", direction: "inbound", status: "received", isAutoReply, createdAt: at(createdAt), receivedAt: at(createdAt) } });

    // c1: two steps, then a human reply after step 2 (credited to position 1).
    const v1 = await thread(c1!.id, "k:1");
    const e1 = await enroll(c1!.id, at("2026-09-06T01:00:00Z"));
    await send({ conversationId: v1.id, enrollmentId: e1.id, position: 0, sentAt: "2026-09-02T04:00:00Z", openedAt: "2026-09-02T05:00:00Z" });
    await send({ conversationId: v1.id, enrollmentId: e1.id, position: 1, sentAt: "2026-09-05T03:00:00Z" });
    await receive(v1.id, "2026-09-06T01:00:00Z");
    // c2: 20:00Z on Sep 2 is 02:00 on Sep 3 in Dhaka. Bounced.
    const v2 = await thread(c2!.id, "k:2");
    const e2 = await enroll(c2!.id);
    await send({ conversationId: v2.id, enrollmentId: e2.id, position: 0, sentAt: "2026-09-02T20:00:00Z", status: "bounced" });
    // c3: 19:00Z on Aug 31 is 01:00 on Sep 1 in Dhaka (inside the range). Only an auto-reply came back.
    const v3 = await thread(c3!.id, "k:3");
    const e3 = await enroll(c3!.id);
    await send({ conversationId: v3.id, enrollmentId: e3.id, position: 0, sentAt: "2026-08-31T19:00:00Z" });
    await receive(v3.id, "2026-09-01T02:00:00Z", true);
    // Outside the range: Oct 1 06:00 local.
    await send({ conversationId: v3.id, enrollmentId: e3.id, position: 1, sentAt: "2026-10-01T00:00:00Z" });

    // A one-off email by the owner, in a conversation assigned to the owner, and its reply.
    const v4 = await thread(c1!.id, "manual:1", owner.userId, null);
    await send({ conversationId: v4.id, sentAt: "2026-09-10T10:00:00Z", authorId: owner.userId, campaign: false });
    await receive(v4.id, "2026-09-11T10:00:00Z");
    // A cold inbound message (we never wrote first) is not a reply.
    const v5 = await thread(c2!.id, "cold:1", null, null);
    await receive(v5.id, "2026-09-12T10:00:00Z");

    // Pipeline: the default pipeline's stages by position (0 New Lead … 8 Won, 9 Lost).
    const pipeline = await db.pipeline.findFirstOrThrow({ where: { workspaceId, isDefault: true }, include: { stages: { orderBy: { position: "asc" } } } });
    pipelineId = pipeline.id;
    const st = pipeline.stages;
    const won = st.find((s) => s.kind === "won")!;
    const lost = st.find((s) => s.kind === "lost")!;
    const deal = async (o: { name: string; created: string; path: string[]; status: "open" | "won" | "lost"; value: number; currency?: string; closed?: string; ownerId?: string }) => {
      const last = o.path.at(-1)!;
      const d = await db.deal.create({
        data: {
          workspaceId,
          pipelineId,
          stageId: last,
          name: o.name,
          ownerId: o.ownerId ?? owner.userId,
          value: o.value,
          currency: o.currency ?? "USD",
          status: o.status,
          createdAt: at(o.created),
          closedAt: o.closed ? at(o.closed) : null,
          sourceCampaignId: o.name === "D1" ? campaign.id : null,
        },
      });
      await db.dealStageChange.createMany({
        data: o.path.map((toStageId, i) => ({ workspaceId, dealId: d.id, fromStageId: i ? o.path[i - 1]! : null, toStageId, changedAt: at(o.created) })),
      });
    };
    await deal({ name: "D1", created: "2026-09-03T06:00:00Z", path: [st[0]!.id, st[1]!.id, won.id], status: "won", value: 1000, closed: "2026-09-13T06:00:00Z" });
    await deal({ name: "D2", created: "2026-09-04T06:00:00Z", path: [st[0]!.id, lost.id], status: "lost", value: 300, closed: "2026-09-08T06:00:00Z" });
    await deal({ name: "D3", created: "2026-09-05T06:00:00Z", path: [st[0]!.id], status: "open", value: 50, ownerId: member.userId });
    await deal({ name: "D4", created: "2026-09-01T06:00:00Z", path: [st[0]!.id, won.id], status: "won", value: 500, currency: "EUR", closed: "2026-09-03T06:00:00Z" });
    await deal({ name: "D5", created: "2026-08-01T06:00:00Z", path: [st[0]!.id, won.id], status: "won", value: 200, closed: "2026-09-20T06:00:00Z" });

    // Activity.
    await db.task.createMany({
      data: [
        { workspaceId, title: "Owner task", status: "done", assigneeId: owner.userId, completedById: owner.userId, completedAt: at("2026-09-07T06:00:00Z") },
        { workspaceId, title: "Member task", status: "done", assigneeId: member.userId, completedById: member.userId, completedAt: at("2026-09-07T07:00:00Z") },
        { workspaceId, title: "Later task", status: "done", assigneeId: owner.userId, completedById: owner.userId, completedAt: at("2026-10-02T06:00:00Z") },
        { workspaceId, title: "Open task", status: "open", assigneeId: owner.userId },
      ],
    });
    await db.meeting.createMany({
      data: [
        { workspaceId, title: "Intro", ownerId: owner.userId, startsAt: at("2026-10-05T06:00:00Z"), createdAt: at("2026-09-08T06:00:00Z") },
        { workspaceId, title: "Canceled", ownerId: owner.userId, status: "canceled", startsAt: at("2026-09-20T06:00:00Z"), createdAt: at("2026-09-09T06:00:00Z") },
        { workspaceId, title: "Held", ownerId: owner.userId, status: "completed", startsAt: at("2026-09-15T06:00:00Z"), createdAt: at("2026-08-20T06:00:00Z") },
      ],
    });
    await db.call.createMany({
      data: [
        { workspaceId, userId: member.userId, status: "completed", createdAt: at("2026-09-09T06:00:00Z") },
        { workspaceId, userId: owner.userId, status: "no_answer", createdAt: at("2026-09-09T07:00:00Z") },
      ],
    });
  }

  async function seedOther(workspaceId: string) {
    const db = t.prisma.db;
    const c = await db.contact.create({ data: { workspaceId, fullName: "Elsewhere lead", email: "x@else.test" } });
    const v = await db.conversation.create({ data: { workspaceId, channel: "email", contactId: c.id, externalKey: "else:1" } });
    await db.message.create({
      data: { workspaceId, conversationId: v.id, channel: "email", direction: "outbound", status: "sent", sentAt: at("2026-09-02T06:00:00Z"), createdAt: at("2026-09-02T06:00:00Z") },
    });
    await db.deal.create({
      data: {
        workspaceId,
        pipelineId: (await db.pipeline.findFirstOrThrow({ where: { workspaceId } })).id,
        stageId: (await db.pipelineStage.findFirstOrThrow({ where: { workspaceId, kind: "won" } })).id,
        name: "Elsewhere win",
        value: 9999,
        status: "won",
        createdAt: at("2026-09-02T06:00:00Z"),
        closedAt: at("2026-09-03T06:00:00Z"),
      },
    });
  }

  it("reports outreach, pipeline and activity for the range in the workspace's zone", async () => {
    const res = await owner.get(`/v1/workspaces/${w}/analytics/overview?${RANGE}`).expect(200);
    const d = res.body.data;
    expect(d.range).toMatchObject({ from: "2026-09-01", to: "2026-09-30", days: 30, timeZone: "Asia/Dhaka", currency: "USD", scope: "all" });
    expect(d.outreach).toEqual({
      sent: 5,
      byChannel: { email: 5 },
      delivered: 0,
      bounced: 1,
      bounceRate: 0.2,
      opened: 1,
      openRate: 0.2,
      clicked: 0,
      clickRate: 0,
      contacted: 4,
      replied: 2,
      replyRate: 0.5,
      replies: 2,
      unsubscribes: 1,
    });
    expect(d.pipeline).toEqual({
      created: 4,
      won: 3,
      lost: 1,
      winRate: 0.75,
      valueWon: 1200,
      otherCurrencies: [{ currency: "EUR", value: 500, deals: 1 }],
      avgDaysToClose: 20.7,
    });
    expect(d.activity).toEqual({ tasksCompleted: 2, meetingsBooked: 1, meetingsHeld: 1, callsLogged: 2, callsConnected: 1 });

    // Daily buckets follow Dhaka days, every day is present, and they add up to the totals.
    expect(d.series).toHaveLength(30);
    const day = (date: string) => d.series.find((p: { date: string }) => p.date === date);
    expect(day("2026-09-01")).toMatchObject({ sent: 1, dealsCreated: 1 });
    expect(day("2026-09-02")).toMatchObject({ sent: 1 });
    expect(day("2026-09-03")).toMatchObject({ sent: 1, bounced: 1, dealsCreated: 1, dealsWon: 1, valueWon: 0 });
    expect(day("2026-09-06")).toMatchObject({ replies: 1 });
    expect(day("2026-09-13")).toMatchObject({ dealsWon: 1, valueWon: 1000 });
    const sum = (k: string) => d.series.reduce((a: number, p: Record<string, number>) => a + p[k]!, 0);
    expect(sum("sent")).toBe(5);
    expect(sum("replies")).toBe(2);
    expect(sum("dealsWon")).toBe(3);
    expect(sum("valueWon")).toBe(1200);
    expect(sum("tasksCompleted")).toBe(2);
  });

  it("a UTC reading of the same days would differ — the range is local", async () => {
    // Sep 1 alone: in Dhaka it holds the 19:00Z Aug 31 send.
    const res = await owner.get(`/v1/workspaces/${w}/analytics/overview?from=2026-09-01&to=2026-09-01`).expect(200);
    expect(res.body.data.outreach.sent).toBe(1);
    expect(res.body.data.series).toEqual([expect.objectContaining({ date: "2026-09-01", sent: 1 })]);
  });

  it("compares campaigns and credits replies to the step that drew them", async () => {
    const res = await owner.get(`/v1/workspaces/${w}/analytics/campaigns?${RANGE}`).expect(200);
    const d = res.body.data;
    expect(d.campaigns).toHaveLength(1);
    expect(d.campaigns[0]).toMatchObject({
      name: "Autumn push",
      deleted: false,
      sent: 4,
      contacted: 3,
      replied: 1,
      replyRate: 0.3333,
      bounced: 1,
      opened: 1,
      clicked: 0,
      unsubscribed: 1,
      deals: 1,
    });
    expect(d.steps).toEqual([
      { position: 0, sent: 3, replied: 0, bounced: 1, opened: 1, clicked: 0, replyRate: 0, bounceRate: 0.3333 },
      { position: 1, sent: 1, replied: 1, bounced: 0, opened: 0, clicked: 0, replyRate: 1, bounceRate: 0 },
    ]);
  });

  it("builds the stage funnel for deals created in the range", async () => {
    const res = await owner.get(`/v1/workspaces/${w}/analytics/pipeline?${RANGE}`).expect(200);
    const d = res.body.data;
    expect(d.pipelineId).toBe(pipelineId);
    expect(d).toMatchObject({ cohort: 4, open: 1, won: 2, lost: 1 });
    // Lost is beside the funnel, not a step of it.
    expect(d.stages).toHaveLength(9);
    expect(d.stages[0]).toMatchObject({ name: "New Lead", reached: 4, conversion: null });
    expect(d.stages[1]).toMatchObject({ name: "Ready to Contact", reached: 2, conversion: 0.5 });
    expect(d.stages[8]).toMatchObject({ name: "Won", kind: "won", reached: 2, conversion: 1 });
    await owner.get(`/v1/workspaces/${w}/analytics/pipeline?${RANGE}&pipelineId=00000000-0000-4000-8000-000000000000`).expect(404);
  });

  it("ranks the team (analytics.team + advanced reporting)", async () => {
    const res = await owner.get(`/v1/workspaces/${w}/analytics/team?${RANGE}`).expect(200);
    const rows = res.body.data.members as { userId: string }[];
    const o = rows.find((r) => r.userId === owner.userId);
    const m = rows.find((r) => r.userId === member.userId);
    expect(o).toMatchObject({ sent: 5, replies: 2, meetingsBooked: 1, callsLogged: 1, callsConnected: 0, tasksCompleted: 1, dealsCreated: 3, dealsWon: 3, valueWon: 1200 });
    expect(m).toMatchObject({ sent: 0, replies: 0, callsLogged: 1, callsConnected: 1, tasksCompleted: 1, dealsCreated: 1, dealsWon: 0, valueWon: 0 });
    expect(rows[0]!.userId).toBe(owner.userId);

    // A member's role does not include team performance.
    await member.get(`/v1/workspaces/${w}/analytics/team?${RANGE}`).expect(403);
  });

  it("limits figures to a person's own records without records.view_all", async () => {
    const restricted = DEFAULT_ROLE_PERMISSIONS.member.filter((p) => p !== "records.view_all");
    await t.prisma.db.workspace.update({ where: { id: w }, data: { rolePermissions: { member: restricted } } });
    try {
      const res = await member.get(`/v1/workspaces/${w}/analytics/overview?${RANGE}`).expect(200);
      const d = res.body.data;
      expect(d.range.scope).toBe("own");
      // The owner's assigned conversation (one send, one reply) drops out; unassigned campaign threads stay.
      expect(d.outreach).toMatchObject({ sent: 4, replies: 1, contacted: 3, replied: 1 });
      // Only the member's own deal; every other deal is the owner's.
      expect(d.pipeline).toMatchObject({ created: 1, won: 0, lost: 0, valueWon: 0 });
      expect(d.activity).toMatchObject({ tasksCompleted: 1, callsLogged: 1, meetingsBooked: 0 });
    } finally {
      await t.prisma.db.workspace.update({ where: { id: w }, data: { rolePermissions: {} } });
    }
  });

  it("keeps workspaces apart", async () => {
    const mine = await other.get(`/v1/workspaces/${w2}/analytics/overview?${RANGE}`).expect(200);
    expect(mine.body.data.outreach).toMatchObject({ sent: 1, replies: 0 });
    expect(mine.body.data.pipeline).toMatchObject({ created: 1, won: 1, valueWon: 9999 });
    // Neither side sees the other's rows, and a non-member gets 404 rather than a hint.
    const theirs = await owner.get(`/v1/workspaces/${w}/analytics/overview?${RANGE}`).expect(200);
    expect(theirs.body.data.outreach.sent).toBe(5);
    expect(theirs.body.data.pipeline.valueWon).toBe(1200);
    for (const path of ["overview", "campaigns", "pipeline", "team"]) {
      await owner.get(`/v1/workspaces/${w2}/analytics/${path}?${RANGE}`).expect(404);
      await other.get(`/v1/workspaces/${w}/analytics/${path}?${RANGE}`).expect(404);
    }
  });

  it("refuses team performance on a plan without advanced reporting, and bad ranges", async () => {
    const res = await other.get(`/v1/workspaces/${w2}/analytics/team?${RANGE}`).expect(402);
    expect(res.body.error.details.feature).toBe("advancedReporting");
    await owner.get(`/v1/workspaces/${w}/analytics/overview?from=2026-09-30&to=2026-09-01`).expect(400);
    await owner.get(`/v1/workspaces/${w}/analytics/overview?from=2026-02-30`).expect(400);
    await owner.get(`/v1/workspaces/${w}/analytics/overview?from=2024-01-01&to=2026-01-01`).expect(400);
    // No range: the last 30 days in the workspace's zone.
    const def = await owner.get(`/v1/workspaces/${w}/analytics/overview`).expect(200);
    expect(def.body.data.range.days).toBe(30);
  });
});
