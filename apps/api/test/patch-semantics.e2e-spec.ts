import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * A PATCH changes only what it sends (docs/GAP_PLAN.md §0.7). Zod 4's
 * `.partial()` keeps `.default()`s, which used to reset fields the client
 * never mentioned; PATCH bodies now go through patchOf().
 */
describe("PATCH keeps fields it was not sent", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const api = (p: string) => `/v1/workspaces/${w}${p}`;

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "patch-owner@acme.test");
    w = await createWorkspace(owner, "Patch Co");
    await setPlan(t, w, "growth");
  });
  afterAll(async () => t.close());

  it("toggling a workflow keeps its conditions and approval step", async () => {
    const wf = (
      await owner
        .post(api("/workflows"))
        .send({
          name: "VIP routing",
          trigger: "contact.created",
          conditions: [{ field: "contact.country", op: "is", value: "DE" }],
          actions: [{ type: "create_task", config: { title: "Call them" } }],
          requiresApproval: true,
        })
        .expect(201)
    ).body.data;
    await owner.patch(api(`/workflows/${wf.id}`)).send({ enabled: true }).expect(200);
    const after = (await owner.get(api(`/workflows/${wf.id}`)).expect(200)).body.data;
    expect(after).toMatchObject({ enabled: true, requiresApproval: true, conditions: [{ field: "contact.country", op: "is", value: "DE" }] });
  });

  it("completing a call task keeps its type", async () => {
    const task = (await owner.post(api("/tasks")).send({ type: "call", title: "Call Ada" }).expect(201)).body.data;
    await owner.patch(api(`/tasks/${task.id}`)).send({ status: "done" }).expect(200);
    expect((await owner.get(api(`/tasks/${task.id}`)).expect(200)).body.data).toMatchObject({ type: "call", status: "done" });
  });

  it("editing a disabled webhook does not re-enable it", async () => {
    const hook = await t.prisma.db.webhookEndpoint.create({ data: { workspaceId: w, url: "https://hooks.example.com/in", secretSealed: "x", events: ["contact.created"], enabled: false } });
    await owner.patch(api(`/webhooks/${hook.id}`)).send({ description: "CRM sync" }).expect(200);
    const after = await t.prisma.db.webhookEndpoint.findFirstOrThrow({ where: { workspaceId: w, id: hook.id } });
    expect(after).toMatchObject({ enabled: false, description: "CRM sync" });
  });

  it("renaming a select field keeps its options", async () => {
    const field = (
      await owner.post(api("/custom-fields")).send({ entity: "contact", key: "tier", label: "Tier", type: "select", options: ["Gold", "Silver"] }).expect(201)
    ).body.data;
    await owner.patch(api(`/custom-fields/${field.id}`)).send({ label: "Customer tier" }).expect(200);
    const list = (await owner.get(api("/custom-fields")).expect(200)).body.data;
    expect(list.find((f: { id: string }) => f.id === field.id)).toMatchObject({ label: "Customer tier", options: ["Gold", "Silver"] });
  });
});
