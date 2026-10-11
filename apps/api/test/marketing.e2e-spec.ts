import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { SuppressionService } from "../src/crm/suppression.service.js";
import { ContactsService } from "../src/crm/contacts.service.js";

describe("Marketing foundation: suppression scopes, consent history, company profile", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const api = (p: string) => `/v1/workspaces/${w}${p}`;

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "mkt-owner@acme.test");
    w = await createWorkspace(owner, "Marketing Co");
    await setPlan(t, w, "growth");
  });
  afterAll(async () => t.close());

  describe("suppression scopes", () => {
    it("a marketing suppression stops marketing only; an `all` one stops both engines", async () => {
      const s = t.app.get(SuppressionService);
      await owner.post(api("/suppressions")).send({ kind: "email", value: "news-only@scope.test", reason: "unsubscribed", scope: "marketing" }).expect(201);
      expect(await s.check(w, { email: "news-only@scope.test" })).toBeNull();
      expect(await s.check(w, { email: "news-only@scope.test" }, undefined, "marketing")).toMatch(/do-not-contact list for marketing/);

      await owner.post(api("/suppressions")).send({ kind: "domain", value: "blocked.test" }).expect(201);
      expect(await s.check(w, { email: "x@blocked.test" }, undefined, "outreach")).toBe("blocked.test is on the do-not-contact list (manual)");
      expect(await s.check(w, { email: "x@blocked.test" }, undefined, "marketing")).toBe("blocked.test is on the do-not-contact list (manual)");
    });

    it("keeps one entry per scope for the same address", async () => {
      await owner.post(api("/suppressions")).send({ kind: "email", value: "both@scope.test", scope: "outreach" }).expect(201);
      await owner.post(api("/suppressions")).send({ kind: "email", value: "both@scope.test", scope: "marketing" }).expect(201);
      await owner.post(api("/suppressions")).send({ kind: "email", value: "both@scope.test", scope: "marketing" }).expect(201);
      const rows = await t.prisma.db.suppression.findMany({ where: { workspaceId: w, value: "both@scope.test" }, orderBy: { scope: "asc" } });
      expect(rows.map((r) => r.scope)).toEqual(["outreach", "marketing"]);
      const list = await owner.get(api("/suppressions?q=both@scope")).expect(200);
      expect(list.body.data.items.map((r: { scope: string }) => r.scope).sort()).toEqual(["marketing", "outreach"]);
    });

    it("refuses an unknown scope", async () => {
      await owner.post(api("/suppressions")).send({ kind: "email", value: "x@scope.test", scope: "sms" }).expect(400);
    });
  });

  describe("consent history", () => {
    it("records consent given on create, with consentAt and a timeline entry", async () => {
      const c = (await owner.post(api("/contacts")).send({ fullName: "Opted In", email: "opted@consent.test", consentStatus: "granted", consentSource: "Web form" }).expect(201)).body.data;
      expect(c).toMatchObject({ consentStatus: "granted", consentSource: "Web form" });
      expect(c.consentAt).toBeTruthy();
      const history = (await owner.get(api(`/contacts/${c.id}/consent`)).expect(200)).body.data;
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: "granted", source: "Web form", detail: { via: "manual" }, actor: { id: owner.userId } });
      const timeline = await t.prisma.db.activity.findMany({ where: { workspaceId: w, contactId: c.id, type: "contact.consent" } });
      expect(timeline.map((a) => a.summary)).toEqual(["Marketing consent granted (Web form)"]);
    });

    it("writes no history for a contact created without consent", async () => {
      const c = (await owner.post(api("/contacts")).send({ fullName: "Cold Lead", email: "cold@consent.test" }).expect(201)).body.data;
      expect(c).toMatchObject({ consentStatus: "unknown", consentAt: null });
      expect((await owner.get(api(`/contacts/${c.id}/consent`)).expect(200)).body.data).toEqual([]);
    });

    it("logs each change on update and ignores a repeat", async () => {
      const c = (await owner.post(api("/contacts")).send({ fullName: "Changes Mind", email: "mind@consent.test", consentStatus: "granted", consentSource: "Checkout" }).expect(201)).body.data;
      await owner.patch(api(`/contacts/${c.id}`)).send({ consentStatus: "denied", consentSource: "Asked by phone" }).expect(200);
      await owner.patch(api(`/contacts/${c.id}`)).send({ consentStatus: "denied", consentSource: "Asked by phone" }).expect(200);
      await owner.patch(api(`/contacts/${c.id}`)).send({ jobTitle: "CTO" }).expect(200);
      const history = (await owner.get(api(`/contacts/${c.id}/consent`)).expect(200)).body.data;
      expect(history.map((h: { status: string; source: string }) => [h.status, h.source])).toEqual([
        ["denied", "Asked by phone"],
        ["granted", "Checkout"],
      ]);
      const fresh = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: c.id } });
      expect(fresh.consentStatus).toBe("denied");
    });

    it("an import fills unknown consent but never overwrites a recorded answer", async () => {
      const contacts = t.app.get(ContactsService);
      const ws = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } });
      const cold = (await owner.post(api("/contacts")).send({ fullName: "Fill Me", email: "fill@consent.test" }).expect(201)).body.data;
      const denied = (await owner.post(api("/contacts")).send({ fullName: "Said No", email: "no@consent.test", consentStatus: "denied" }).expect(201)).body.data;
      for (const email of ["fill@consent.test", "no@consent.test"]) {
        await contacts.upsert(w, ws.billingAccountId, { email, consentStatus: "granted" }, { source: "csv", onDuplicate: "update", capacityChecked: true });
      }
      const filled = (await owner.get(api(`/contacts/${cold.id}/consent`)).expect(200)).body.data;
      expect(filled).toHaveLength(1);
      expect(filled[0]).toMatchObject({ status: "granted", source: "CSV import", detail: { via: "csv" } });
      expect((await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, id: denied.id } })).consentStatus).toBe("denied");
    });

    it("hides another workspace's contact", async () => {
      const other = await signUp(t, "mkt-other@acme.test");
      const w2 = await createWorkspace(other, "Other Co");
      const theirs = (await other.post(`/v1/workspaces/${w2}/contacts`).send({ fullName: "Theirs", email: "theirs@consent.test", consentStatus: "granted" }).expect(201)).body.data;
      await owner.get(api(`/contacts/${theirs.id}/consent`)).expect(404);
    });
  });

  describe("company profile", () => {
    it("saves the legal name, postal address and marketing defaults", async () => {
      const res = await owner
        .patch(`/v1/workspaces/${w}`)
        .send({ legalName: "Marketing Co Ltd", postalAddress: "1 Main St\nSpringfield, IL 62701\nUSA", marketingFromName: "Marketing Co", marketingReplyTo: "Hello@Marketing.test" })
        .expect(200);
      expect(res.body.data.profile).toEqual({
        legalName: "Marketing Co Ltd",
        postalAddress: "1 Main St\nSpringfield, IL 62701\nUSA",
        marketingFromName: "Marketing Co",
        marketingReplyTo: "hello@marketing.test",
      });
      await owner.patch(`/v1/workspaces/${w}`).send({ marketingReplyTo: "" }).expect(200);
      await owner.patch(`/v1/workspaces/${w}`).send({ marketingReplyTo: "not-an-email" }).expect(400);
    });
  });
});
