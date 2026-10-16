import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { DispatcherService } from "../src/automation/dispatcher.service.js";
import { LeadRoutingService } from "../src/automation/lead-routing.service.js";
import { EventsService } from "../src/core/events.service.js";

/*
 * Lead routing: rules in order, then the fallback; one person, round robin
 * or balanced; for every new unowned contact however it arrived (here: the
 * lead API with lists, and by hand), never touching one already owned;
 * logged as "Lead routing · <rule>" and announced once per owner per batch.
 */
describe("Lead routing", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const ids: Record<string, string> = {};
  const api = (p: string) => `/v1/workspaces/${w}${p}`;
  const me = async (a: Agent) => (await a.get("/v1/auth/me").expect(200)).body.data.user.id as string;
  const ownerOf = async (contactId: string) => (await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: contactId } })).ownerId;
  let key: string;

  /** What the worker does: dispatch the outbox, then run the route jobs it would have queued. */
  const settle = async () => {
    const routing = t.app.get(LeadRoutingService);
    for (let i = 0; i < 4; i++) {
      const res = await t.app.get(DispatcherService).dispatchBatch();
      for (const r of res.routes) await routing.route(r.workspaceId, r.contactIds);
      if (!res.events) break;
    }
  };

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "routing-owner@acme.test", "Rhea Owner");
    w = await createWorkspace(owner, "Routing Co");
    await setPlan(t, w, "agency");
    for (const n of ["ana", "ben", "cat"]) ids[n] = await me(await addMember(t, owner, w, `${n}@acme.test`, "member"));
    ids.viewer = await me(await addMember(t, owner, w, "vic@acme.test", "viewer"));
    key = (await owner.post(api("/api-keys")).send({ name: "Clientdesk", scopes: ["leads:write"] }).expect(201)).body.data.secret;
  });
  afterAll(async () => t.close());

  it("saves rules, refusing a viewer as an owner", async () => {
    const cfg = {
      enabled: true,
      rules: [
        { id: "web-forms", name: "Website forms", when: { leadSources: ["clientdesk"], lists: ["Website · Contact"] }, assign: { mode: "balanced", userIds: [ids.ana, ids.ben] } },
        { id: "bangladesh", name: "Bangladesh", when: { countries: ["BD"] }, assign: { mode: "user", userIds: [ids.cat] } },
      ],
      fallback: { mode: "round_robin", userIds: [ids.ana, ids.ben, ids.cat] },
    };
    await owner.put(api("/lead-routing")).send({ ...cfg, fallback: { mode: "round_robin", userIds: [ids.viewer] } }).expect(400);
    await owner.put(api("/lead-routing")).send(cfg).expect(200);
    expect((await owner.get(api("/lead-routing")).expect(200)).body.data).toMatchObject({ enabled: true, rules: [{ id: "web-forms" }, { id: "bangladesh" }] });
  });

  it("routes API leads by source and list, balancing the pool", async () => {
    // Ana already holds two open leads, so the balanced rule sends the first two to Ben.
    for (const n of [1, 2]) await owner.post(api("/contacts")).send({ fullName: `Ana's ${n}`, email: `ana${n}@x.example`, ownerId: ids.ana, lifecycleStage: "lead" }).expect(201);
    const res = await t
      .http()
      .post(api("/leads"))
      .set({ Authorization: `Bearer ${key}` })
      .send({
        source: "clientdesk",
        leads: [1, 2, 3].map((n) => ({ externalId: `led_${n}`, fullName: `Form ${n}`, email: `form${n}@site.example`, leadSource: "Clientdesk · Website", listName: "Website · Contact" })),
      })
      .expect(200);
    await settle();
    const owners = await Promise.all(res.body.data.results.map((r: { contactId: string }) => ownerOf(r.contactId)));
    expect(owners.filter((o) => o === ids.ben)).toHaveLength(2);
    expect(owners.filter((o) => o === ids.ana)).toHaveLength(1);

    const log = await t.prisma.db.activity.findFirstOrThrow({ where: { workspaceId: w, contactId: res.body.data.results[0].contactId, type: "contact.assigned" } });
    expect(log).toMatchObject({ actorType: "system", actorName: "Lead routing · Website forms", actorRef: "routing:web-forms", summary: expect.stringContaining("rule: Website forms") });
    const benNotes = await t.prisma.db.notification.findMany({ where: { workspaceId: w, userId: ids.ben } });
    expect(benNotes.map((n) => n.title)).toContain("2 new leads for you");
  });

  it("uses the next rule, then the fallback in turn, and leaves owned contacts alone", async () => {
    const bd = (await owner.post(api("/contacts")).send({ fullName: "Dhaka Lead", email: "dhaka@x.example", country: "BD" }).expect(201)).body.data.id;
    const others = [];
    for (const n of [1, 2, 3, 4]) others.push((await owner.post(api("/contacts")).send({ fullName: `Other ${n}`, email: `other${n}@x.example` }).expect(201)).body.data.id);
    const owned = (await owner.post(api("/contacts")).send({ fullName: "Kept", email: "kept@x.example", ownerId: ids.ana }).expect(201)).body.data.id;
    await settle();
    expect(await ownerOf(bd)).toBe(ids.cat);
    expect(await Promise.all(others.map(ownerOf))).toEqual([ids.ana, ids.ben, ids.cat, ids.ana]);
    expect(await ownerOf(owned)).toBe(ids.ana);
    // Running again changes nothing.
    expect((await t.app.get(LeadRoutingService).route(w, [...others, bd])).routed).toBe(0);
  });

  it("says which rule a contact would hit, without changing it", async () => {
    const c = (await owner.post(api("/contacts")).send({ fullName: "Probe", email: "probe@x.example", country: "BD" }).expect(201)).body.data.id;
    const r = (await owner.post(api("/lead-routing/test")).send({ contactId: c }).expect(200)).body.data;
    expect(r).toMatchObject({ rule: { id: "bangladesh" }, ownerId: ids.cat, fallback: false });
    expect(await ownerOf(c)).toBeNull();
  });

  it("does nothing while switched off", async () => {
    await owner.put(api("/lead-routing")).send({ enabled: false, rules: [], fallback: { mode: "user", userIds: [ids.ana] } }).expect(200);
    const c = (await owner.post(api("/contacts")).send({ fullName: "Quiet", email: "quiet@x.example" }).expect(201)).body.data.id;
    await t.app.get(EventsService).kick();
    await settle();
    expect(await ownerOf(c)).toBeNull();
  });
});
