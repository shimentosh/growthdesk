import { gunzipSync } from "node:zlib";
import request from "supertest";
import type { App } from "supertest/types.js";
import { addMember, bootApp, createWorkspace, setPlan, signUp, wait, type Agent, type TestApp } from "./helpers.js";
import { Queues, QUEUES, type QueueName } from "../src/queues/queues.js";
import { LifecycleProcessorsModule } from "../src/lifecycle/lifecycle.processors.js";
import { MaintenanceProcessorsModule } from "../src/worker/maintenance.processors.js";
import { SuppressionService } from "../src/crm/suppression.service.js";

/*
 * Account lifecycle and GDPR (docs/PRIVACY_OPS.md): signup consent, deleting
 * a workspace (inaccessible at once, campaigns paused, subscription
 * cancelled) and its purge, restore from platform admin, ownership transfer,
 * closing an account, per-contact export and erasure, and the full workspace
 * export. The lifecycle and imports processors run in-process on the test
 * Redis, as in production.
 */

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await wait(150);
  }
}

/** A binary response body as a Buffer (supertest only buffers text by default). */
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("Account lifecycle and GDPR", () => {
  let t: TestApp;
  let queues: Queues;

  async function run(queue: QueueName, name: string, data: Record<string, unknown> = {}) {
    const job = await queues.add(queue, name, data, { attempts: 1 });
    const q = queues.queue(queue);
    const state = await until(() => q.getJob(job.id!).then((j) => j?.getState()), (s) => s === "completed" || s === "failed");
    const finished = await q.getJob(job.id!);
    if (state === "failed") throw new Error(`${queue}/${name} failed: ${finished?.failedReason}`);
    return finished?.returnvalue as Record<string, unknown>;
  }

  beforeAll(async () => {
    t = await bootApp([LifecycleProcessorsModule, MaintenanceProcessorsModule]);
    queues = t.app.get(Queues);
  });
  afterAll(async () => t.close());

  describe("signup consent", () => {
    it("requires accepting the terms and records when, and which version", async () => {
      const agent = request.agent(t.app.getHttpServer() as App);
      const refused = await agent.post("/v1/auth/register").send({ name: "No Consent", email: "noconsent@acme.test", password: "Correct-horse-9" }).expect(400);
      expect(refused.body.error.fields.acceptTerms).toMatch(/Terms of Service/);
      const before = Date.now();
      await agent.post("/v1/auth/register").send({ name: "Consent", email: "consent@acme.test", password: "Correct-horse-9", acceptTerms: true }).expect(201);
      const user = await t.prisma.db.user.findUniqueOrThrow({ where: { email: "consent@acme.test" } });
      expect(user.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(user.termsVersion).toBe("default");
      const account = await agent.get("/v1/account").expect(200);
      expect(account.body.data.terms).toMatchObject({ version: "default", currentVersion: "default" });
      const me = await agent.get("/v1/auth/me").expect(200);
      expect(me.body.data.user.termsAcceptedAt).toBeTruthy();
    });

    it("lets an account without a record (Google, older accounts) accept later", async () => {
      const person = await signUp(t, "later@acme.test");
      await t.prisma.db.user.update({ where: { id: person.userId }, data: { termsAcceptedAt: null, termsVersion: "" } });
      expect((await person.get("/v1/account").expect(200)).body.data.terms.acceptedAt).toBeNull();
      await person.post("/v1/account/terms").send({}).expect(400);
      await person.post("/v1/account/terms").send({ accept: true }).expect(200);
      const user = await t.prisma.db.user.findUniqueOrThrow({ where: { id: person.userId } });
      expect(user.termsAcceptedAt).not.toBeNull();
      expect(user.termsVersion).toBe("default");
    });
  });

  describe("deleting a workspace", () => {
    let owner: Agent;
    let admin: Agent;
    let w: string;
    let keep: string;
    let campaignId: string;
    let apiKey: string;

    beforeAll(async () => {
      owner = await signUp(t, "del-owner@acme.test", "Dee Owner");
      w = await createWorkspace(owner, "Doomed Co");
      // Agency: room for a second workspace on the same billing account.
      await setPlan(t, w, "agency", "trialing");
      keep = await createWorkspace(owner, "Kept Co");
      admin = await addMember(t, owner, w, "del-admin@acme.test", "admin");
      await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Ada Doomed", email: "ada@doomed.test" }).expect(201);
      await owner.post(`/v1/workspaces/${keep}/contacts`).send({ fullName: "Kim Kept", email: "kim@kept.test" }).expect(201);
      const seq = await owner.post(`/v1/workspaces/${w}/sequences`).send({ name: "One", steps: [{ type: "email", config: { subject: "Hi", body: "Hello" } }] }).expect(201);
      const campaign = await owner.post(`/v1/workspaces/${w}/campaigns`).send({ name: "Running", fromSequenceId: seq.body.data.id }).expect(201);
      campaignId = campaign.body.data.id;
      await t.prisma.db.campaign.update({ where: { id: campaignId, workspaceId: w }, data: { status: "running" } });
      apiKey = (await owner.post(`/v1/workspaces/${w}/api-keys`).send({ name: "Zap", scopes: ["contacts:read"] }).expect(201)).body.data.secret;
      await t.http().get(`/v1/workspaces/${w}/contacts`).set("Authorization", `Bearer ${apiKey}`).expect(200);
    });

    it("is for the owner only, with the name typed exactly", async () => {
      const notOwner = await admin.post(`/v1/workspaces/${w}/delete`).send({ confirmName: "Doomed Co" }).expect(403);
      expect(notOwner.body.error.message).toMatch(/Only the workspace owner/);
      const wrong = await owner.post(`/v1/workspaces/${w}/delete`).send({ confirmName: "doomed co" }).expect(400);
      expect(wrong.body.error.fields.confirmName).toBeTruthy();
      expect((await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } })).deletedAt).toBeNull();
    });

    it("makes it unreachable at once, pauses campaigns and keeps the subscription while another workspace uses it", async () => {
      const res = await owner.post(`/v1/workspaces/${w}/delete`).send({ confirmName: "Doomed Co" }).expect(200);
      expect(res.body.data).toMatchObject({ deleted: true, campaignsPaused: 1, subscriptionCanceled: false });
      const purgeAfter = new Date(res.body.data.purgeAfter).getTime();
      expect(purgeAfter - Date.now()).toBeGreaterThan(29 * 86_400_000);

      await owner.get(`/v1/workspaces/${w}`).expect(404);
      await admin.get(`/v1/workspaces/${w}/contacts`).expect(404);
      await owner.post(`/v1/workspaces/${w}/delete`).send({ confirmName: "Doomed Co" }).expect(404);
      await t.http().get(`/v1/workspaces/${w}/contacts`).set("Authorization", `Bearer ${apiKey}`).expect(401);
      const me = await owner.get("/v1/auth/me").expect(200);
      expect(me.body.data.workspaces.map((x: { id: string }) => x.id)).toEqual([keep]);

      const row = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } });
      expect(row).toMatchObject({ status: "suspended", deletedById: owner.userId });
      expect((await t.prisma.db.campaign.findFirstOrThrow({ where: { id: campaignId, workspaceId: w } })).status).toBe("paused");
      const sub = await t.prisma.db.subscription.findFirstOrThrow({ where: { billingAccountId: row.billingAccountId } });
      expect(sub.status).toBe("trialing");
      // Members are told when the data goes.
      expect(t.mail.outbox.some((m) => m.to === "del-admin@acme.test" && m.subject === "Doomed Co was deleted")).toBe(true);
      const audit = await t.prisma.db.auditEvent.findFirst({ where: { workspaceId: w, action: "workspace.deleted" } });
      expect(audit?.actorUserId).toBe(owner.userId);
    });

    it("cancels the subscription when the account's last workspace goes", async () => {
      const res = await owner.post(`/v1/workspaces/${keep}/delete`).send({ confirmName: "Kept Co" }).expect(200);
      expect(res.body.data.subscriptionCanceled).toBe(true);
      const row = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: keep } });
      const sub = await t.prisma.db.subscription.findFirstOrThrow({ where: { billingAccountId: row.billingAccountId } });
      expect(sub.status).toBe("canceled");
    });

    it("can be restored by platform admin within the window", async () => {
      const staff = await signUp(t, "staff@platform.test", "Staff");
      await t.prisma.db.user.update({ where: { id: staff.userId }, data: { platformRole: "admin" } });
      await owner.post(`/v1/admin/workspaces/${keep}/restore`).expect(403);
      const listed = await staff.get("/v1/admin/workspaces?status=deleted").expect(200);
      expect(listed.body.data.items.map((x: { id: string }) => x.id).sort()).toEqual([w, keep].sort());
      const res = await staff.post(`/v1/admin/workspaces/${keep}/restore`).expect(200);
      expect(res.body.data).toEqual({ restored: true, stillSuspended: false });
      const ws = await owner.get(`/v1/workspaces/${keep}`).expect(200);
      expect(ws.body.data.status).toBe("active");
      await staff.post(`/v1/admin/workspaces/${keep}/restore`).expect(409);
      // Platform admin can delete on a customer's behalf, with a reason.
      await staff.post(`/v1/admin/workspaces/${keep}/delete`).send({ reason: "Customer asked by email" }).expect(200);
      await owner.get(`/v1/workspaces/${keep}`).expect(404);
      expect(await t.prisma.db.auditEvent.count({ where: { workspaceId: keep, action: "platform.workspace_deleted" } })).toBe(1);
      await staff.post(`/v1/admin/workspaces/${keep}/restore`).expect(200);
    });

    it("is purged by the sweep once the window has passed, and never restored after", async () => {
      // Not due yet: nothing happens.
      expect((await run(QUEUES.lifecycle, "purge-sweep")).purged).toBe(0);
      await t.prisma.db.workspace.update({ where: { id: w }, data: { purgeAfter: new Date(Date.now() - 1000) } });
      const staff = await signUp(t, "staff2@platform.test", "Staff Two");
      await t.prisma.db.user.update({ where: { id: staff.userId }, data: { platformRole: "admin" } });
      await staff.post(`/v1/admin/workspaces/${w}/restore`).expect(409);

      expect((await run(QUEUES.lifecycle, "purge-sweep")).purged).toBe(1);
      expect(await t.prisma.db.workspace.findUnique({ where: { id: w } })).toBeNull();
      expect(await t.prisma.unscoped.contact.count({ where: { workspaceId: w } })).toBe(0);
      expect(await t.prisma.unscoped.campaign.count({ where: { workspaceId: w } })).toBe(0);
      expect(await t.prisma.unscoped.pipeline.count({ where: { workspaceId: w } })).toBe(0);
      expect(await t.prisma.db.membership.count({ where: { workspaceId: w } })).toBe(0);
      expect(await t.prisma.db.apiKey.count({ where: { workspaceId: w } })).toBe(0);
      // The restored workspace is untouched.
      expect(await t.prisma.db.contact.count({ where: { workspaceId: keep } })).toBe(1);
      expect(await t.prisma.db.auditEvent.count({ where: { workspaceId: w, action: "workspace.purged" } })).toBe(1);
    });
  });

  describe("transferring ownership", () => {
    let owner: Agent;
    let mate: Agent;
    let w: string;

    beforeAll(async () => {
      owner = await signUp(t, "xfer-owner@acme.test", "Old Owner");
      w = await createWorkspace(owner, "Handover Co");
      mate = await addMember(t, owner, w, "xfer-mate@acme.test", "member");
    });

    it("is for the owner only and needs a member of this workspace", async () => {
      const members = (await owner.get(`/v1/workspaces/${w}/members`).expect(200)).body.data.members as { id: string; userId: string }[];
      const mateRow = members.find((m) => m.userId === mate.userId)!;
      await mate.post(`/v1/workspaces/${w}/transfer-ownership`).send({ membershipId: mateRow.id }).expect(403);
      await owner.post(`/v1/workspaces/${w}/transfer-ownership`).send({ membershipId: "00000000-0000-4000-8000-000000000000" }).expect(404);
    });

    it("hands over the workspace and its single-workspace billing account", async () => {
      const members = (await owner.get(`/v1/workspaces/${w}/members`).expect(200)).body.data.members as { id: string; userId: string }[];
      const mateRow = members.find((m) => m.userId === mate.userId)!;
      const res = await owner.post(`/v1/workspaces/${w}/transfer-ownership`).send({ membershipId: mateRow.id }).expect(200);
      expect(res.body.data).toEqual({ ownerMembershipId: mateRow.id, billingAccountMoved: true });
      const after = (await mate.get(`/v1/workspaces/${w}/members`).expect(200)).body.data.members as { userId: string; role: string }[];
      expect(after.find((m) => m.userId === mate.userId)?.role).toBe("owner");
      expect(after.find((m) => m.userId === owner.userId)?.role).toBe("admin");
      const ws = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w }, include: { billingAccount: true } });
      expect(ws.billingAccount).toMatchObject({ ownerId: mate.userId, billingEmail: "xfer-mate@acme.test" });
      expect(t.mail.outbox.some((m) => m.to === "xfer-mate@acme.test" && m.subject === "You now own Handover Co")).toBe(true);
      // The old owner can no longer delete it; the new owner holds billing.manage.
      await owner.post(`/v1/workspaces/${w}/delete`).send({ confirmName: "Handover Co" }).expect(403);
      expect((await mate.get(`/v1/workspaces/${w}`).expect(200)).body.data.permissions).toContain("billing.manage");
      expect((await owner.get(`/v1/workspaces/${w}`).expect(200)).body.data.permissions).not.toContain("billing.manage");
    });
  });

  describe("closing an account", () => {
    let owner: Agent;
    let leaver: Agent;
    let w: string;

    beforeAll(async () => {
      owner = await signUp(t, "close-owner@acme.test", "Owner Close");
      w = await createWorkspace(owner, "Closing Co");
      await setPlan(t, w, "growth");
      leaver = await addMember(t, owner, w, "leaver@acme.test", "admin");
    });

    it("is refused while the person owns a workspace", async () => {
      const summary = await owner.get("/v1/account").expect(200);
      expect(summary.body.data.close).toMatchObject({ allowed: false, needsPassword: true, blockers: [{ workspaceId: w, name: "Closing Co", reason: "owner" }] });
      const res = await owner.post("/v1/account/close").send({ confirmEmail: "close-owner@acme.test", password: "Correct-horse-9" }).expect(409);
      expect(res.body.error.message).toMatch(/You still own Closing Co/);
    });

    it("gives the person a copy of their own account data", async () => {
      const res = await leaver.get("/v1/account/export").expect(200);
      expect(res.headers["content-disposition"]).toContain("my-account-data.json");
      const doc = JSON.parse(res.text);
      expect(doc).toMatchObject({ format: "growthdesk-account-export", user: { id: leaver.userId, email: "leaver@acme.test", googleLinked: false } });
      expect(doc.workspaces).toEqual([expect.objectContaining({ id: w, name: "Closing Co", role: "admin" })]);
      expect(doc.sessions.length).toBeGreaterThan(0);
      expect(JSON.stringify(doc)).not.toMatch(/passwordHash|tokenHash/);
    });

    it("checks the typed email and the password", async () => {
      const email = await leaver.post("/v1/account/close").send({ confirmEmail: "someone@else.test", password: "Correct-horse-9" }).expect(400);
      expect(email.body.error.fields.confirmEmail).toBeTruthy();
      const pw = await leaver.post("/v1/account/close").send({ confirmEmail: "leaver@acme.test", password: "Wrong-horse-99" }).expect(400);
      expect(pw.body.error.fields.password).toBeTruthy();
    });

    it("anonymises the person, ends their sessions, revokes their keys and leaves their workspaces", async () => {
      const key = await leaver.post(`/v1/workspaces/${w}/api-keys`).send({ name: "Mine", scopes: ["contacts:read"] }).expect(201);
      const contact = await leaver.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Owned By Leaver", email: "obl@x.test", ownerId: leaver.userId }).expect(201);
      expect((await leaver.get("/v1/account").expect(200)).body.data.close.allowed).toBe(true);
      const res = await leaver.post("/v1/account/close").send({ confirmEmail: "leaver@acme.test", password: "Correct-horse-9" }).expect(200);
      expect(res.body.data).toMatchObject({ closed: true, apiKeysRevoked: 1 });
      await leaver.get("/v1/auth/me").expect(401);

      const user = await t.prisma.db.user.findUniqueOrThrow({ where: { id: leaver.userId } });
      expect(user).toMatchObject({ email: `deleted+${leaver.userId}@invalid`, name: "", passwordHash: null });
      expect(user.closedAt).not.toBeNull();
      expect(await t.prisma.db.membership.count({ where: { userId: leaver.userId } })).toBe(0);
      expect(await t.prisma.db.session.count({ where: { userId: leaver.userId, revokedAt: null } })).toBe(0);
      expect((await t.prisma.db.apiKey.findUniqueOrThrow({ where: { id: key.body.data.id } })).revokedAt).not.toBeNull();
      // Their records stay in the workspace, unassigned.
      const kept = await t.prisma.db.contact.findFirstOrThrow({ where: { id: contact.body.data.id, workspaceId: w } });
      expect(kept.ownerId).toBeNull();
      expect(t.mail.outbox.some((m) => m.to === "leaver@acme.test" && m.template === "account_deleted")).toBe(true);
      // The address is free again, and signing in with the old one fails.
      await t.http().post("/v1/auth/login").send({ email: "leaver@acme.test", password: "Correct-horse-9" }).expect(401);
    });
  });

  describe("one contact's data (GDPR)", () => {
    let owner: Agent;
    let manager: Agent;
    let w: string;
    let contactId: string;

    beforeAll(async () => {
      owner = await signUp(t, "gdpr-owner@acme.test", "Gail Owner");
      w = await createWorkspace(owner, "Privacy Co");
      await setPlan(t, w, "growth");
      manager = await addMember(t, owner, w, "gdpr-manager@acme.test", "manager");
      const c = await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Erin Erased", email: "Erin@Subject.test", phone: "+447700900123" }).expect(201);
      contactId = c.body.data.id;
      await owner.post(`/v1/workspaces/${w}/contacts/${contactId}/notes`).send({ body: "Asked about pricing" }).expect(201);
      // An earlier unsubscribe left the address on the list in plain text.
      await t.app.get(SuppressionService).add(w, "email", "erin@subject.test", "unsubscribed", "test");
      await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Other Person", email: "other@subject.test" }).expect(201);
    });

    it("exports everything held about the person as JSON", async () => {
      const res = await owner.get(`/v1/workspaces/${w}/contacts/${contactId}/privacy-export`).expect(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.headers["content-disposition"]).toContain(`contact-${contactId}.json`);
      const doc = JSON.parse(res.text);
      expect(doc).toMatchObject({ format: "growthdesk-contact-export", contact: { id: contactId, email: "erin@subject.test" } });
      expect(doc.notes.map((n: { body: string }) => n.body)).toEqual(["Asked about pricing"]);
      expect(doc.identifiers.length).toBeGreaterThanOrEqual(2);
      expect(doc.suppressions).toHaveLength(1);
      expect(await t.prisma.db.auditEvent.count({ where: { workspaceId: w, action: "contact.data_exported" } })).toBe(1);
    });

    it("needs contacts.erase to erase, and ERASE typed out", async () => {
      await manager.post(`/v1/workspaces/${w}/contacts/${contactId}/erase`).send({ confirm: "ERASE" }).expect(403);
      await owner.post(`/v1/workspaces/${w}/contacts/${contactId}/erase`).send({ confirm: "erase" }).expect(400);
    });

    it("hard-deletes the contact and keeps only a hashed suppression entry", async () => {
      const res = await owner.post(`/v1/workspaces/${w}/contacts/${contactId}/erase`).send({ confirm: "ERASE", reason: "Email request" }).expect(200);
      expect(res.body.data).toMatchObject({ erased: true, contacts: 1, suppressed: 2 });
      expect(await t.prisma.db.contact.findFirst({ where: { id: contactId, workspaceId: w } })).toBeNull();
      expect(await t.prisma.db.note.count({ where: { workspaceId: w, contactId } })).toBe(0);
      expect(await t.prisma.db.contactIdentifier.count({ where: { workspaceId: w, contactId } })).toBe(0);
      const rows = await t.prisma.db.suppression.findMany({ where: { workspaceId: w } });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.value.startsWith("erased:") && r.reason === "erased")).toBe(true);
      expect(JSON.stringify(rows)).not.toMatch(/erin|447700900123/i);
      const audit = await t.prisma.db.auditEvent.findFirstOrThrow({ where: { workspaceId: w, action: "contact.erased" } });
      expect(JSON.stringify(audit.metadata)).not.toMatch(/erin/i);
      // The other contact is untouched.
      expect(await t.prisma.db.contact.count({ where: { workspaceId: w } })).toBe(1);
    });

    it("never lets the person back in, and never lets them be contacted", async () => {
      const again = await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Erin Again", email: "erin@subject.test" }).expect(409);
      expect(again.body.error.code).toBe("erased_contact");
      await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "By Phone", phone: "+44 7700 900123" }).expect(409);

      const csv = ["Name,Email", "Erin Imported,ERIN@subject.test", "New Person,new@subject.test"].join("\n");
      const started = await owner.post(`/v1/workspaces/${w}/imports`).send({ fileName: "leads.csv", csv, mapping: { Name: "fullName", Email: "email" } }).expect(201);
      const imp = await until(
        () => owner.get(`/v1/workspaces/${w}/imports/${started.body.data.id}`).then((r) => r.body.data),
        (d) => d.status === "completed" || d.status === "failed",
      );
      expect(imp).toMatchObject({ status: "completed", createdCount: 1, failedCount: 1 });
      expect(imp.errors[0].message).toMatch(/erased/);

      const reason = await t.app.get(SuppressionService).check(w, { email: "erin@subject.test" });
      expect(reason).toMatch(/erased/);
      expect(await t.app.get(SuppressionService).check(w, { email: "new@subject.test" })).toBeNull();
      // The hash is per workspace: the same address elsewhere is not affected.
      const elsewhere = await createWorkspace(owner, "Elsewhere Co");
      await owner.post(`/v1/workspaces/${elsewhere}/contacts`).send({ fullName: "Erin Elsewhere", email: "erin@subject.test" }).expect(201);
    });
  });

  describe("full workspace export", () => {
    let owner: Agent;
    let viewer: Agent;
    let outsider: Agent;
    let w: string;

    beforeAll(async () => {
      owner = await signUp(t, "export-owner@acme.test", "Exa Owner");
      w = await createWorkspace(owner, "Export Co");
      viewer = await addMember(t, owner, w, "export-viewer@acme.test", "viewer");
      outsider = await signUp(t, "export-outsider@other.test");
      await createWorkspace(outsider, "Outsider Co");
      for (let i = 0; i < 3; i++) await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: `Person ${i}`, email: `p${i}@export.test` }).expect(201);
    });

    it("needs data.export", async () => {
      await viewer.post(`/v1/workspaces/${w}/exports`).expect(403);
      await outsider.post(`/v1/workspaces/${w}/exports`).expect(404);
    });

    it("builds a gzipped JSON file in the background and notifies the requester", async () => {
      const req = await owner.post(`/v1/workspaces/${w}/exports`).expect(201);
      const id = req.body.data.id as string;
      expect(req.body.data.status).toBe("pending");
      const ready = await until(
        () => owner.get(`/v1/workspaces/${w}/exports`).then((r) => r.body.data.items.find((e: { id: string }) => e.id === id)),
        (e) => e?.status === "ready" || e?.status === "failed",
      );
      expect(ready).toMatchObject({ status: "ready", counts: { contacts: 3, members: 2 } });
      expect(ready.fileName).toMatch(/^export-co-.+-export-\d{4}-\d{2}-\d{2}\.json\.gz$/);
      const note = await t.prisma.db.notification.findFirst({ where: { workspaceId: w, userId: owner.userId, type: "export.ready" } });
      expect(note?.link).toBe(`/w/${w}/settings/data`);
      expect(t.mail.outbox.some((m) => m.to === "export-owner@acme.test" && m.subject === "Your workspace export is ready")).toBe(true);

      const file = await owner.get(`/v1/workspaces/${w}/exports/${id}/download`).buffer(true).parse(binary).expect(200);
      expect(file.headers["content-type"]).toBe("application/gzip");
      const doc = JSON.parse(gunzipSync(file.body as Buffer).toString("utf8"));
      expect(doc).toMatchObject({ format: "growthdesk-workspace-export", workspace: { id: w, name: "Export Co" } });
      expect(doc.sections.contacts.map((c: { email: string }) => c.email).sort()).toEqual(["p0@export.test", "p1@export.test", "p2@export.test"]);
      expect(doc.sections.pipelines).toHaveLength(1);
      expect(doc.members.map((m: { email: string }) => m.email).sort()).toEqual(["export-owner@acme.test", "export-viewer@acme.test"]);

      await viewer.get(`/v1/workspaces/${w}/exports/${id}/download`).expect(403);
      await outsider.get(`/v1/workspaces/${w}/exports/${id}/download`).expect(404);
    });

    it("stops serving the file once it expires, and the cleanup deletes it", async () => {
      const row = await t.prisma.db.workspaceExport.findFirstOrThrow({ where: { workspaceId: w, status: "ready" } });
      await t.prisma.db.workspaceExport.update({ where: { id: row.id, workspaceId: w }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await owner.get(`/v1/workspaces/${w}/exports/${row.id}/download`).expect(404);
      expect((await run(QUEUES.lifecycle, "export-cleanup")).expired).toBe(1);
      expect((await t.prisma.db.workspaceExport.findFirstOrThrow({ where: { id: row.id, workspaceId: w } })).status).toBe("expired");
    });
  });
});
