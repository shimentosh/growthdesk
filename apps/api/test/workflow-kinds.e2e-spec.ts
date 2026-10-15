import { WORKFLOW_TEMPLATES } from "@growthdesk/shared";
import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { DispatcherService } from "../src/automation/dispatcher.service.js";
import { WorkflowExecutor } from "../src/automation/workflow-executor.service.js";
import { marketingToken } from "../src/marketing/tokens.js";

/*
 * Sales and email-marketing workflows: every ready-made template saves once
 * its blanks are filled, a pricing click hands a lead to sales, a list join
 * moves someone between lists, and an unsubscribe reaches workflows.
 */

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";

describe("Workflow kinds and templates", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let ownerId: string;
  let outreachId: string;
  const lists: Record<string, string> = {};

  /** Drains the outbox and runs every pending run, until nothing new appears. */
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await t.app.get(DispatcherService).drain();
      const runs = await t.prisma.db.workflowRun.findMany({ where: { workspaceId: w, status: "pending" }, select: { id: true } });
      if (!runs.length) return;
      for (const r of runs) await t.app.get(WorkflowExecutor).execute(w, r.id);
    }
  };

  const workflow = async (body: Record<string, unknown>) => (await owner.post(`/v1/workspaces/${w}/workflows`).send({ enabled: true, ...body }).expect(201)).body.data.id as string;

  const sendTo = async (contactId: string, email: string) => {
    const campaignId = (await owner.post(`/v1/workspaces/${w}/marketing/campaigns`).send({ name: `News for ${email}` }).expect(201)).body.data.id;
    return (await t.prisma.db.marketingSend.create({ data: { workspaceId: w, campaignId, contactId, email, status: "sent", sentAt: new Date(Date.now() - 60_000) } })).id;
  };

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "wf-kinds@acme.test", "Wendy Owner");
    w = await createWorkspace(owner, "Workflow Co");
    await setPlan(t, w, "agency");
    ownerId = (await owner.get("/v1/auth/me").expect(200)).body.data.user.id;
    for (const name of ["Webinar", "Nurture", "Welcome"]) lists[name] = (await owner.post(`/v1/workspaces/${w}/marketing/lists`).send({ name }).expect(201)).body.data.id;
    outreachId = (await owner.post(`/v1/workspaces/${w}/campaigns`).send({ name: "New lead sequence" }).expect(201)).body.data.id;
  });
  afterAll(async () => t.close());

  it("saves every template once its blanks are filled", async () => {
    for (const tpl of WORKFLOW_TEMPLATES) {
      const fill = (c: Record<string, unknown>) => ({ ...c, ...("listId" in c ? { listId: lists.Welcome } : {}), ...("campaignId" in c && !c.campaignId ? { campaignId: outreachId } : {}) });
      const actions = tpl.actions.map((a) => ({ type: a.type, delayMinutes: a.delayMinutes ?? 0, config: fill(a.config) }));
      const conditions = tpl.conditions.map((c) => ({ ...c, value: c.value || "Webinar" }));
      const res = await owner.post(`/v1/workspaces/${w}/workflows`).send({ name: tpl.name, trigger: tpl.trigger, conditions, actions, enabled: false });
      expect({ template: tpl.id, status: res.status, error: res.body.error?.message }).toEqual({ template: tpl.id, status: 201, error: undefined });
      await owner.delete(`/v1/workspaces/${w}/workflows/${res.body.data.id}`).expect(200);
    }
  });

  it("hands a lead who clicks pricing to sales, with a task for the owner", async () => {
    const tpl = WORKFLOW_TEMPLATES.find((x) => x.id === "mkt-click-to-sales")!;
    const id = await workflow({ name: tpl.name, trigger: tpl.trigger, conditions: tpl.conditions, actions: tpl.actions });
    const lead = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Lena Lead", email: "lena@readers.test", lifecycleStage: "lead", ownerId }).expect(201)).body.data.id;
    const other = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Otto Other", email: "otto@readers.test", lifecycleStage: "lead", ownerId }).expect(201)).body.data.id;

    const pricing = marketingToken({ kind: "click", sendId: await sendTo(lead, "lena@readers.test"), url: "https://brand.test/pricing" });
    await t.http().get(`/v1/m/c/${pricing}`).set("user-agent", BROWSER).expect(302);
    const blog = marketingToken({ kind: "click", sendId: await sendTo(other, "otto@readers.test"), url: "https://brand.test/blog" });
    await t.http().get(`/v1/m/c/${blog}`).set("user-agent", BROWSER).expect(302);
    await settle();

    expect(await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: lead } })).toMatchObject({ lifecycleStage: "sales", qualification: "qualified" });
    expect(await t.prisma.db.task.findFirst({ where: { workspaceId: w, contactId: lead } })).toMatchObject({ title: "Call: clicked pricing in a marketing email", assigneeId: ownerId, priority: "high" });
    // The blog click fired the trigger too, but the condition kept it from acting.
    expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: other } })).lifecycleStage).toBe("lead");
    const runs = await t.prisma.db.workflowRun.findMany({ where: { workspaceId: w, workflowId: id }, select: { status: true } });
    expect(runs.map((r) => r.status).sort()).toEqual(["skipped", "succeeded"]);
  });

  it("never moves a contact back to sales", async () => {
    const customer = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Cora Customer", email: "cora@readers.test", lifecycleStage: "contact" }).expect(201)).body.data.id;
    const click = marketingToken({ kind: "click", sendId: await sendTo(customer, "cora@readers.test"), url: "https://brand.test/pricing" });
    await t.http().get(`/v1/m/c/${click}`).set("user-agent", BROWSER).expect(302);
    await settle();
    expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: customer } })).lifecycleStage).toBe("contact");
  });

  it("moves someone from one list to the next when they join", async () => {
    await workflow({
      name: "Webinar → Nurture",
      trigger: "list.subscribed",
      conditions: [{ field: "event.listName", op: "is", value: "Webinar" }],
      actions: [
        { type: "add_to_list", config: { listId: lists.Nurture } },
        { type: "remove_from_list", config: { listId: lists.Webinar } },
      ],
    });
    const person = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Willa Webinar", email: "willa@readers.test" }).expect(201)).body.data.id;
    await owner.post(`/v1/workspaces/${w}/marketing/lists/${lists.Webinar}/members`).send({ contactIds: [person] }).expect(200);
    await settle();
    const held = await t.prisma.db.listMembership.findMany({ where: { workspaceId: w, contactId: person }, select: { listId: true, status: true } });
    expect(held).toEqual([{ listId: lists.Nurture, status: "subscribed" }]);
  });

  it("tells workflows about an unsubscribe", async () => {
    await workflow({ name: "Unsubscribed → tag", trigger: "marketing.unsubscribed", conditions: [], actions: [{ type: "add_tag", config: { tags: ["Unsubscribed"] } }] });
    const reader = (await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Rae Reader", email: "rae@readers.test", consentStatus: "granted", consentSource: "Form" }).expect(201)).body.data.id;
    await owner.post(`/v1/workspaces/${w}/marketing/lists/${lists.Welcome}/members`).send({ contactIds: [reader] }).expect(200);
    const unsubscribe = marketingToken({ kind: "unsubscribe", sendId: await sendTo(reader, "rae@readers.test") });
    await t.http().post(`/v1/m/u/${unsubscribe}`).expect(200);
    await settle();
    const event = await t.prisma.db.domainEvent.findFirst({ where: { workspaceId: w, type: "marketing.unsubscribed", subjectId: reader } });
    expect(event?.payload).toMatchObject({ scope: "all", contactId: reader });
    const tags = await t.prisma.db.contactTag.findMany({ where: { workspaceId: w, contactId: reader }, include: { tag: true } });
    expect(tags.map((x) => x.tag.name)).toContain("Unsubscribed");
  });
});
