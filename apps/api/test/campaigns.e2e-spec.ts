import { randomUUID } from "node:crypto";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { EngineService } from "../src/campaigns/engine.service.js";

/*
 * Templates → sequences → campaigns → launch → the engine sending one email
 * through the dev SMTP server (GreenMail at 127.0.0.1:3925; any
 * x@growthdesk.test logs in with the address as its password).
 */
const ALWAYS_OPEN = { timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "00:00" };

describe("Campaigns", () => {
  let t: TestApp;
  let owner: Agent;
  let other: Agent;
  let w: string;
  let w2: string;
  let templateId: string;
  let sequenceId: string;
  let campaignId: string;
  let mailboxId: string;
  const contacts: Record<string, string> = {};

  const api = (path: string) => `/v1/workspaces/${w}${path}`;

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "camp-owner@acme.test");
    w = await createWorkspace(owner, "Campaign Co");
    await setPlan(t, w, "growth");
    other = await signUp(t, "camp-other@other.test");
    w2 = await createWorkspace(other, "Other Co");
    await setPlan(t, w2, "growth");
  });
  afterAll(async () => t.close());

  it("creates a template and a library sequence that uses it", async () => {
    const tpl = await owner
      .post(api("/templates"))
      .send({ name: "Intro", subject: "Hello {{first_name|there}}", body: "Hi {{first_name|there}},\n\nQuick question about {{company|your team}}." })
      .expect(201);
    templateId = tpl.body.data.id;
    const seq = await owner
      .post(api("/sequences"))
      .send({
        name: "Two touch",
        steps: [
          { type: "email", config: { templateId } },
          { type: "wait", config: { delayMinutes: 2 * 24 * 60 } },
          { type: "email", config: { body: "Just bumping this, {{first_name|there}}." } },
        ],
      })
      .expect(201);
    sequenceId = seq.body.data.id;
    expect(seq.body.data.steps).toHaveLength(3);
  });

  it("creates a campaign from a sequence, copying its steps", async () => {
    const res = await owner.post(api("/campaigns")).send({ name: "Q4 outbound", fromSequenceId: sequenceId, schedule: ALWAYS_OPEN, settings: { gapSeconds: 0 } }).expect(201);
    const c = res.body.data;
    campaignId = c.id;
    expect(c.status).toBe("draft");
    expect(c.steps.map((s: { type: string }) => s.type)).toEqual(["email", "wait", "email"]);
    expect(c.sequenceId).not.toBe(sequenceId);
    expect(c.audienceDescription).toBe("No audience chosen yet");
    expect(c.schedule).toMatchObject({ timezone: "UTC", from: "00:00" });
    expect(c.settings).toMatchObject({ gapSeconds: 0, dailyNewLimit: 50, stopOnReply: true });
    expect(c.stats).toMatchObject({ enrolled: 0, sent: 0 });
    expect(c.owner.id).toBe(owner.userId);
    // Editing the library sequence leaves the campaign's copy alone.
    await owner.patch(api(`/sequences/${sequenceId}`)).send({ steps: [{ type: "email", config: { subject: "Changed", body: "Changed" } }] }).expect(200);
    const again = await owner.get(api(`/campaigns/${campaignId}`)).expect(200);
    expect(again.body.data.steps).toHaveLength(3);
    const list = await owner.get(api("/campaigns?status=draft&q=q4")).expect(200);
    expect(list.body.data.items.map((x: { id: string }) => x.id)).toEqual([campaignId]);
    expect(list.body.data.items[0].enrollments).toMatchObject({ active: 0, completed: 0 });
  });

  it("isolates campaigns between workspaces", async () => {
    await other.get(api(`/campaigns/${campaignId}`)).expect(404);
    await other.get(api("/campaigns")).expect(404);
    await other.get(`/v1/workspaces/${w2}/campaigns/${campaignId}`).expect(404);
    await other.post(`/v1/workspaces/${w2}/campaigns/${campaignId}/launch`).expect(404);
    await other.patch(`/v1/workspaces/${w2}/campaigns/${campaignId}`).send({ name: "Hijack" }).expect(404);
    const list = await other.get(`/v1/workspaces/${w2}/campaigns`).expect(200);
    expect(list.body.data.total).toBe(0);
    // A campaign cannot name another workspace's sequence or mailbox.
    await other.post(`/v1/workspaces/${w2}/campaigns`).send({ name: "x", fromSequenceId: sequenceId }).expect(404);
    await owner.get(api("/campaigns/not-a-uuid")).expect(404);
  });

  it("refuses to launch until the campaign is ready", async () => {
    const blank = (await owner.post(api("/campaigns")).send({ name: "Blank" }).expect(201)).body.data;
    const r1 = await owner.post(api(`/campaigns/${blank.id}/launch`)).expect(422);
    expect(r1.body.error.code).toBe("not_ready");
    expect(r1.body.error.message).toBe("Add at least one step before launching.");
    expect(r1.body.error.fields.audience).toBe("Choose who this campaign is for.");

    const r2 = await owner.post(api(`/campaigns/${campaignId}/launch`)).expect(422);
    expect(r2.body.error.fields.mailboxIds).toMatch(/Connect a mailbox/);
    expect(r2.body.error.fields.audience).toBe("Choose who this campaign is for.");
    const ready = await owner.get(api(`/campaigns/${campaignId}/readiness`)).expect(200);
    expect(ready.body.data.ready).toBe(false);

    // Step content is validated on save.
    const bad = await owner.patch(api(`/campaigns/${campaignId}`)).send({ steps: [{ type: "email", config: { subject: "Hi {{favourite_colour}}", body: "x" } }] }).expect(400);
    expect(bad.body.error.message).toMatch(/Unknown personalization/);
    await owner.delete(api(`/campaigns/${blank.id}`)).expect(200);
    await owner.get(api(`/campaigns/${blank.id}`)).expect(404);
  });

  it("launches: enrolls who may be contacted and reports why the rest were skipped", async () => {
    const mb = await owner
      .post(api("/mailboxes/smtp"))
      .send({
        email: "sender@growthdesk.test",
        displayName: "Sam Sender",
        smtpHost: "127.0.0.1",
        smtpPort: 3925,
        smtpSecurity: "none",
        smtpUser: "sender@growthdesk.test",
        password: "sender@growthdesk.test",
        imapEnabled: false,
        minDelaySeconds: 0,
      })
      .expect(201);
    mailboxId = mb.body.data.id;

    for (const [key, body] of Object.entries({
      ada: { fullName: "Ada Lovelace", email: "ada@growthdesk.test" },
      grace: { fullName: "Grace Hopper", email: "grace@growthdesk.test" },
      noEmail: { fullName: "Phone Only", phone: "+14155550101" },
      unsub: { fullName: "Un Subscribed", email: "unsub@growthdesk.test" },
      blocked: { fullName: "Sup Pressed", email: "blocked@suppressed.test" },
    })) {
      contacts[key] = (await owner.post(api("/contacts")).send(body).expect(201)).body.data.id;
    }
    await t.prisma.db.contact.updateMany({ where: { id: contacts.unsub, workspaceId: w }, data: { unsubscribedAt: new Date() } });
    await owner.post(api("/suppressions")).send({ kind: "domain", value: "suppressed.test" }).expect(201);
    const elsewhere = (await other.post(`/v1/workspaces/${w2}/contacts`).send({ fullName: "Not Yours", email: "x@other.test" }).expect(201)).body.data.id;

    // Structure can change while a draft.
    await owner
      .patch(api(`/campaigns/${campaignId}`))
      .send({ mailboxIds: [mailboxId], audience: { type: "contacts", contactIds: [...Object.values(contacts), elsewhere, randomUUID()] } })
      .expect(200);

    const ready = (await owner.get(api(`/campaigns/${campaignId}/readiness`)).expect(200)).body.data;
    expect(ready.ready).toBe(true);
    expect(ready.audience).toMatchObject({ candidates: 7, eligible: 2 });

    const res = await owner.post(api(`/campaigns/${campaignId}/launch`)).expect(200);
    expect(res.body.data.enrolled).toBe(2);
    const skipped = Object.fromEntries(res.body.data.skipped.map((s: { reason: string; count: number }) => [s.reason, s.count]));
    expect(skipped).toEqual({ not_found: 2, unsubscribed: 1, suppressed: 1, no_email: 1 });
    expect(res.body.data.skipped.find((s: { reason: string }) => s.reason === "no_email").label).toBe("no email address");
    expect(res.body.data.campaign.status).toBe("running");
    expect(res.body.data.campaign.enrollments.active).toBe(2);

    await owner.post(api(`/campaigns/${campaignId}/launch`)).expect(409);
    const again = await owner.post(api(`/campaigns/${campaignId}/enroll`)).send({ contactIds: [contacts.ada!] }).expect(200);
    expect(again.body.data).toEqual({ enrolled: 0, skipped: [{ reason: "already_enrolled", label: "already enrolled", count: 1 }] });
  });

  it("pauses, resumes and guards structure while running", async () => {
    const edit = await owner.patch(api(`/campaigns/${campaignId}`)).send({ settings: { dailyNewLimit: 10 } }).expect(409);
    expect(edit.body.error.message).toMatch(/Pause the campaign/);
    await owner.patch(api(`/campaigns/${campaignId}`)).send({ name: "Q4 outbound (renamed)" }).expect(200);

    expect((await owner.post(api(`/campaigns/${campaignId}/pause`)).expect(200)).body.data.status).toBe("paused");
    await owner.post(api(`/campaigns/${campaignId}/pause`)).expect(409);
    // A paused campaign's jobs do nothing.
    const e = await t.prisma.db.enrollment.findFirstOrThrow({ where: { workspaceId: w, campaignId, contactId: contacts.ada! } });
    const out = await t.app.get(EngineService).runStep(w, e.id, e.stepRun);
    expect(out).toMatchObject({ outcome: "noop", reason: "The campaign is not running" });
    await owner.patch(api(`/campaigns/${campaignId}`)).send({ settings: { dailyNewLimit: 10 } }).expect(200);
    expect((await owner.post(api(`/campaigns/${campaignId}/resume`)).expect(200)).body.data.status).toBe("running");
    await owner.post(api(`/campaigns/${campaignId}/resume`)).expect(409);
    await owner.delete(api(`/campaigns/${campaignId}`)).expect(409);
  });

  it("the engine sends the first email through SMTP and parks on the wait", async () => {
    const engine = t.app.get(EngineService);
    // Make both enrollments due now (launch staggers starts gapSeconds apart; gap is 0 here, but be explicit).
    await t.prisma.db.enrollment.updateMany({ where: { workspaceId: w, campaignId }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    const tick = await engine.tick();
    const mine = tick.claimed.filter((c) => c.workspaceId === w);
    expect(mine).toHaveLength(2);
    for (const c of mine) {
      const out = await engine.runStep(c.workspaceId, c.id, c.stepRun);
      expect(out.outcome).toBe("advanced");
    }
    const sent = await t.prisma.db.message.findMany({ where: { workspaceId: w, campaignId, direction: "outbound" } });
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.status === "sent" && m.sentAt)).toBe(true);
    expect(sent.map((m) => m.subject).sort()).toEqual(["Hello Ada", "Hello Grace"]);

    const list = (await owner.get(api(`/campaigns/${campaignId}/enrollments?status=active`)).expect(200)).body.data;
    expect(list.total).toBe(2);
    const ada = list.items.find((i: { contact: { id: string } }) => i.contact.id === contacts.ada);
    expect(ada.step).toEqual({ position: 1, type: "wait" });
    expect(new Date(ada.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    expect(ada.mailbox).toEqual({ id: mailboxId, email: "sender@growthdesk.test" });

    const stats = (await owner.get(api(`/campaigns/${campaignId}/step-stats`)).expect(200)).body.data;
    expect(stats[0]).toMatchObject({ position: 0, type: "email", executions: { succeeded: 2 }, messages: { sent: 2 } });
    expect(stats[1]).toMatchObject({ position: 1, type: "wait", waiting: 2, messages: null });
    expect(stats[2]).toMatchObject({ position: 2, waiting: 0, messages: { sent: 0 } });
    const c = (await owner.get(api(`/campaigns/${campaignId}`)).expect(200)).body.data;
    expect(c.stats).toMatchObject({ enrolled: 2, sent: 2, replied: 0, bounced: 0 });

    // A replayed job for the old stepRun is a no-op.
    const replay = await engine.runStep(mine[0]!.workspaceId, mine[0]!.id, mine[0]!.stepRun);
    expect(replay.outcome).toBe("noop");
  });

  it("stops one enrollment, then the whole campaign", async () => {
    const list = (await owner.get(api(`/campaigns/${campaignId}/enrollments`)).expect(200)).body.data;
    const grace = list.items.find((i: { contact: { id: string } }) => i.contact.id === contacts.grace);
    const stopped = await owner.post(api(`/campaigns/${campaignId}/enrollments/${grace.id}/stop`)).expect(200);
    expect(stopped.body.data.status).toBe("stopped");
    expect(stopped.body.data.nextRunAt).toBeNull();
    await owner.post(api(`/campaigns/${campaignId}/enrollments/${grace.id}/stop`)).expect(409);
    await other.post(`/v1/workspaces/${w2}/campaigns/${campaignId}/enrollments/${grace.id}/stop`).expect(404);

    const c = (await owner.post(api(`/campaigns/${campaignId}/stop`)).expect(200)).body.data;
    expect(c.status).toBe("canceled");
    expect(c.enrollments).toMatchObject({ active: 0, stopped: 2 });
    await owner.post(api(`/campaigns/${campaignId}/resume`)).expect(409);
    await owner.post(api(`/campaigns/${campaignId}/enroll`)).send({ contactIds: [contacts.ada!] }).expect(409);
    await owner.patch(api(`/campaigns/${campaignId}`)).send({ steps: [] }).expect(409);

    const copy = (await owner.post(api(`/campaigns/${campaignId}/duplicate`)).expect(201)).body.data;
    expect(copy).toMatchObject({ status: "draft", name: "Q4 outbound (renamed) (copy)", stepCount: 3 });
    expect(copy.mailboxes.map((m: { id: string }) => m.id)).toEqual([mailboxId]);

    await owner.delete(api(`/campaigns/${campaignId}`)).expect(200);
    await owner.get(api(`/campaigns/${campaignId}`)).expect(404);
  });
});
