import { createHash } from "node:crypto";
import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * API keys and the public API: issuing (secret shown once, digest stored),
 * scopes, revocation and expiry, plan gating, tenant isolation, and the
 * Business OS lead ingest (dedupe, attribution, idempotency, plan capacity,
 * campaign enrollment).
 */
describe("Integrations: API keys, public API, lead ingest", () => {
  let t: TestApp;
  let owner: Agent;
  let other: Agent;
  let w: string;
  let w2: string;
  let leadKey: { id: string; secret: string };
  let readKey: { id: string; secret: string };
  let otherKey: { id: string; secret: string };

  const api = (path: string, ws = w) => `/v1/workspaces/${ws}${path}`;
  const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "int-owner@acme.test");
    w = await createWorkspace(owner, "Integrations Co");
    await setPlan(t, w, "growth");
    other = await signUp(t, "int-other@other.test");
    w2 = await createWorkspace(other, "Other Co");
    await setPlan(t, w2, "growth");
  });
  afterAll(async () => t.close());

  describe("key management", () => {
    it("refuses to issue keys on a plan without API access", async () => {
      await setPlan(t, w, "free");
      const res = await owner.post(api("/api-keys")).send({ name: "Business OS", scopes: ["leads:write"] }).expect(402);
      expect(res.body.error.code).toBe("plan_limit");
      expect(res.body.error.details.feature).toBe("apiAccess");
      await setPlan(t, w, "growth");
    });

    it("issues a key once and stores only its digest and prefix", async () => {
      const res = await owner.post(api("/api-keys")).send({ name: "Business OS", scopes: ["leads:write", "contacts:read", "leads:write"] }).expect(201);
      const k = res.body.data;
      expect(k.secret).toMatch(/^gd_[A-Za-z0-9_-]{43}$/);
      expect(k.prefix).toBe(k.secret.slice(0, "gd_".length + 8));
      expect(k.scopes).toEqual(["leads:write", "contacts:read"]);
      expect(k.status).toBe("active");
      expect(k.createdBy).toEqual({ id: owner.userId, name: "Test Person" });
      leadKey = { id: k.id, secret: k.secret };

      const row = await t.prisma.db.apiKey.findFirstOrThrow({ where: { id: k.id, workspaceId: w } });
      expect(row.keyHash).toBe(createHash("sha256").update(k.secret).digest("hex"));
      expect(JSON.stringify(row)).not.toContain(k.secret);

      const list = await owner.get(api("/api-keys")).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ id: k.id, prefix: k.prefix, lastUsedAt: null });
      expect(list.body.data[0].secret).toBeUndefined();

      const audit = await t.prisma.db.auditEvent.findFirst({ where: { workspaceId: w, action: "api_key.created", targetId: k.id } });
      expect(audit?.actorUserId).toBe(owner.userId);

      readKey = (await owner.post(api("/api-keys")).send({ name: "Read only", scopes: ["contacts:read"] }).expect(201)).body.data;
      otherKey = (await other.post(api("/api-keys", w2)).send({ name: "Other", scopes: ["contacts:read", "leads:write"] }).expect(201)).body.data;
    });

    it("validates the body and refuses an expiry in the past", async () => {
      await owner.post(api("/api-keys")).send({ name: "x", scopes: [] }).expect(400);
      await owner.post(api("/api-keys")).send({ name: "x", scopes: ["deals:write"] }).expect(400);
      const past = await owner.post(api("/api-keys")).send({ name: "x", scopes: ["contacts:read"], expiresAt: new Date(Date.now() - 60_000).toISOString() }).expect(400);
      expect(past.body.error.fields.expiresAt).toBeTruthy();
    });

    it("is limited to apikeys.manage, and a key cannot manage keys", async () => {
      const member = await addMember(t, owner, w, "int-member@acme.test", "member");
      await member.get(api("/api-keys")).expect(403);
      await member.post(api("/api-keys")).send({ name: "Mine", scopes: ["contacts:read"] }).expect(403);
      await member.delete(api(`/api-keys/${leadKey.id}`)).expect(403);
      // Key-management routes accept no API key at all.
      await t.http().get(api("/api-keys")).set(bearer(leadKey.secret)).expect(401);
      await t.http().post(api("/api-keys")).set(bearer(leadKey.secret)).send({ name: "Escalate", scopes: ["contacts:write"] }).expect(401);
    });
  });

  describe("public API", () => {
    it("authenticates a key on scoped routes and records its use", async () => {
      await owner.post(api("/contacts")).send({ fullName: "Ada Lovelace", email: "ada@engines.test" }).expect(201);
      const res = await t.http().get(api("/contacts")).set(bearer(readKey.secret)).expect(200);
      expect(res.body.data.items.map((c: { email: string }) => c.email)).toContain("ada@engines.test");
      const row = await t.prisma.db.apiKey.findFirstOrThrow({ where: { id: readKey.id, workspaceId: w } });
      expect(row.lastUsedAt).not.toBeNull();
      // Unscoped routes ignore the key and ask for a session.
      await t.http().get(api("/deals")).set(bearer(readKey.secret)).expect(401);
      await t.http().get(api("/contacts")).set(bearer("gd_not-a-real-key")).expect(401);
    });

    it("enforces scopes", async () => {
      const denied = await t.http().post(api("/contacts")).set(bearer(readKey.secret)).send({ fullName: "Nope" }).expect(403);
      expect(denied.body.error.message).toContain("contacts:write");
      await t.http().get(api("/campaigns")).set(bearer(readKey.secret)).expect(403);
      await t.http().post(api("/leads")).set(bearer(readKey.secret)).send({ leads: [{ fullName: "X" }] }).expect(403);

      const writer = (await owner.post(api("/api-keys")).send({ name: "Writer", scopes: ["contacts:write", "campaigns:read"] }).expect(201)).body.data;
      const made = await t.http().post(api("/contacts")).set(bearer(writer.secret)).send({ fullName: "Grace Hopper", email: "grace@navy.test" }).expect(201);
      await t.http().patch(api(`/contacts/${made.body.data.id}`)).set(bearer(writer.secret)).send({ jobTitle: "Rear Admiral" }).expect(200);
      await t.http().get(api("/campaigns")).set(bearer(writer.secret)).expect(200);
      // contacts:write does not include deleting.
      await t.http().delete(api(`/contacts/${made.body.data.id}`)).set(bearer(writer.secret)).expect(401);
    });

    it("keeps a key inside its own workspace", async () => {
      await t.http().get(api("/contacts", w2)).set(bearer(readKey.secret)).expect(404);
      await t.http().post(api("/leads", w2)).set(bearer(leadKey.secret)).send({ leads: [{ fullName: "Intruder" }] }).expect(404);
      const ada = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, email: "ada@engines.test" } });
      await t.http().get(api(`/contacts/${ada.id}`, w2)).set(bearer(otherKey.secret)).expect(404);
      const theirs = await t.http().get(api("/contacts", w2)).set(bearer(otherKey.secret)).expect(200);
      expect(theirs.body.data.total).toBe(0);
    });
  });

  describe("lead ingest", () => {
    it("upserts leads, dedupes by identifier, attributes the source and emits lead.imported", async () => {
      const res = await t
        .http()
        .post(api("/leads"))
        .set(bearer(leadKey.secret))
        .send({
          tags: ["bos"],
          leads: [
            { externalId: "bos-1", fullName: "Alan Turing", email: "ALAN@bletchley.test", company: { name: "Bletchley Park", domain: "bletchley.test", industry: "Research" }, data: { stage: "MQL" } },
            { externalId: "bos-2", fullName: "Ada L.", email: "ada@engines.test", jobTitle: "Analyst" },
            { externalId: "bos-3", jobTitle: "Nobody" },
          ],
        })
        .expect(200);
      const d = res.body.data;
      expect(d.source).toBe("business_os");
      expect(d.summary).toEqual({ received: 3, created: 1, updated: 1, unchanged: 0, skipped: 0, failed: 1 });
      expect(d.results.map((r: { status: string }) => r.status)).toEqual(["created", "updated", "failed"]);
      expect(d.results[1].matchedBy).toBe("email");
      expect(d.results[2].error.code).toBe("bad_request");
      expect(d.enrollment).toBeNull();

      const alan = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, email: "alan@bletchley.test" }, include: { company: true, tags: { include: { tag: true } }, sources: true } });
      expect(alan.company?.domain).toBe("bletchley.test");
      expect(alan.company?.industry).toBe("Research");
      expect(alan.tags.map((x) => x.tag.name)).toEqual(["bos"]);
      expect(alan.sources).toMatchObject([{ source: "business_os", externalId: "bos-1", importId: d.importId, data: { stage: "MQL" } }]);
      // Ada keeps her name (blanks are filled, never overwritten) and gains the job title.
      const ada = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, email: "ada@engines.test" } });
      expect(ada).toMatchObject({ fullName: "Ada Lovelace", jobTitle: "Analyst" });
      expect(await t.prisma.db.contact.count({ where: { workspaceId: w, email: "ada@engines.test" } })).toBe(1);

      const events = await t.prisma.db.domainEvent.findMany({ where: { workspaceId: w, type: "lead.imported" } });
      expect(events.map((e) => e.subjectId)).toEqual([alan.id]);
      const imp = await owner.get(api(`/imports/${d.importId}`)).expect(200);
      expect(imp.body.data).toMatchObject({ source: "business_os", status: "completed", fileName: "API key: Business OS", createdCount: 1, updatedCount: 1, failedCount: 1 });
      expect(imp.body.data.errors).toEqual([{ row: 3, message: d.results[2].error.message }]);
    });

    it("resolves the same external id to the same contact", async () => {
      const res = await t.http().post(api("/leads")).set(bearer(leadKey.secret)).send({ leads: [{ externalId: "bos-1", email: "alan.turing@other.test", city: "Manchester" }] }).expect(200);
      const alan = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, email: "alan@bletchley.test" }, include: { identifiers: true } });
      expect(res.body.data.results[0]).toMatchObject({ status: "updated", matchedBy: "external", contactId: alan.id });
      expect(alan.city).toBe("Manchester");
      expect(alan.identifiers.map((i) => i.value).sort()).toEqual(["alan.turing@other.test", "alan@bletchley.test"]);
    });

    it("replays an Idempotency-Key and refuses it for a different request", async () => {
      const body = { leads: [{ externalId: "bos-10", fullName: "Katherine Johnson", email: "katherine@nasa.test" }] };
      const first = await t.http().post(api("/leads")).set(bearer(leadKey.secret)).set("Idempotency-Key", "sync-2026-10-10-1").send(body).expect(200);
      expect(first.headers["idempotent-replayed"]).toBeUndefined();
      const again = await t.http().post(api("/leads")).set(bearer(leadKey.secret)).set("Idempotency-Key", "sync-2026-10-10-1").send(body).expect(200);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.body.data).toEqual(first.body.data);
      expect(await t.prisma.db.import.count({ where: { workspaceId: w, id: first.body.data.importId } })).toBe(1);
      expect(await t.prisma.db.import.count({ where: { workspaceId: w, source: "business_os" } })).toBe(3);
      expect(await t.prisma.db.contact.count({ where: { workspaceId: w, email: "katherine@nasa.test" } })).toBe(1);

      const changed = await t.http().post(api("/leads")).set(bearer(leadKey.secret)).set("Idempotency-Key", "sync-2026-10-10-1").send({ leads: [{ fullName: "Someone Else" }] }).expect(409);
      expect(changed.body.error.message).toContain("different request");
      // Keys are per workspace: the same key elsewhere is a new request.
      await t.http().post(api("/leads", w2)).set(bearer(otherKey.secret)).set("Idempotency-Key", "sync-2026-10-10-1").send(body).expect(200);
      await t.http().post(api("/leads")).set(bearer(leadKey.secret)).set("Idempotency-Key", "bad key with spaces").send(body).expect(400);
    });

    it("does not keep a key for a request that failed", async () => {
      const body = { campaignId: "00000000-0000-4000-8000-000000000000", leads: [{ fullName: "Retry Me" }] };
      await t.http().post(api("/leads")).set(bearer(leadKey.secret)).set("Idempotency-Key", "retry-1").send(body).expect(404);
      expect(await t.prisma.db.idempotencyKey.count({ where: { workspaceId: w, key: "retry-1" } })).toBe(0);
      expect(await t.prisma.db.contact.count({ where: { workspaceId: w, fullName: "Retry Me" } })).toBe(0);
    });

    it("enrolls ingested leads in a launched campaign, and refuses a draft before saving anything", async () => {
      const seq = await owner.post(api("/sequences")).send({ name: "One touch", steps: [{ type: "email", config: { subject: "Hi", body: "Hello {{first_name|there}}" } }] }).expect(201);
      const camp = (await owner.post(api("/campaigns")).send({ name: "Inbound follow-up", fromSequenceId: seq.body.data.id }).expect(201)).body.data;

      const draft = await t.http().post(api("/leads")).set(bearer(leadKey.secret)).send({ campaignId: camp.id, leads: [{ fullName: "Draft Lead", email: "draft@x.test" }] }).expect(409);
      expect(draft.body.error.message).toContain("not been launched");
      expect(await t.prisma.db.contact.count({ where: { workspaceId: w, email: "draft@x.test" } })).toBe(0);

      // Test setup: mark it running rather than walking through mailboxes and launch (covered by campaigns.e2e).
      await t.prisma.db.campaign.update({ where: { id: camp.id, workspaceId: w }, data: { status: "running", startedAt: new Date() } });
      const res = await t
        .http()
        .post(api("/leads"))
        .set(bearer(leadKey.secret))
        .send({ campaignId: camp.id, leads: [{ fullName: "Mary Jackson", email: "mary@nasa.test" }, { fullName: "No Email", phone: "+14155550123" }] })
        .expect(200);
      expect(res.body.data.enrollment).toMatchObject({ campaignId: camp.id, enrolled: 1, error: null });
      expect(res.body.data.enrollment.skipped).toEqual([{ reason: "no_email", label: "no email address", count: 1 }]);
      const e = await t.prisma.db.enrollment.findMany({ where: { workspaceId: w, campaignId: camp.id }, include: { contact: true } });
      expect(e.map((x) => [x.contact.email, x.source])).toEqual([["mary@nasa.test", "api"]]);
    });

    it("respects the plan's contact limit", async () => {
      const starter = await t.prisma.db.plan.findUniqueOrThrow({ where: { key: "starter" } });
      const o3 = await signUp(t, "int-tiny@tiny.test");
      const w3 = await createWorkspace(o3, "Tiny");
      await setPlan(t, w3, "starter");
      await t.prisma.db.plan.update({ where: { id: starter.id }, data: { limits: { ...(starter.limits as object), contacts: 1 } } });
      try {
        const key = (await o3.post(api("/api-keys", w3)).send({ name: "BOS", scopes: ["leads:write"] }).expect(201)).body.data;
        const res = await t.http().post(api("/leads", w3)).set(bearer(key.secret)).send({ leads: [{ fullName: "First", email: "first@tiny.test" }, { fullName: "Second", email: "second@tiny.test" }, { fullName: "First", email: "FIRST@tiny.test" }] }).expect(200);
        expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(["created", "failed", "unchanged"]);
        expect(res.body.data.results[1].error.code).toBe("plan_limit");
        expect(await t.prisma.db.contact.count({ where: { workspaceId: w3 } })).toBe(1);
      } finally {
        await t.prisma.db.plan.update({ where: { id: starter.id }, data: { limits: starter.limits as object } });
      }
    });

    it("works for a signed-in member with contacts.import, but enrolling needs campaigns.launch", async () => {
      const res = await owner.post(api("/leads")).send({ source: "api", leads: [{ fullName: "Session Lead", email: "session@x.test" }] }).expect(200);
      expect(res.body.data.source).toBe("api");
      const viewer = await addMember(t, owner, w, "int-viewer@acme.test", "viewer");
      await viewer.post(api("/leads")).send({ leads: [{ fullName: "Viewer Lead" }] }).expect(403);
    });
  });

  describe("revocation, expiry and plan changes", () => {
    it("refuses a revoked key at once and keeps it listed", async () => {
      await t.http().get(api("/contacts")).set(bearer(readKey.secret)).expect(200);
      await owner.delete(api(`/api-keys/${readKey.id}`)).expect(200);
      const res = await t.http().get(api("/contacts")).set(bearer(readKey.secret)).expect(401);
      expect(res.body.error.message).toBe("That API key is not valid");
      await owner.delete(api(`/api-keys/${readKey.id}`)).expect(200);
      const list = await owner.get(api("/api-keys")).expect(200);
      expect(list.body.data.find((k: { id: string }) => k.id === readKey.id).status).toBe("revoked");
      expect(await t.prisma.db.auditEvent.count({ where: { workspaceId: w, action: "api_key.revoked", targetId: readKey.id } })).toBe(1);
      // Another workspace's key cannot be revoked from here.
      await owner.delete(api(`/api-keys/${otherKey.id}`)).expect(404);
    });

    it("refuses an expired key", async () => {
      const k = (await owner.post(api("/api-keys")).send({ name: "Short-lived", scopes: ["contacts:read"], expiresAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(201)).body.data;
      await t.http().get(api("/contacts")).set(bearer(k.secret)).expect(200);
      await t.prisma.db.apiKey.update({ where: { id: k.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await t.http().get(api("/contacts")).set(bearer(k.secret)).expect(401);
      const list = await owner.get(api("/api-keys")).expect(200);
      expect(list.body.data.find((x: { id: string }) => x.id === k.id).status).toBe("expired");
    });

    it("stops every key when the plan loses API access", async () => {
      await setPlan(t, w, "free");
      const res = await t.http().post(api("/leads")).set(bearer(leadKey.secret)).send({ leads: [{ fullName: "Late" }] }).expect(402);
      expect(res.body.error.details.feature).toBe("apiAccess");
      // Existing keys can still be listed and revoked on any plan.
      await owner.get(api("/api-keys")).expect(200);
      await setPlan(t, w, "growth");
    });
  });
});
