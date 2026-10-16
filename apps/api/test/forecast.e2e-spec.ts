import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { StaleDealsService } from "../src/forecast/stale-deals.service.js";

/*
 * Targets, the forecast and stale deals against hand-seeded deals with fixed
 * timestamps. The workspace runs on Asia/Dhaka (UTC+6), so a deal won at
 * 19:00 UTC on the last day of a month belongs to the next month there — the
 * forecast follows the workspace's zone. Period under test: September 2026.
 */

const at = (iso: string) => new Date(iso);
const SEPT = "periodType=month&periodStart=2026-09-01";
const DAY = 86_400_000;

type Stage = { id: string; name: string; kind: string; probability: number; color: string; rotDays: number | null };

describe("Forecast, targets and stale deals", () => {
  let t: TestApp;
  let owner: Agent;
  let manager: Agent;
  let member: Agent;
  let w: string;
  let other: Agent;
  let w2: string;
  let pipelineId: string;
  let stages: Stage[];
  const stage = (name: string) => stages.find((s) => s.name === name)!;

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "forecast-owner@acme.test", "Olive Owner");
    w = await createWorkspace(owner, "Forecast Co");
    await setPlan(t, w, "growth");
    manager = await addMember(t, owner, w, "forecast-manager@acme.test", "manager");
    member = await addMember(t, owner, w, "forecast-member@acme.test", "member");
    await t.prisma.db.workspace.update({ where: { id: w }, data: { timezone: "Asia/Dhaka", currency: "USD" } });
    const p = (await owner.get(`/v1/workspaces/${w}/pipelines`).expect(200)).body.data[0];
    pipelineId = p.id;
    stages = p.stages;

    other = await signUp(t, "forecast-other@else.test", "Oscar Other");
    w2 = await createWorkspace(other, "Elsewhere Ltd");
    await setPlan(t, w2, "growth");
  });
  afterAll(async () => t.close());

  async function seedDeal(workspaceId: string, o: { name: string; ownerId?: string | null; value: number; stage: string; category?: string; close?: string; closedAt?: string; currency?: string; deleted?: boolean; pipeline?: string; stageList?: Stage[] }) {
    const s = (o.stageList ?? stages).find((x) => x.name === o.stage)!;
    const status = s.kind === "open" ? "open" : (s.kind as "won" | "lost");
    return t.prisma.db.deal.create({
      data: {
        workspaceId,
        pipelineId: o.pipeline ?? pipelineId,
        stageId: s.id,
        name: o.name,
        ownerId: o.ownerId === undefined ? owner.userId : o.ownerId,
        value: o.value,
        currency: o.currency ?? "USD",
        status,
        forecastCategory: o.category ?? "pipeline",
        expectedCloseDate: o.close ? at(`${o.close}T00:00:00Z`) : null,
        closedAt: o.closedAt ? at(o.closedAt) : null,
        deletedAt: o.deleted ? new Date() : null,
      },
    });
  }

  describe("targets", () => {
    it("are set by someone with targets.manage, upserted per person, period and metric", async () => {
      await member.put(`/v1/workspaces/${w}/targets`).send({ userId: member.userId, periodType: "month", periodStart: "2026-09-01", target: 1 }).expect(403);
      await member.get(`/v1/workspaces/${w}/targets?${SEPT}`).expect(403);

      const first = (await manager.put(`/v1/workspaces/${w}/targets`).send({ userId: owner.userId, periodType: "month", periodStart: "2026-09-01", target: 8000 }).expect(200)).body.data;
      // Any day in the month names the month; the second write replaces the first.
      const second = (await manager.put(`/v1/workspaces/${w}/targets`).send({ userId: owner.userId, periodType: "month", periodStart: "2026-09-17", target: 10000 }).expect(200)).body.data;
      expect(second.id).toBe(first.id);
      expect(second).toMatchObject({ periodStart: "2026-09-01", metric: "revenue_won", target: 10000, currency: "USD" });

      await manager.put(`/v1/workspaces/${w}/targets`).send({ userId: member.userId, periodType: "month", periodStart: "2026-09-01", target: 2000 }).expect(200);
      await manager.put(`/v1/workspaces/${w}/targets`).send({ userId: owner.userId, periodType: "month", periodStart: "2026-09-01", metric: "deals_won", target: 4 }).expect(200);
      // The team's target (no person): null userIds never collide in a unique index, so the API keeps it single.
      const teamA = (await owner.put(`/v1/workspaces/${w}/targets`).send({ userId: null, periodType: "month", periodStart: "2026-09-01", target: 15000 }).expect(200)).body.data;
      const teamB = (await owner.put(`/v1/workspaces/${w}/targets`).send({ periodType: "month", periodStart: "2026-09-30", target: 20000 }).expect(200)).body.data;
      expect(teamB.id).toBe(teamA.id);

      const list = (await manager.get(`/v1/workspaces/${w}/targets?${SEPT}`).expect(200)).body.data;
      expect(list.period).toMatchObject({ type: "month", from: "2026-09-01", to: "2026-09-30", timeZone: "Asia/Dhaka" });
      expect(list.items).toHaveLength(4);
      expect(list.items.find((x: { userId: string | null }) => x.userId === null).target).toBe(20000);
      expect(list.items.find((x: { userId: string; metric: string }) => x.userId === owner.userId && x.metric === "revenue_won").user.name).toBe("Olive Owner");
    });

    it("refuses another currency for revenue, a fraction for a count, and someone outside the workspace", async () => {
      await manager.put(`/v1/workspaces/${w}/targets`).send({ userId: owner.userId, periodType: "month", periodStart: "2026-09-01", target: 5, currency: "EUR" }).expect(400);
      await manager.put(`/v1/workspaces/${w}/targets`).send({ userId: owner.userId, periodType: "month", periodStart: "2026-09-01", metric: "meetings_booked", target: 2.5 }).expect(400);
      await manager.put(`/v1/workspaces/${w}/targets`).send({ userId: other.userId, periodType: "month", periodStart: "2026-09-01", target: 5 }).expect(400);
      await manager.put(`/v1/workspaces/${w}/targets`).send({ periodType: "year", periodStart: "2026-01-01", target: 5 }).expect(400);
    });

    it("are deleted, and only in their own workspace", async () => {
      const temp = (await manager.put(`/v1/workspaces/${w}/targets`).send({ userId: member.userId, periodType: "quarter", periodStart: "2026-07-01", metric: "meetings_booked", target: 12 }).expect(200)).body.data;
      await other.delete(`/v1/workspaces/${w2}/targets/${temp.id}`).expect(404);
      await other.delete(`/v1/workspaces/${w}/targets/${temp.id}`).expect(404); // not a member: the workspace does not exist for them
      await member.delete(`/v1/workspaces/${w}/targets/${temp.id}`).expect(403);
      await manager.delete(`/v1/workspaces/${w}/targets/${temp.id}`).expect(200);
      expect(await t.prisma.db.salesTarget.count({ where: { workspaceId: w, id: temp.id } })).toBe(0);
    });
  });

  describe("forecast", () => {
    beforeAll(async () => {
      // Olive's September: two wins (one at 19:00 UTC Aug 31 = Sept 1 in Dhaka), a third win that is October there,
      // one deal per category, one expected in October, one in euros.
      await seedDeal(w, { name: "Won early Sept", value: 5000, stage: "Won", closedAt: "2026-09-10T00:00:00Z" });
      await seedDeal(w, { name: "Won Sept 1 local", value: 300, stage: "Won", closedAt: "2026-08-31T19:00:00Z" });
      await seedDeal(w, { name: "Won Oct 1 local", value: 700, stage: "Won", closedAt: "2026-09-30T19:00:00Z" });
      await seedDeal(w, { name: "Commit", value: 3000, stage: "Negotiation", category: "commit", close: "2026-09-20" });
      await seedDeal(w, { name: "Best", value: 2000, stage: "Qualified", category: "best_case", close: "2026-09-25" });
      await seedDeal(w, { name: "Pipe", value: 1000, stage: "Qualified", category: "pipeline", close: "2026-09-05" });
      await seedDeal(w, { name: "Omitted", value: 9000, stage: "Negotiation", category: "omitted", close: "2026-09-15" });
      await seedDeal(w, { name: "October", value: 4444, stage: "Negotiation", category: "commit", close: "2026-10-02" });
      await seedDeal(w, { name: "Euro", value: 500, stage: "Qualified", close: "2026-09-12", currency: "EUR" });
      await seedDeal(w, { name: "Lost", value: 800, stage: "Lost", closedAt: "2026-09-12T00:00:00Z", close: "2026-09-12" });
      await seedDeal(w, { name: "Deleted", value: 999, stage: "Won", closedAt: "2026-09-12T00:00:00Z", deleted: true });
      await seedDeal(w, { name: "July win", value: 1000, stage: "Won", closedAt: "2026-07-15T00:00:00Z" });
      // Morgan (member): a win and a commit. Nobody's: a pipeline deal.
      await seedDeal(w, { name: "Member won", ownerId: member.userId, value: 1500, stage: "Won", closedAt: "2026-09-12T00:00:00Z" });
      await seedDeal(w, { name: "Member commit", ownerId: member.userId, value: 500, stage: "Negotiation", category: "commit", close: "2026-09-28" });
      await seedDeal(w, { name: "Unowned", ownerId: null, value: 400, stage: "Qualified", close: "2026-09-03" });
      // Meetings booked in September (a canceled one does not count).
      const meeting = (ownerId: string, createdAt: string, status: "scheduled" | "canceled" = "scheduled") =>
        t.prisma.db.meeting.create({ data: { workspaceId: w, title: "Call", startsAt: at("2026-10-20T10:00:00Z"), ownerId, status, createdAt: at(createdAt) } });
      await meeting(owner.userId, "2026-09-02T10:00:00Z");
      await meeting(owner.userId, "2026-09-22T10:00:00Z");
      await meeting(owner.userId, "2026-09-23T10:00:00Z", "canceled");
      await meeting(member.userId, "2026-09-09T10:00:00Z");
      // Another workspace's September must never show up here.
      const p2 = (await other.get(`/v1/workspaces/${w2}/pipelines`).expect(200)).body.data[0];
      await seedDeal(w2, { name: "Elsewhere", ownerId: other.userId, value: 77777, stage: "Won", closedAt: "2026-09-12T00:00:00Z", pipeline: p2.id, stageList: p2.stages });
    });

    it("splits the period by owner and category against targets", async () => {
      const f = (await owner.get(`/v1/workspaces/${w}/forecast?${SEPT}`).expect(200)).body.data;
      expect(f.period).toMatchObject({ type: "month", label: "September 2026", from: "2026-09-01", to: "2026-09-30", timeZone: "Asia/Dhaka" });
      expect([f.currency, f.scope]).toEqual(["USD", "all"]);

      const olive = f.owners.find((o: { ownerId: string | null }) => o.ownerId === owner.userId);
      expect(olive).toMatchObject({ won: 5300, commit: 3000, bestCase: 2000, pipeline: 1000, omitted: 9000, weighted: 2400 + 800 + 400, target: 10000, gap: 4700, dealsWon: 2, dealsWonTarget: 4, meetingsBooked: 2 });
      expect(olive.attainment).toBeCloseTo(0.53);
      expect(olive.owner.name).toBe("Olive Owner");
      const morgan = f.owners.find((o: { ownerId: string | null }) => o.ownerId === member.userId);
      expect(morgan).toMatchObject({ won: 1500, commit: 500, weighted: 400, target: 2000, gap: 500, attainment: 0.75, meetingsBooked: 1 });
      const nobody = f.owners.find((o: { ownerId: string | null }) => o.ownerId === null);
      expect(nobody).toMatchObject({ pipeline: 400, weighted: 160, owner: null });

      // The team target is the explicit one, not the sum of the owners'.
      expect(f.total).toMatchObject({ won: 6800, commit: 3500, bestCase: 2000, pipeline: 1400, omitted: 9000, weighted: 4160, target: 20000, gap: 13200, projected: 10300, dealsWon: 3, meetingsBooked: 3 });
      expect(f.otherCurrencies).toEqual([{ currency: "EUR", won: 0, open: 500, deals: 1 }]);

      const names = f.deals.map((d: { name: string }) => d.name).sort();
      expect(names).toEqual(["Best", "Commit", "Euro", "Member commit", "Member won", "Omitted", "Pipe", "Unowned", "Won Sept 1 local", "Won early Sept"].sort());
      const commit = f.deals.find((d: { name: string }) => d.name === "Commit");
      expect(commit).toMatchObject({ forecastCategory: "commit", weighted: 2400, stage: { name: "Negotiation", probability: 80 } });
      expect(f.deals.find((d: { name: string }) => d.name === "Omitted").weighted).toBeNull();
    });

    it("covers a quarter, and narrows to one owner", async () => {
      const q = (await owner.get(`/v1/workspaces/${w}/forecast?periodType=quarter&periodStart=2026-08-15`).expect(200)).body.data;
      expect(q.period).toMatchObject({ label: "Q3 2026", from: "2026-07-01", to: "2026-09-30" });
      expect(q.total.won).toBe(7800);
      // No quarterly targets were set.
      expect(q.total.target).toBeNull();

      const mine = (await owner.get(`/v1/workspaces/${w}/forecast?${SEPT}&ownerId=me`).expect(200)).body.data;
      expect(mine.owners.map((o: { ownerId: string }) => o.ownerId)).toEqual([owner.userId]);
      expect(mine.total).toMatchObject({ won: 5300, target: 10000 });
      expect(mine.deals.every((d: { owner: { id: string } | null }) => d.owner?.id === owner.userId)).toBe(true);
    });

    it("shows someone without the team view only what they may see", async () => {
      // Team visibility takes records.view_all from members; Morgan is in no team, so sees their own and unowned deals.
      await t.prisma.db.workspace.update({ where: { id: w }, data: { settings: { recordVisibility: "team" } } });
      try {
        const f = (await member.get(`/v1/workspaces/${w}/forecast?${SEPT}`).expect(200)).body.data;
        expect(f.scope).toBe("own");
        expect(f.owners.map((o: { ownerId: string | null }) => o.ownerId).sort()).toEqual([member.userId, null].sort());
        expect(f.total).toMatchObject({ won: 1500, commit: 500, pipeline: 400, target: 2000 });
        expect(f.deals.some((d: { name: string }) => d.name === "Commit")).toBe(false);
        // analytics.team (managers) still sees the team.
        expect((await manager.get(`/v1/workspaces/${w}/forecast?${SEPT}`).expect(200)).body.data.scope).toBe("all");
      } finally {
        await t.prisma.db.workspace.update({ where: { id: w }, data: { settings: {} } });
      }
    });

    it("never mixes workspaces", async () => {
      await other.get(`/v1/workspaces/${w}/forecast?${SEPT}`).expect(404);
      const f = (await other.get(`/v1/workspaces/${w2}/forecast?${SEPT}`).expect(200)).body.data;
      expect(f.total.won).toBe(77777);
      expect(f.total.target).toBeNull();
      expect(f.deals.map((d: { name: string }) => d.name)).toEqual(["Elsewhere"]);
    });

    it("moves a deal between categories through the deal API, on the timeline", async () => {
      const pipe = await t.prisma.db.deal.findFirstOrThrow({ where: { workspaceId: w, name: "Pipe" } });
      const updated = (
        await member.patch(`/v1/workspaces/${w}/deals/${pipe.id}`).send({ forecastCategory: "commit", nextStep: "Send the order form", nextStepAt: "2026-09-08T09:00:00Z" }).expect(200)
      ).body.data;
      expect(updated).toMatchObject({ forecastCategory: "commit", nextStep: "Send the order form", nextStepAt: "2026-09-08T09:00:00.000Z", stale: null });
      await member.patch(`/v1/workspaces/${w}/deals/${pipe.id}`).send({ forecastCategory: "someday" }).expect(400);
      const timeline = (await owner.get(`/v1/workspaces/${w}/deals/${pipe.id}/timeline`).expect(200)).body.data;
      expect(timeline.some((e: { summary: string }) => e.summary.includes("forecast → Commit") && e.summary.includes("next step: Send the order form"))).toBe(true);
      const f = (await owner.get(`/v1/workspaces/${w}/forecast?${SEPT}`).expect(200)).body.data;
      expect([f.total.commit, f.total.pipeline]).toEqual([4500, 400]);
    });
  });

  describe("team targets and roll-ups", () => {
    let closers: { id: string };
    let elsewhere: { id: string };

    beforeAll(async () => {
      closers = await t.prisma.db.team.create({ data: { workspaceId: w, name: "Closers", leadUserId: owner.userId } });
      await t.prisma.db.teamMember.createMany({ data: [owner.userId, member.userId].map((userId) => ({ workspaceId: w, teamId: closers.id, userId })) });
      const solo = await t.prisma.db.team.create({ data: { workspaceId: w, name: "Solo" } });
      await t.prisma.db.teamMember.create({ data: { workspaceId: w, teamId: solo.id, userId: manager.userId } });
      elsewhere = await t.prisma.db.team.create({ data: { workspaceId: w2, name: "Theirs" } });
    });

    it("are set per team, never for a person and a team at once, and only for this workspace's teams", async () => {
      const a = (await manager.put(`/v1/workspaces/${w}/targets`).send({ teamId: closers.id, periodType: "month", periodStart: "2026-09-01", target: 8000 }).expect(200)).body.data;
      const b = (await manager.put(`/v1/workspaces/${w}/targets`).send({ teamId: closers.id, periodType: "month", periodStart: "2026-09-09", target: 9000 }).expect(200)).body.data;
      expect(b.id).toBe(a.id);
      expect(b).toMatchObject({ teamId: closers.id, userId: null, target: 9000 });
      await manager.put(`/v1/workspaces/${w}/targets`).send({ teamId: closers.id, userId: member.userId, periodType: "month", periodStart: "2026-09-01", target: 1 }).expect(400);
      await manager.put(`/v1/workspaces/${w}/targets`).send({ teamId: elsewhere.id, periodType: "month", periodStart: "2026-09-01", target: 1 }).expect(400);
      const list = (await manager.get(`/v1/workspaces/${w}/targets?${SEPT}`).expect(200)).body.data;
      expect(list.items.find((x: { teamId: string | null }) => x.teamId === closers.id).team.name).toBe("Closers");
      // The workspace target is still its own row.
      expect(list.items.filter((x: { userId: string | null; teamId: string | null; metric: string }) => !x.userId && !x.teamId && x.metric === "revenue_won").map((x: { target: number }) => x.target)).toEqual([20000]);
    });

    it("rolls each team's members up against the team's target", async () => {
      const f = (await owner.get(`/v1/workspaces/${w}/forecast?${SEPT}`).expect(200)).body.data;
      // A team target never measures the workspace total.
      expect(f.total.target).toBe(20000);
      const row = f.teams.find((x: { team: { name: string } }) => x.team.name === "Closers");
      expect(row.memberIds.sort()).toEqual([owner.userId, member.userId].sort());
      expect(row).toMatchObject({ won: 6800, commit: 4500, target: 9000, gap: 2200, dealsWon: 3 });
      // Solo has no target of its own and its member none either.
      expect(f.teams.find((x: { team: { name: string } }) => x.team.name === "Solo")).toMatchObject({ won: 0, target: null });
    });

    it("narrows to one team, and leaves a deactivated member's open pipeline out while their wins count", async () => {
      await t.prisma.db.membership.update({ where: { workspaceId_userId: { workspaceId: w, userId: member.userId } }, data: { deactivatedAt: new Date() } });
      try {
        const all = (await owner.get(`/v1/workspaces/${w}/forecast?${SEPT}`).expect(200)).body.data;
        expect(all.teams.find((x: { team: { name: string } }) => x.team.name === "Closers")).toMatchObject({ won: 6800, commit: 4000 });
        const one = (await owner.get(`/v1/workspaces/${w}/forecast?${SEPT}&teamId=${closers.id}`).expect(200)).body.data;
        expect(one.team).toMatchObject({ id: closers.id, name: "Closers" });
        expect(one.teams).toEqual([]);
        expect(one.total).toMatchObject({ won: 6800, commit: 4000, target: 9000, gap: 2200 });
        const names = one.deals.map((d: { name: string }) => d.name);
        expect(names).toContain("Member won");
        expect(names).not.toContain("Member commit");
        expect(names).not.toContain("Unowned");
      } finally {
        await t.prisma.db.membership.update({ where: { workspaceId_userId: { workspaceId: w, userId: member.userId } }, data: { deactivatedAt: null } });
      }
      await owner.get(`/v1/workspaces/${w}/forecast?${SEPT}&teamId=${elsewhere.id}`).expect(404);
    });

    it("drops a team's targets with the team", async () => {
      await t.prisma.db.team.delete({ where: { id: closers.id, workspaceId: w } });
      expect(await t.prisma.db.salesTarget.count({ where: { workspaceId: w, teamId: closers.id } })).toBe(0);
    });
  });

  describe("stage guidance", () => {
    it("is saved per stage and kept when a later save leaves it out", async () => {
      const withGuidance = stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind, probability: s.probability, color: s.color, ...(s.name === "Qualified" ? { guidance: "Budget confirmed\nDecision maker met" } : {}) }));
      const p = (await owner.put(`/v1/workspaces/${w}/pipelines/${pipelineId}`).send({ name: "Sales", stages: withGuidance }).expect(200)).body.data;
      expect(p.stages.find((s: { name: string }) => s.name === "Qualified").guidance).toBe("Budget confirmed\nDecision maker met");
      expect(p.stages.find((s: { name: string }) => s.name === "Won").guidance).toBe("");
      const again = (await owner.put(`/v1/workspaces/${w}/pipelines/${pipelineId}`).send({ name: "Sales", stages: stages.map(({ id, name, kind, probability, color }) => ({ id, name, kind, probability, color })) }).expect(200)).body.data;
      expect(again.stages.find((s: { name: string }) => s.name === "Qualified").guidance).toBe("Budget confirmed\nDecision maker met");
      const listed = (await member.get(`/v1/workspaces/${w}/pipelines`).expect(200)).body.data[0];
      expect(listed.stages.find((s: { name: string }) => s.name === "Qualified").guidance).toContain("Budget confirmed");
    });
  });

  describe("next steps on a stage move", () => {
    it("warns, without refusing, when an open deal moves on with no next step", async () => {
      const bare = (await owner.post(`/v1/workspaces/${w}/deals`).send({ name: "No plan", value: 10 }).expect(201)).body.data;
      expect(bare.forecastCategory).toBe("pipeline");
      const moved = (await owner.post(`/v1/workspaces/${w}/deals/${bare.id}/move`).send({ stageId: stage("Qualified").id }).expect(200)).body.data;
      expect(moved.stage.name).toBe("Qualified");
      expect(moved.warning).toMatch(/next step/);

      const planned = (await owner.post(`/v1/workspaces/${w}/deals`).send({ name: "With plan", value: 10, nextStep: "Demo on Tuesday" }).expect(201)).body.data;
      const ok = (await owner.post(`/v1/workspaces/${w}/deals/${planned.id}/move`).send({ stageId: stage("Qualified").id }).expect(200)).body.data;
      expect(ok.warning).toBeUndefined();
      // Winning needs no next step.
      const won = (await owner.post(`/v1/workspaces/${w}/deals/${bare.id}/move`).send({ stageId: stage("Won").id }).expect(200)).body.data;
      expect(won.warning).toBeUndefined();
    });
  });

  describe("stale deals", () => {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    let stale: { id: string };
    let touched: { id: string };

    beforeAll(async () => {
      // "Stale after 14 days" on Qualified, set through the pipeline editor's API; other stages keep theirs (none).
      const body = { name: "Sales", stages: stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind, probability: s.probability, color: s.color, ...(s.name === "Qualified" ? { rotDays: 14 } : {}) })) };
      const p = (await owner.put(`/v1/workspaces/${w}/pipelines/${pipelineId}`).send(body).expect(200)).body.data;
      expect(p.stages.find((s: Stage) => s.name === "Qualified").rotDays).toBe(14);
      expect(p.stages.find((s: Stage) => s.name === "Negotiation").rotDays).toBeNull();
      await member.put(`/v1/workspaces/${w}/pipelines/${pipelineId}`).send(body).expect(403);

      const contact = await t.prisma.db.contact.create({ data: { workspaceId: w, fullName: "Stale Steve", email: "steve@lead.test" } });
      const make = (name: string, stageName: string, enteredDaysAgo: number, ownerId: string = member.userId) =>
        t.prisma.db.deal.create({ data: { workspaceId: w, pipelineId, stageId: stage(stageName).id, name, ownerId, contactId: contact.id, value: 100, stageEnteredAt: ago(enteredDaysAgo) } });
      stale = await make("Gone quiet", "Qualified", 20);
      await make("Fresh", "Qualified", 5);
      touched = await make("Recently touched", "Qualified", 20);
      await t.prisma.db.activity.create({ data: { workspaceId: w, dealId: touched.id, type: "note.added", summary: "Spoke to them", occurredAt: ago(3) } });
      const tasked = await make("Task done", "Qualified", 30);
      await t.prisma.db.task.create({ data: { workspaceId: w, dealId: tasked.id, title: "Follow up", status: "done", completedAt: ago(2) } });
      await make("No rot rule", "Negotiation", 60);

      // The other workspace's stale deal belongs to its own owner.
      const p2 = (await other.get(`/v1/workspaces/${w2}/pipelines`).expect(200)).body.data[0];
      const s2 = p2.stages.map((s: Stage) => ({ ...s, ...(s.name === "Qualified" ? { rotDays: 7 } : {}) }));
      await other.put(`/v1/workspaces/${w2}/pipelines/${p2.id}`).send({ name: p2.name, stages: s2 }).expect(200);
      await t.prisma.db.deal.create({ data: { workspaceId: w2, pipelineId: p2.id, stageId: p2.stages.find((s: Stage) => s.name === "Qualified").id, name: "Theirs", ownerId: other.userId, value: 1, stageEnteredAt: ago(10) } });
    });

    it("shows on the deal and in the stale filter", async () => {
      const list = (await owner.get(`/v1/workspaces/${w}/deals?stale=true`).expect(200)).body.data;
      expect(list.items.map((d: { name: string }) => d.name)).toEqual(["Gone quiet"]);
      expect(list.total).toBe(1);
      expect(list.items[0].stale.days).toBe(20);
      const one = (await owner.get(`/v1/workspaces/${w}/deals/${stale.id}`).expect(200)).body.data;
      expect(one.stale).toMatchObject({ days: 20 });
      const all = (await owner.get(`/v1/workspaces/${w}/deals?pipelineId=${pipelineId}`).expect(200)).body.data.items;
      expect(all.find((d: { id: string }) => d.id === touched.id).stale).toBeNull();
    });

    it("tells the owner once, on the timeline and as a deal.stale event", async () => {
      expect(await sweeper().sweep(now)).toBe(2); // ours and the other workspace's

      const notes = await t.prisma.db.notification.findMany({ where: { workspaceId: w, type: "deal.stale" } });
      expect(notes.map((n) => [n.userId, n.title])).toEqual([[member.userId, "Deal going stale: Gone quiet"]]);
      const events = await t.prisma.db.domainEvent.findMany({ where: { workspaceId: w, type: "deal.stale" } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ subjectType: "deal", subjectId: stale.id });
      expect(events[0]!.payload).toMatchObject({ dealId: stale.id, ownerId: member.userId, stage: "Qualified", days: 20 });
      expect((events[0]!.payload as { contactId: string }).contactId).toBeTruthy();
      const timeline = await t.prisma.db.activity.findMany({ where: { workspaceId: w, dealId: stale.id, type: "deal.stale" } });
      expect(timeline).toHaveLength(1);
      expect((await t.prisma.db.deal.findFirstOrThrow({ where: { workspaceId: w, id: stale.id } })).staleNotifiedAt?.getTime()).toBe(now.getTime());

      // Isolation: the other workspace's notice went to its own owner only.
      const theirs = await t.prisma.db.notification.findMany({ where: { workspaceId: w2, type: "deal.stale" } });
      expect(theirs.map((n) => n.userId)).toEqual([other.userId]);

      // The next sweep is quiet: the stale notice itself is not progress, and the spell was announced.
      expect(await sweeper().sweep(new Date(now.getTime() + 3600_000))).toBe(0);
      expect(await t.prisma.db.notification.count({ where: { workspaceId: w, type: "deal.stale" } })).toBe(1);
      expect(await t.prisma.db.domainEvent.count({ where: { workspaceId: w, type: "deal.stale" } })).toBe(1);
    });

    it("starts a new spell after progress, and moving the deal ends it", async () => {
      // Progress an hour after the notice: two days on it is not stale; fifteen days on it has gone quiet again.
      await t.prisma.db.activity.create({ data: { workspaceId: w, dealId: stale.id, type: "call.logged", summary: "Left a voicemail", occurredAt: new Date(now.getTime() + 3600_000) } });
      expect(await sweeper().sweep(new Date(now.getTime() + 2 * DAY))).toBe(0);
      // (By then the other Qualified deals seeded above have gone quiet too; this checks ours.)
      expect(await sweeper().sweep(new Date(now.getTime() + 15 * DAY))).toBeGreaterThan(0);
      expect(await t.prisma.db.notification.count({ where: { workspaceId: w, type: "deal.stale", title: "Deal going stale: Gone quiet" } })).toBe(2);
      expect(await t.prisma.db.domainEvent.count({ where: { workspaceId: w, type: "deal.stale", subjectId: stale.id } })).toBe(2);
      // The other workspace's deal made no progress, so its spell was already announced.
      expect(await t.prisma.db.notification.count({ where: { workspaceId: w2, type: "deal.stale" } })).toBe(1);

      await member.post(`/v1/workspaces/${w}/deals/${stale.id}/move`).send({ stageId: stage("Negotiation").id }).expect(200);
      expect((await member.get(`/v1/workspaces/${w}/deals/${stale.id}`).expect(200)).body.data.stale).toBeNull();
    });
  });

  const sweeper = () => t.app.get(StaleDealsService);
});
