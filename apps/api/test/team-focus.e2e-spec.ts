import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * "This week's focus" on Home: managers pin the workspace's; a team lead
 * pins their team's (and only theirs); members read what is theirs; empty
 * text clears it; notify rings the bell for the people it is for.
 */
describe("Team focus", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const agents: Record<string, Agent> = {};
  const ids: Record<string, string> = {};
  let sales: string;
  let marketing: string;
  const api = (p: string) => `/v1/workspaces/${w}${p}`;
  const me = async (a: Agent) => (await a.get("/v1/auth/me").expect(200)).body.data.user.id as string;
  const bell = (userId: string) => t.prisma.db.notification.findMany({ where: { workspaceId: w, userId, type: "focus" } });

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "focus-owner@acme.test", "Fay Owner");
    w = await createWorkspace(owner, "Focus Co");
    await setPlan(t, w, "agency");
    for (const [k, role] of [["lea", "member"], ["rep", "member"], ["mkt", "member"], ["max", "manager"]] as const) {
      agents[k] = await addMember(t, owner, w, `${k}@focus.test`, role);
      ids[k] = await me(agents[k]);
    }
    sales = (await owner.post(api("/teams")).send({ name: "Sales", memberIds: [ids.lea, ids.rep], leadUserId: ids.lea }).expect(201)).body.data.id;
    marketing = (await owner.post(api("/teams")).send({ name: "Marketing", memberIds: [ids.mkt] }).expect(201)).body.data.id;
  });
  afterAll(async () => t.close());

  it("lets managers pin the workspace's focus, and tells everyone", async () => {
    await agents.rep!.put(api("/team-focus")).send({ text: "Rogue focus" }).expect(403);
    const out = (await agents.max!.put(api("/team-focus")).send({ text: "Close the Q4 renewals", notify: true }).expect(200)).body.data;
    expect(out.workspace).toMatchObject({ text: "Close the Q4 renewals", byId: ids.max });
    expect((await bell(ids.rep!)).length).toBe(1);
    expect((await bell(ids.max!)).length).toBe(0);
  });

  it("lets a team lead pin their own team's focus but not another's", async () => {
    await agents.lea!.put(api("/team-focus")).send({ text: "Call every demo request within an hour", teamId: sales, notify: true }).expect(200);
    await agents.lea!.put(api("/team-focus")).send({ text: "Nope", teamId: marketing }).expect(403);
    expect((await bell(ids.rep!)).length).toBe(2);
    expect((await bell(ids.mkt!)).length).toBe(1);
  });

  it("shows each person the workspace's focus and their own teams'", async () => {
    const rep = (await agents.rep!.get(api("/team-focus")).expect(200)).body.data;
    expect(rep.workspace.text).toBe("Close the Q4 renewals");
    expect(rep.canEditWorkspace).toBe(false);
    expect(rep.teams).toEqual([expect.objectContaining({ teamId: sales, canEdit: false, focus: expect.objectContaining({ text: "Call every demo request within an hour" }) })]);
    const lea = (await agents.lea!.get(api("/team-focus")).expect(200)).body.data;
    expect(lea.teams[0]).toMatchObject({ teamId: sales, canEdit: true });
    const mgr = (await agents.max!.get(api("/team-focus")).expect(200)).body.data;
    expect(mgr.teams.map((x: { name: string }) => x.name)).toEqual(["Marketing", "Sales"]);
  });

  it("clears with empty text and survives other settings saves", async () => {
    await owner.patch(api("")).send({ settings: { trackOpens: true } }).expect(200);
    expect((await agents.rep!.get(api("/team-focus")).expect(200)).body.data.workspace.text).toBe("Close the Q4 renewals");
    await owner.put(api("/team-focus")).send({ text: "" }).expect(200);
    const after = (await agents.rep!.get(api("/team-focus")).expect(200)).body.data;
    expect(after.workspace).toBeNull();
    expect(after.teams[0].focus.text).toBe("Call every demo request within an hour");
  });
});
