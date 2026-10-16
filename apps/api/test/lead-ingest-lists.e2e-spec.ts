import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Lead ingest sorting leads into lists by name (`listName`, per request or
 * per lead — how Clientdesk files each website form's leads), and the
 * `GET /leads/ping` connection check its settings screen calls.
 */
describe("Lead ingest: lists by name, connection check", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  let w2: string;
  let key: string;
  let readKey: string;

  const api = (path: string, ws = w) => `/v1/workspaces/${ws}${path}`;
  const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });
  const lead = (n: number, extra: Record<string, unknown> = {}) => ({ externalId: `led_${n}`, fullName: `Lead ${n}`, email: `lead${n}@site.test`, ...extra });

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "ingest-lists@acme.test");
    w = await createWorkspace(owner, "Lists Co");
    await setPlan(t, w, "growth");
    const other = await signUp(t, "ingest-lists-other@other.test");
    w2 = await createWorkspace(other, "Elsewhere");
    await setPlan(t, w2, "growth");
    key = (await owner.post(api("/api-keys")).send({ name: "Clientdesk", scopes: ["leads:write"] }).expect(201)).body.data.secret;
    readKey = (await owner.post(api("/api-keys")).send({ name: "Reader", scopes: ["contacts:read"] }).expect(201)).body.data.secret;
  });
  afterAll(async () => t.close());

  it("answers the connection check with the workspace, and only for a key that may ingest there", async () => {
    const res = await t.http().get(api("/leads/ping")).set(bearer(key)).expect(200);
    expect(res.body.data).toEqual({ workspace: { id: w, name: "Lists Co" }, apiKey: { name: "Clientdesk" } });
    await t.http().get(api("/leads/ping")).set(bearer(readKey)).expect(403);
    await t.http().get(api("/leads/ping", w2)).set(bearer(key)).expect((r) => expect([401, 403, 404]).toContain(r.status));
    await t.http().get(api("/leads/ping")).set(bearer("gd_nope")).expect(401);
  });

  it("files each lead into the list it names, creating lists once and matching names loosely", async () => {
    const existing = (await owner.post(api("/marketing/lists")).send({ name: "Website · Contact form" }).expect(201)).body.data.id;
    const res = await t
      .http()
      .post(api("/leads"))
      .set(bearer(key))
      .send({
        source: "clientdesk",
        leads: [
          lead(1, { listName: "website ·  contact form" }),
          lead(2, { listName: "Website check" }),
          lead(3, { listName: "Website check" }),
          lead(4),
        ],
        listName: "Added manually",
      })
      .expect(200);
    const d = res.body.data;
    expect(d.summary).toMatchObject({ received: 4, created: 4, failed: 0 });
    const byName = Object.fromEntries(d.lists.map((l: { listName: string }) => [l.listName, l]));
    expect(byName["Website · Contact form"]).toMatchObject({ listId: existing, created: false, added: 1 });
    expect(byName["Website check"]).toMatchObject({ created: true, added: 2 });
    expect(byName["Added manually"]).toMatchObject({ created: true, added: 1 });
    expect(d.list).toBeNull();
    // The membership names the app that sent it, not "a team member".
    const member = await t.prisma.db.listMembership.findFirstOrThrow({ where: { workspaceId: w, listId: byName["Website check"].listId } });
    expect(member.source).toBe("From Clientdesk");

    // A second request reuses the lists it made, and a re-sent lead is already a member.
    const again = (await t.http().post(api("/leads")).set(bearer(key)).send({ source: "clientdesk", leads: [lead(2, { listName: "Website check" })] }).expect(200)).body.data;
    expect(again.results[0]).toMatchObject({ status: "unchanged", matchedBy: "external" });
    expect(again.lists).toEqual([expect.objectContaining({ listId: byName["Website check"].listId, created: false, added: 0, alreadyMember: 1 })]);
    expect(await t.prisma.db.marketingList.count({ where: { workspaceId: w, name: "Website check" } })).toBe(1);

    const imp = await t.prisma.db.import.findFirstOrThrow({ where: { workspaceId: w, id: d.importId } });
    expect(imp.source).toBe("clientdesk");
  });

  it("does not add a lead that failed, and leaves an archived list alone", async () => {
    const archived = (await owner.post(api("/marketing/lists")).send({ name: "Old form" }).expect(201)).body.data.id;
    await owner.post(api(`/marketing/lists/${archived}/archive`)).send({ archived: true }).expect((r) => expect([200, 201]).toContain(r.status));
    const d = (
      await t
        .http()
        .post(api("/leads"))
        .set(bearer(key))
        .send({ source: "clientdesk", leads: [{ externalId: "led_bad", listName: "Old form" }, lead(9, { listName: "Old form" })] })
        .expect(200)
    ).body.data;
    expect(d.results[0].status).toBe("failed");
    expect(d.lists).toHaveLength(1);
    expect(d.lists[0]).toMatchObject({ created: true, added: 1 });
    expect(d.lists[0].listId).not.toBe(archived);
  });
});
