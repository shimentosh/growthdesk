import { isOpenNow, localDay } from "@growthdesk/shared";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Campaign structure and scheduling: step edits once contacts are enrolled
 * (GAP 4.3), the daily new-contact limit per local day (4.7) and the fix
 * links on launch readiness (5.7). Task steps keep these free of SMTP.
 */
const WEEKDAYS = { timezone: "UTC", days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };
const task = (taskTitle: string) => ({ type: "create_task", config: { taskTitle } });
const wait = (days: number) => ({ type: "wait", config: { delayMinutes: days * 1440 } });

/** The first Friday at least two days from now, 10:00 UTC. */
function nextFriday(): Date {
  const d = new Date(Date.now() + 2 * 86_400_000);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0));
}
const plusDays = (d: Date, n: number) => localDay(new Date(d.getTime() + n * 86_400_000), "UTC");

describe("Campaign structure and scheduling", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const api = (path: string) => `/v1/workspaces/${w}${path}`;
  const people = async (prefix: string, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await owner.post(api("/contacts")).send({ fullName: `${prefix} ${i}`, email: `${prefix}${i}@structure.test` }).expect(201)).body.data.id);
    return ids;
  };
  const startsByDay = async (campaignId: string) => {
    const rows = await t.prisma.db.enrollment.findMany({ where: { workspaceId: w, campaignId, stepRun: 0 }, select: { nextRunAt: true } });
    const out: Record<string, number> = {};
    for (const r of rows) out[localDay(r.nextRunAt!, "UTC")] = (out[localDay(r.nextRunAt!, "UTC")] ?? 0) + 1;
    return out;
  };

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "structure-owner@acme.test");
    w = await createWorkspace(owner, "Structure Co");
    await setPlan(t, w, "growth");
  });
  afterAll(async () => t.close());

  it("readiness links each problem to where it is fixed", async () => {
    const c = (await owner.post(api("/campaigns")).send({ name: "Not ready" }).expect(201)).body.data;
    const r = (await owner.get(api(`/campaigns/${c.id}/readiness`)).expect(200)).body.data;
    expect(r.ready).toBe(false);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        { field: "steps", message: "Add at least one step before launching.", fix: { label: "Edit steps", href: `/campaigns/${c.id}?tab=steps` } },
        { field: "audience", message: "Choose who this campaign is for.", fix: { label: "Edit audience", href: `/campaigns/${c.id}?tab=audience` } },
      ]),
    );
    // An email step with no mailbox anywhere in the workspace points at the mailbox settings.
    await owner.patch(api(`/campaigns/${c.id}`)).send({ steps: [{ type: "email", config: { subject: "Hi", body: "Hello" } }] }).expect(200);
    const r2 = (await owner.get(api(`/campaigns/${c.id}/readiness`)).expect(200)).body.data;
    expect(r2.problems.find((p: { field: string }) => p.field === "mailboxIds").fix).toEqual({ label: "Connect a mailbox", href: "/settings/mailboxes" });
    // The 422 from launch carries the same shape.
    const refused = await owner.post(api(`/campaigns/${c.id}/launch`)).expect(422);
    expect(refused.body.error.details.problems.every((p: { fix?: { href: string } }) => p.fix?.href)).toBe(true);
  });

  it("caps new starts per local day: a weekend takes nobody and a later batch queues behind", async () => {
    const friday = nextFriday();
    const contacts = await people("limit", 9);
    const c = (
      await owner
        .post(api("/campaigns"))
        .send({
          name: "Daily limit",
          steps: [task("Call {{first_name|them}}")],
          schedule: WEEKDAYS,
          settings: { dailyNewLimit: 2, gapSeconds: 60 },
          audience: { type: "contacts", contactIds: contacts.slice(0, 6) },
          startAt: friday.toISOString(),
        })
        .expect(201)
    ).body.data;
    const launched = await owner.post(api(`/campaigns/${c.id}/launch`)).expect(200);
    expect(launched.body.data).toMatchObject({ enrolled: 6, campaign: { status: "scheduled" } });
    // Friday 2, nothing on Saturday or Sunday, Monday 2, Tuesday 2 (it used to be Friday 2, Monday 4: three days folded onto one).
    expect(await startsByDay(c.id)).toEqual({ [plusDays(friday, 0)]: 2, [plusDays(friday, 3)]: 2, [plusDays(friday, 4)]: 2 });

    // A second batch fills the days after the first instead of landing on them again.
    await owner.post(api(`/campaigns/${c.id}/enroll`)).send({ contactIds: contacts.slice(6) }).expect(200);
    expect(await startsByDay(c.id)).toEqual({
      [plusDays(friday, 0)]: 2,
      [plusDays(friday, 3)]: 2,
      [plusDays(friday, 4)]: 2,
      [plusDays(friday, 5)]: 2,
      [plusDays(friday, 6)]: 1,
    });
    const rows = await t.prisma.db.enrollment.findMany({ where: { workspaceId: w, campaignId: c.id }, select: { nextRunAt: true }, orderBy: { nextRunAt: "asc" } });
    expect(rows[0]!.nextRunAt!.toISOString()).toBe(friday.toISOString());
    expect(rows[1]!.nextRunAt!.getTime() - rows[0]!.nextRunAt!.getTime()).toBe(60_000);
    expect(rows.every((r) => isOpenNow(WEEKDAYS, r.nextRunAt!))).toBe(true);
  });

  it("resuming spreads starts that fell due during a pause instead of sending them all at once", async () => {
    const contacts = await people("resume", 5);
    const c = (
      await owner
        .post(api("/campaigns"))
        .send({
          name: "Paused queue",
          steps: [task("Call")],
          schedule: WEEKDAYS,
          settings: { dailyNewLimit: 2, gapSeconds: 0 },
          audience: { type: "contacts", contactIds: contacts },
        })
        .expect(201)
    ).body.data;
    await owner.post(api(`/campaigns/${c.id}/launch`)).expect(200);
    await owner.post(api(`/campaigns/${c.id}/pause`)).expect(200);
    // As if the campaign sat paused for a week: every start is now overdue.
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    await t.prisma.db.enrollment.updateMany({ where: { workspaceId: w, campaignId: c.id }, data: { nextRunAt: weekAgo } });
    // A smaller limit set while paused applies from the resume on.
    await owner.patch(api(`/campaigns/${c.id}`)).send({ settings: { dailyNewLimit: 1 } }).expect(200);

    const before = Date.now() - 1000;
    await owner.post(api(`/campaigns/${c.id}/resume`)).expect(200);
    const rows = await t.prisma.db.enrollment.findMany({ where: { workspaceId: w, campaignId: c.id }, select: { nextRunAt: true } });
    expect(rows.every((r) => r.nextRunAt!.getTime() >= before && isOpenNow(WEEKDAYS, r.nextRunAt!))).toBe(true);
    const byDay = await startsByDay(c.id);
    expect(Object.values(byDay)).toEqual([1, 1, 1, 1, 1]);
  });

  it("keeps enrolled contacts' places: step content edits and additions only", async () => {
    const contacts = await people("steps", 2);
    const steps = [task("First"), wait(2), task("Second")];
    const c = (
      await owner
        .post(api("/campaigns"))
        .send({ name: "Structure", steps, schedule: WEEKDAYS, audience: { type: "contacts", contactIds: contacts } })
        .expect(201)
    ).body.data;
    // A draft has nobody enrolled: anything goes.
    await owner.patch(api(`/campaigns/${c.id}`)).send({ steps: [task("Zero"), ...steps] }).expect(200);
    await owner.patch(api(`/campaigns/${c.id}`)).send({ steps }).expect(200);
    await owner.post(api(`/campaigns/${c.id}/launch`)).expect(200);
    await owner.post(api(`/campaigns/${c.id}/pause`)).expect(200);
    // One contact is waiting on step 3 (position 2).
    const e = await t.prisma.db.enrollment.findFirstOrThrow({ where: { workspaceId: w, campaignId: c.id, contactId: contacts[0]! } });
    await t.prisma.db.enrollment.updateMany({ where: { id: e.id, workspaceId: w }, data: { position: 2, stepRun: 2 } });
    const before = (await owner.get(api(`/campaigns/${c.id}`)).expect(200)).body.data.steps as { id: string }[];

    // Removing step 2 would make the waiting contact skip "Second"; inserting before it would re-send "First".
    const removed = await owner.patch(api(`/campaigns/${c.id}`)).send({ steps: [task("First"), task("Second")] }).expect(409);
    expect(removed.body.error.message).toMatch(/^This removes a step\. 2 contacts are enrolled/);
    expect(removed.body.error.fields.steps).toBe(removed.body.error.message);
    const inserted = await owner.patch(api(`/campaigns/${c.id}`)).send({ steps: [task("First"), task("New"), wait(2), task("Second")] }).expect(409);
    expect(inserted.body.error.message).toMatch(/^Step 2 changes from wait to create_task/);
    // A refused edit changes nothing else in the same request.
    await owner.patch(api(`/campaigns/${c.id}`)).send({ name: "Renamed", steps: [task("Only")] }).expect(409);
    expect((await owner.get(api(`/campaigns/${c.id}`)).expect(200)).body.data.name).toBe("Structure");

    // Rewording, retiming and appending keep every existing step (and its id) where it was.
    const ok = await owner
      .patch(api(`/campaigns/${c.id}`))
      .send({ steps: [task("First, reworded"), wait(3), task("Second"), wait(1), task("Third")] })
      .expect(200);
    const after = ok.body.data.steps as { id: string; position: number; type: string; config: { taskTitle?: string; delayMinutes?: number } }[];
    expect(after.map((s) => s.type)).toEqual(["create_task", "wait", "create_task", "wait", "create_task"]);
    expect(after.slice(0, 3).map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(after[0]!.config.taskTitle).toBe("First, reworded");
    expect(after[1]!.config.delayMinutes).toBe(3 * 1440);
    expect(after[4]).toMatchObject({ position: 4, config: { taskTitle: "Third" } });
    const still = await t.prisma.db.enrollment.findFirstOrThrow({ where: { id: e.id, workspaceId: w } });
    expect(still.position).toBe(2);
  });
});
