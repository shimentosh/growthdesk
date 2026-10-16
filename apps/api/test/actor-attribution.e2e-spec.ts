import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { DispatcherService } from "../src/automation/dispatcher.service.js";
import { WorkflowExecutor } from "../src/automation/workflow-executor.service.js";

/*
 * "Who did it", everywhere: a teammate, an AI agent acting for one (MCP), a
 * workflow, an integration (API key) or the system — on timeline entries,
 * in the team activity feed (with its per-person scoping and summary), and
 * on the changes that used to go unrecorded or unannounced: reassignments
 * (single and bulk), deal edits, wins and deletions, conversation hand-offs
 * and contact exports.
 */

const data = (r: unknown) => JSON.parse(((r as CallToolResult).content[0] as { text: string }).text) as Record<string, any>;

describe("Actor attribution and the team activity feed", () => {
  let t: TestApp;
  let owner: Agent;
  let rep: Agent;
  let w: string;
  let ownerId: string;
  let repId: string;
  let url: string;
  const clients: Client[] = [];
  const api = (p: string) => `/v1/workspaces/${w}${p}`;
  const activityOf = (contactId: string) => t.prisma.db.activity.findMany({ where: { workspaceId: w, contactId }, orderBy: { occurredAt: "asc" } });
  const notificationsOf = (userId: string) => t.prisma.db.notification.findMany({ where: { workspaceId: w, userId }, orderBy: { createdAt: "asc" } });
  const contact = async (fullName: string, email: string) => (await owner.post(api("/contacts")).send({ fullName, email }).expect(201)).body.data.id as string;

  beforeAll(async () => {
    t = await bootApp();
    await t.app.listen(0, "127.0.0.1");
    url = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}/mcp`;
    owner = await signUp(t, "attr-owner@acme.test", "Olivia Owner");
    w = await createWorkspace(owner, "Attribution Co");
    await setPlan(t, w, "agency");
    rep = await addMember(t, owner, w, "attr-rep@acme.test", "member");
    ownerId = (await owner.get("/v1/auth/me").expect(200)).body.data.user.id;
    repId = (await rep.get("/v1/auth/me").expect(200)).body.data.user.id;
  });
  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await t.close();
  });

  it("labels a teammate's change as theirs, and tells the new owner", async () => {
    const id = await contact("Tara Teammate", "tara@acme.example");
    await owner.patch(api(`/contacts/${id}`)).send({ ownerId: repId }).expect(200);
    const assigned = (await activityOf(id)).find((a) => a.type === "contact.assigned")!;
    expect(assigned).toMatchObject({ actorType: "user", actorId: ownerId, actorName: "Olivia Owner", summary: expect.stringContaining("Owner →") });
    expect((await notificationsOf(repId)).map((n) => n.title)).toContain("Tara Teammate is now yours");
  });

  it("labels an API key's leads as the integration", async () => {
    const key = (await owner.post(api("/api-keys")).send({ name: "Clientdesk", scopes: ["leads:write"] }).expect(201)).body.data.secret;
    const res = await t.http().post(api("/leads")).set({ Authorization: `Bearer ${key}` }).send({ source: "clientdesk", leads: [{ externalId: "led_1", fullName: "Ivy Integration", email: "ivy@site.example" }] }).expect(200);
    const created = await activityOf(res.body.data.results[0].contactId);
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((a) => a.actorType === "integration" && a.actorName === "Clientdesk" && a.actorRef.startsWith("api_key:"))).toBe(true);
  });

  it("labels what an AI agent does as the agent, acting for the teammate whose token it uses", async () => {
    const secret = (await owner.post(api("/mcp/tokens")).send({ name: "Claude Desktop", access: "build" }).expect(201)).body.data.secret as string;
    const client = new Client({ name: "attribution-e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
    clients.push(client);
    const created = data(await client.callTool({ name: "create_contact", arguments: { fullName: "Ada Agent", email: "ada@agent.example" } }));
    const rows = await activityOf(created.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) expect(a).toMatchObject({ actorType: "ai_agent", onBehalfOfId: ownerId, actorRef: expect.stringMatching(/^mcp:/) });
    expect(rows[0]!.actorName).toBeTruthy();
  });

  it("labels a workflow's actions as the workflow", async () => {
    await owner
      .post(api("/workflows"))
      .send({ name: "Tag new contacts", trigger: "contact.created", enabled: true, conditions: [], actions: [{ type: "add_tag", config: { tags: ["Auto"] } }, { type: "create_task", config: { title: "Say hello", assignTo: "owner" } }] })
      .expect(201);
    const id = await contact("Wes Workflow", "wes@acme.example");
    for (let i = 0; i < 4; i++) {
      await t.app.get(DispatcherService).drain();
      const runs = await t.prisma.db.workflowRun.findMany({ where: { workspaceId: w, status: "pending" }, select: { id: true } });
      if (!runs.length) break;
      for (const r of runs) await t.app.get(WorkflowExecutor).execute(w, r.id);
    }
    const tags = await t.prisma.db.contactTag.findMany({ where: { workspaceId: w, contactId: id }, include: { tag: true } });
    expect(tags.map((x) => x.tag.name)).toContain("Auto");
    const task = (await activityOf(id)).find((a) => a.type === "task.created")!;
    expect(task).toMatchObject({ actorType: "workflow", actorName: "Tag new contacts", actorId: null, actorRef: expect.stringMatching(/^workflow:.+:run:/) });
  });

  it("logs and announces a bulk reassignment once per contact, with one notification", async () => {
    const ids = [await contact("Bo One", "bo1@acme.example"), await contact("Bo Two", "bo2@acme.example"), await contact("Bo Three", "bo3@acme.example")];
    const before = (await notificationsOf(repId)).length;
    const res = await owner.post(api("/contacts/bulk")).send({ action: "assign", ids, ownerId: repId }).expect(200);
    expect(res.body.data.affected).toBe(3);
    for (const id of ids) {
      expect((await activityOf(id)).filter((a) => a.type === "contact.assigned")).toEqual([expect.objectContaining({ actorType: "user", actorId: ownerId })]);
    }
    const after = await notificationsOf(repId);
    expect(after.length - before).toBe(1);
    expect(after.at(-1)!.title).toBe("3 contacts are now yours");
    // Assigning them to the same person again changes nothing and says nothing.
    expect((await owner.post(api("/contacts/bulk")).send({ action: "assign", ids, ownerId: repId }).expect(200)).body.data.affected).toBe(0);
  });

  it("records deal reassignments, edits, wins and deletions, and tells the people involved", async () => {
    const contactId = await contact("Dee Deal", "dee@acme.example");
    const pipeline = (await owner.get(api("/pipelines")).expect(200)).body.data[0];
    const won = pipeline.stages.find((s: { kind: string }) => s.kind === "won");
    const deal = (await owner.post(api("/deals")).send({ name: "Dee pilot", contactId, value: 5000, pipelineId: pipeline.id }).expect(201)).body.data;
    await owner.patch(api(`/deals/${deal.id}`)).send({ ownerId: repId, value: 8000 }).expect(200);
    const dealActs = await t.prisma.db.activity.findMany({ where: { workspaceId: w, dealId: deal.id } });
    expect(dealActs.find((a) => a.type === "deal.assigned")).toMatchObject({ actorType: "user", summary: expect.stringMatching(/owner → .*value 5,000 → 8,000/) });
    expect((await notificationsOf(repId)).map((n) => n.title)).toContain("Deal assigned to you: Dee pilot");

    await owner.post(api(`/deals/${deal.id}/move`)).send({ stageId: won.id }).expect((r) => expect([200, 201]).toContain(r.status));
    expect((await notificationsOf(repId)).map((n) => n.title)).toContain("Your deal was won: Dee pilot");
    expect((await notificationsOf(ownerId)).map((n) => n.title)).toContain("Deal won: Dee pilot");

    await owner.delete(api(`/deals/${deal.id}`)).expect((r) => expect([200, 204]).toContain(r.status));
    expect((await activityOf(contactId)).map((a) => a.type)).toContain("deal.deleted");
    expect(await t.prisma.db.auditEvent.findFirst({ where: { workspaceId: w, action: "deal.deleted", targetId: deal.id } })).toBeTruthy();
  });

  it("audits contact exports", async () => {
    await owner.get(api("/contacts/export")).expect(200);
    const ev = await t.prisma.db.auditEvent.findFirst({ where: { workspaceId: w, action: "contacts.exported" }, orderBy: { createdAt: "desc" } });
    expect(ev).toMatchObject({ actorType: "user", actorUserId: ownerId });
    expect((ev!.metadata as { rows: number }).rows).toBeGreaterThan(0);
  });

  it("shows the whole team's activity to the owner, filterable by actor, and only their own to a member", async () => {
    const all = (await owner.get(api("/activity?limit=100")).expect(200)).body.data;
    const kinds = new Set(all.items.map((i: { actor: { type: string } }) => i.actor.type));
    for (const k of ["user", "integration", "ai_agent", "workflow"]) expect(kinds).toContain(k);
    const agent = all.items.find((i: { actor: { type: string } }) => i.actor.type === "ai_agent");
    expect(agent.actor.onBehalfOf).toMatchObject({ id: ownerId, name: "Olivia Owner" });
    expect(agent.contact).toMatchObject({ fullName: "Ada Agent" });

    const onlyAi = (await owner.get(api("/activity?actorType=ai_agent")).expect(200)).body.data.items;
    expect(onlyAi.length).toBeGreaterThan(0);
    expect(onlyAi.every((i: { actor: { type: string } }) => i.actor.type === "ai_agent")).toBe(true);

    const summary = (await owner.get(api("/activity/summary")).expect(200)).body.data;
    expect(summary.byActorType.ai_agent).toBeGreaterThan(0);
    expect(summary.byActorType.integration).toBeGreaterThan(0);
    expect(summary.byPerson.find((p: { userId: string }) => p.userId === ownerId)).toMatchObject({ name: "Olivia Owner", byAi: expect.any(Number) });

    // A member without analytics.team sees only their own, whatever they ask for.
    const mine = (await rep.get(api(`/activity?userId=${ownerId}`)).expect(200)).body.data.items;
    expect(mine.every((i: { actor: { id: string | null; onBehalfOf: { id: string } | null } }) => i.actor.id === repId || i.actor.onBehalfOf?.id === repId)).toBe(true);

    // Paging: a cursor continues where the page stopped.
    const p1 = (await owner.get(api("/activity?limit=2")).expect(200)).body.data;
    const p2 = (await owner.get(api(`/activity?limit=2&cursor=${p1.nextCursor}`)).expect(200)).body.data;
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
    expect(p1.items.map((i: { id: string }) => i.id)).not.toContain(p2.items[0].id);
  });
});
