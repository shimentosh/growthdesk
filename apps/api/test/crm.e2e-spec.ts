import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { ImportsService } from "../src/crm/imports.service.js";

describe("Contacts, companies, dedupe, import", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "crm-owner@acme.test");
    w = await createWorkspace(owner, "CRM Co");
    await setPlan(t, w, "growth");
  });
  afterAll(async () => t.close());

  it("creates a contact with normalised identifiers and links a company", async () => {
    const res = await owner
      .post(`/v1/workspaces/${w}/contacts`)
      .send({ fullName: "Ada Lovelace", email: "  ADA@Engines.co ", phone: "+1 (415) 555-2671", companyName: "Analytical Engines Ltd", tags: ["vip"] })
      .expect(201);
    const c = res.body.data;
    expect(c.email).toBe("ada@engines.co");
    expect(c.phone).toBe("+14155552671");
    expect(c.firstName).toBe("Ada");
    expect(c.company.name).toBe("Analytical Engines Ltd");
    expect(c.tags.map((x: { name: string }) => x.name)).toEqual(["vip"]);
    expect(c.identifiers.map((i: { kind: string }) => i.kind).sort()).toEqual(["email", "phone"]);
    // Same email again is refused with the existing id.
    const dup = await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Ada L", email: "ada@engines.co" }).expect(409);
    expect(dup.body.error.details.contactId).toBe(c.id);
  });

  it("filters, searches and paginates", async () => {
    for (let i = 0; i < 5; i++) {
      await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: `Person ${i}`, email: `p${i}@list.test`, status: i % 2 ? "contacted" : "new" }).expect(201);
    }
    const all = await owner.get(`/v1/workspaces/${w}/contacts?pageSize=3`).expect(200);
    expect(all.body.data.items).toHaveLength(3);
    expect(all.body.data.total).toBe(6);
    const q = await owner.get(`/v1/workspaces/${w}/contacts?filter=${encodeURIComponent(JSON.stringify({ q: "person 3" }))}`).expect(200);
    expect(q.body.data.items.map((c: { fullName: string }) => c.fullName)).toEqual(["Person 3"]);
    const contacted = await owner.get(`/v1/workspaces/${w}/contacts?filter=${encodeURIComponent(JSON.stringify({ status: ["contacted"] }))}`).expect(200);
    expect(contacted.body.data.total).toBe(2);
  });

  it("imports a CSV: maps fields, merges existing contacts by email, reports bad rows", async () => {
    const csv = [
      "Name,Email,Company,Phone,Tags,Lead ID",
      "Ada Lovelace,ada@engines.co,Analytical Engines Ltd,,imported,bos-1",
      "Grace Hopper,grace@navy.test,US Navy,+1 202 555 0100,imported;navy,",
      ",,,,,",
      "No Contact Info,,Acme,,,",
      "Alan Turing,ALAN@bletchley.test,Bletchley,,,",
    ].join("\n");
    const preview = await owner.post(`/v1/workspaces/${w}/imports/preview`).send({ csv }).expect(200);
    expect(preview.body.data.suggested).toMatchObject({ Name: "fullName", Email: "email", Company: "company", Phone: "phone", Tags: "tags", "Lead ID": "externalId" });
    const started = await owner
      .post(`/v1/workspaces/${w}/imports`)
      .send({ fileName: "leads.csv", csv, mapping: preview.body.data.suggested, tags: ["csv"], onDuplicate: "update" })
      .expect(201);
    // Process in-process (the worker does this in production).
    await t.app.get(ImportsService).process(w, started.body.data.id);
    const imp = await owner.get(`/v1/workspaces/${w}/imports/${started.body.data.id}`).expect(200);
    expect(imp.body.data.status).toBe("completed");
    expect(imp.body.data.createdCount).toBe(3); // Grace, No Contact Info (name only), Alan
    expect(imp.body.data.updatedCount + imp.body.data.skippedCount).toBe(1); // Ada merged
    expect(imp.body.data.failedCount).toBe(1); // the empty row
    const ada = await t.prisma.db.contact.findMany({ where: { workspaceId: w, email: "ada@engines.co", deletedAt: null } });
    expect(ada).toHaveLength(1);
    const sources = await t.prisma.db.contactSource.findMany({ where: { workspaceId: w, contactId: ada[0]!.id } });
    expect(sources.map((s) => s.source)).toContain("csv");
    const alan = await t.prisma.db.contact.findFirst({ where: { workspaceId: w, email: "alan@bletchley.test" }, include: { tags: { include: { tag: true } } } });
    expect(alan?.tags.map((x) => x.tag.name)).toContain("csv");
  });

  it("flags likely duplicates and merges them, moving related records", async () => {
    const a = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Linus Torvalds", email: "linus@kernel.test", companyName: "Kernel Org" }).expect(201)).body.data;
    const b = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Linus Torvalds", email: "lt@kernel.test", jobTitle: "Maintainer", companyName: "Kernel Org" }).expect(201)).body.data;
    await owner.post(`/v1/workspaces/${w}/contacts/${b.id}/notes`).send({ body: "Met at conference" }).expect(201);
    const dups = await owner.get(`/v1/workspaces/${w}/contacts/duplicates`).expect(200);
    expect(dups.body.data.some((d: { a: { id: string }; b: { id: string } }) => [d.a.id, d.b.id].sort().join() === [a.id, b.id].sort().join())).toBe(true);
    const merged = await owner.post(`/v1/workspaces/${w}/contacts/merge`).send({ primaryId: a.id, duplicateIds: [b.id] }).expect(200);
    expect(merged.body.data.jobTitle).toBe("Maintainer");
    expect(merged.body.data.identifiers.map((i: { value: string }) => i.value).sort()).toEqual(["linus@kernel.test", "lt@kernel.test"]);
    await owner.get(`/v1/workspaces/${w}/contacts/${b.id}`).expect(404);
    const notes = await owner.get(`/v1/workspaces/${w}/contacts/${a.id}/notes`).expect(200);
    expect(notes.body.data.map((n: { body: string }) => n.body)).toContain("Met at conference");
  });

  it("exports CSV with spreadsheet-formula protection", async () => {
    await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "=HYPERLINK(evil)", email: "formula@x.test" }).expect(201);
    const res = await owner.get(`/v1/workspaces/${w}/contacts/export`).expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("'=HYPERLINK(evil)");
  });

  it("keeps workspaces apart and respects member visibility", async () => {
    const outsider = await signUp(t, "crm-outsider@other.test");
    const ow = await createWorkspace(outsider, "Other Co");
    const anyContact = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w } });
    await outsider.get(`/v1/workspaces/${ow}/contacts/${anyContact.id}`).expect(404);
    await outsider.patch(`/v1/workspaces/${ow}/contacts/${anyContact.id}`).send({ jobTitle: "x" }).expect(404);
    const list = await outsider.get(`/v1/workspaces/${ow}/contacts`).expect(200);
    expect(list.body.data.total).toBe(0);

    // Custom role permissions are an Agency feature: refused on Growth, allowed on Agency.
    const refused = await owner.put(`/v1/workspaces/${w}/role-permissions`).send({ role: "member", permissions: ["contacts.read"] }).expect(402);
    expect(refused.body.error.details.feature).toBe("customRoles");
    await setPlan(t, w, "agency");
    // A member without records.view_all sees only their own and unowned contacts.
    await owner.put(`/v1/workspaces/${w}/role-permissions`).send({ role: "member", permissions: ["contacts.read", "contacts.write"] }).expect(200);
    const member = await addMember(t, owner, w, "crm-member@acme.test", "member");
    const ownedByOwner = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Owned", email: "owned@x.test", ownerId: owner.userId }).expect(201)).body.data;
    await member.get(`/v1/workspaces/${w}/contacts/${ownedByOwner.id}`).expect(404);
    await member.delete(`/v1/workspaces/${w}/contacts/${ownedByOwner.id}`).expect(403);
  });

  it("enforces the contact limit of the plan", async () => {
    const o2 = await signUp(t, "limit@tiny.test");
    const w2 = await createWorkspace(o2, "Tiny");
    await setPlan(t, w2, "free");
    const plan = await t.prisma.db.plan.findUniqueOrThrow({ where: { key: "free" } });
    await t.prisma.db.plan.update({ where: { id: plan.id }, data: { limits: { ...(plan.limits as object), contacts: 2 } } });
    await o2.post(`/v1/workspaces/${w2}/contacts`).send({ fullName: "One", email: "1@t.test" }).expect(201);
    await o2.post(`/v1/workspaces/${w2}/contacts`).send({ fullName: "Two", email: "2@t.test" }).expect(201);
    const refused = await o2.post(`/v1/workspaces/${w2}/contacts`).send({ fullName: "Three", email: "3@t.test" }).expect(402);
    expect(refused.body.error.details).toMatchObject({ limit: "contacts", allowed: 2, used: 2 });
    await t.prisma.db.plan.update({ where: { id: plan.id }, data: { limits: plan.limits as object } });
  });
});

describe("Pipeline, deals and tasks", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "deals@acme.test");
    w = await createWorkspace(owner, "Deals Co");
  });
  afterAll(async () => t.close());

  it("creates a deal in the first open stage, moves it with history, and closes on Won", async () => {
    const contact = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Buyer Bob", email: "bob@buyer.test" }).expect(201)).body.data;
    const pipelines = (await owner.get(`/v1/workspaces/${w}/pipelines`).expect(200)).body.data;
    const stages = pipelines[0].stages as { id: string; name: string; kind: string }[];
    const deal = (await owner.post(`/v1/workspaces/${w}/deals`).send({ name: "Bob's deal", contactId: contact.id, value: 4200 }).expect(201)).body.data;
    expect(deal.stage.name).toBe("New Lead");
    expect(deal.value).toBe(4200);
    const qualified = stages.find((s) => s.name === "Qualified")!;
    await owner.post(`/v1/workspaces/${w}/deals/${deal.id}/move`).send({ stageId: qualified.id }).expect(200);
    const won = stages.find((s) => s.kind === "won")!;
    const closed = (await owner.post(`/v1/workspaces/${w}/deals/${deal.id}/move`).send({ stageId: won.id, reason: "Great fit" }).expect(200)).body.data;
    expect(closed.status).toBe("won");
    expect(closed.wonReason).toBe("Great fit");
    expect(closed.history).toHaveLength(3);
    const events = await t.prisma.db.domainEvent.findMany({ where: { workspaceId: w, subjectId: deal.id } });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["deal.created", "deal.stage_changed", "deal.won"]));
    const updated = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: contact.id } });
    expect(updated.status).toBe("customer");
  });

  it("refuses removing a stage that still holds deals and requires won/lost stages", async () => {
    const p = (await owner.get(`/v1/workspaces/${w}/pipelines`).expect(200)).body.data[0];
    const occupied = p.stages.find((s: { name: string }) => s.name === "Won");
    const remaining = p.stages.filter((s: { id: string }) => s.id !== occupied.id).map((s: { id: string; name: string; kind: string; probability: number }) => ({ id: s.id, name: s.name, kind: s.kind, probability: s.probability }));
    await owner.put(`/v1/workspaces/${w}/pipelines/${p.id}`).send({ name: p.name, stages: remaining }).expect(400);
    const noLost = p.stages.filter((s: { kind: string }) => s.kind !== "lost").map((s: { id: string; name: string; kind: string; probability: number }) => ({ id: s.id, name: s.name, kind: s.kind, probability: s.probability }));
    await owner.put(`/v1/workspaces/${w}/pipelines/${p.id}`).send({ name: p.name, stages: noLost }).expect(400);
    const renamed = p.stages.map((s: { id: string; name: string; kind: string; probability: number }) => ({ id: s.id, name: s.name === "New Lead" ? "Inbound" : s.name, kind: s.kind, probability: s.probability }));
    const res = await owner.put(`/v1/workspaces/${w}/pipelines/${p.id}`).send({ name: "Sales", stages: renamed }).expect(200);
    expect(res.body.data.stages[0].name).toBe("Inbound");
  });

  it("runs the daily task queue views in the workspace time zone and sends reminders once", async () => {
    const now = Date.now();
    await owner.post(`/v1/workspaces/${w}/tasks`).send({ title: "Overdue call", type: "call", dueAt: new Date(now - 3 * 3600_000).toISOString() }).expect(201);
    await owner.post(`/v1/workspaces/${w}/tasks`).send({ title: "Later", type: "follow_up", dueAt: new Date(now + 5 * 86_400_000).toISOString() }).expect(201);
    const reminded = (await owner.post(`/v1/workspaces/${w}/tasks`).send({ title: "Remind me", remindAt: new Date(now - 1000).toISOString() }).expect(201)).body.data;
    const overdue = await owner.get(`/v1/workspaces/${w}/tasks?view=overdue`).expect(200);
    expect(overdue.body.data.items.map((x: { title: string }) => x.title)).toContain("Overdue call");
    const upcoming = await owner.get(`/v1/workspaces/${w}/tasks?view=upcoming`).expect(200);
    expect(upcoming.body.data.items.map((x: { title: string }) => x.title)).toContain("Later");
    const { TasksService } = await import("../src/tasks/tasks.service.js");
    const tasks = t.app.get(TasksService);
    expect(await tasks.sendReminders()).toBeGreaterThanOrEqual(1);
    await tasks.sendReminders();
    const notes = await t.prisma.db.notification.findMany({ where: { workspaceId: w, type: "task.reminder" } });
    expect(notes.filter((n) => n.link.includes(reminded.id))).toHaveLength(1);
    const summary = await owner.get(`/v1/workspaces/${w}/tasks/summary`).expect(200);
    expect(summary.body.data.counts.overdue).toBeGreaterThanOrEqual(1);
    await owner.patch(`/v1/workspaces/${w}/tasks/${reminded.id}`).send({ status: "done" }).expect(200);
    const done = await owner.get(`/v1/workspaces/${w}/tasks?view=completed`).expect(200);
    expect(done.body.data.items.map((x: { id: string }) => x.id)).toContain(reminded.id);
  });

  it("does not let a viewer change deals or a member assign tasks to others", async () => {
    await setPlan(t, w, "growth");
    const viewer = await addMember(t, owner, w, "deal-viewer@acme.test", "viewer");
    await viewer.get(`/v1/workspaces/${w}/deals`).expect(200);
    await viewer.post(`/v1/workspaces/${w}/deals`).send({ name: "Nope" }).expect(403);
    const member = await addMember(t, owner, w, "deal-member@acme.test", "member");
    await member.post(`/v1/workspaces/${w}/tasks`).send({ title: "For the boss", assigneeId: owner.userId }).expect(403);
    await member.post(`/v1/workspaces/${w}/tasks`).send({ title: "For me" }).expect(201);
  });
});
