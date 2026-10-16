import { bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { ImportsService } from "../src/crm/imports.service.js";
import { EmailValidationService, MailDomainResolver } from "../src/core/email-validation.service.js";
import { PlatformSettingsService } from "../src/core/platform-settings.service.js";

/*
 * Contact email validation, switched on from the platform admin: only valid
 * addresses get into the CRM by hand, CSV or the leads API. DNS is faked: real.test
 * has a mail server, everything else does not exist.
 */
describe("Contact email validation", () => {
  let t: TestApp;
  let admin: Agent;
  let owner: Agent;
  let w: string;

  const enable = async (patch: Record<string, unknown> = {}) => {
    await admin.patch("/v1/admin/settings").send({ contactEmailValidation: { enabled: true, ...patch } }).expect(200);
    t.app.get(PlatformSettingsService).invalidate();
  };

  beforeAll(async () => {
    t = await bootApp();
    admin = await signUp(t, "admin@platform.test", "Plat Admin");
    await t.prisma.db.user.update({ where: { email: "admin@platform.test" }, data: { platformRole: "admin" } });
    owner = await signUp(t, "owner@validation.test");
    w = await createWorkspace(owner, "Validation Co");
    await setPlan(t, w, "growth");

    const resolver = t.app.get(MailDomainResolver);
    resolver.mx = async (d) => {
      if (d === "real.test") return [{ exchange: "mx.real.test", priority: 10 }];
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    };
    resolver.address = async () => false;
    t.app.get(EmailValidationService).forget();
  });
  afterAll(async () => t.close());

  it("is off by default: a contact on a dead domain is created as before", async () => {
    await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Before", email: "before@dead.test" }).expect(201);
  });

  it("the admin turns it on; a partial patch keeps the other switches", async () => {
    await enable();
    const res = await admin.get("/v1/admin/settings").expect(200);
    expect(res.body.data.contactEmailValidation).toEqual({ enabled: true, blockDisposable: true, checkMailServer: true, blockRoleAccounts: false, blockedDomains: [] });
    await admin.patch("/v1/admin/settings").send({ contactEmailValidation: { blockedDomains: ["not a domain"] } }).expect(400);
  });

  it("refuses a hand-added contact with a disposable or dead address, and accepts a real one", async () => {
    const disposable = await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Temp", email: "temp@mailinator.com" }).expect(400);
    expect(disposable.body.error).toMatchObject({ code: "email_rejected", fields: { email: "disposable" } });
    const dead = await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Dead", email: "x@dead.test" }).expect(400);
    expect(dead.body.error.message).toContain("cannot receive email");
    const ok = await owner.post(`/v1/workspaces/${w}/contacts`).send({ fullName: "Real", email: "real@real.test" }).expect(201);

    // Changing the email to a bad one is refused too; other edits still work on a contact made before validation.
    await owner.patch(`/v1/workspaces/${w}/contacts/${ok.body.data.id}`).send({ email: "x@dead.test" }).expect(400);
    const before = await t.prisma.db.contact.findFirstOrThrow({ where: { workspaceId: w, email: "before@dead.test" } });
    await owner.patch(`/v1/workspaces/${w}/contacts/${before.id}`).send({ jobTitle: "CTO", email: "before@dead.test" }).expect(200);
  });

  it("imports only the rows with valid addresses and says why the others failed", async () => {
    await enable({ blockRoleAccounts: true });
    const csv = [
      "Name,Email",
      "Good One,good@real.test",
      "Gmail Person,someone@gmail.com",
      "Throwaway,t@mailinator.com",
      "Nowhere,n@nowhere.test",
      "Shared Inbox,info@real.test",
      "Broken,not-an-email",
      "Phone Only,",
    ].join("\n");
    const started = await owner
      .post(`/v1/workspaces/${w}/imports`)
      .send({ fileName: "leads.csv", csv, mapping: { Name: "fullName", Email: "email" }, onDuplicate: "update" })
      .expect(201);
    await t.app.get(ImportsService).process(w, started.body.data.id);
    const imp = (await owner.get(`/v1/workspaces/${w}/imports/${started.body.data.id}`).expect(200)).body.data;
    expect(imp.createdCount).toBe(3); // good@real.test, someone@gmail.com, and the name-only row
    expect(imp.failedCount).toBe(4);
    const messages = imp.errors.map((e: { row: number; message: string }) => `${e.row}: ${e.message}`);
    expect(messages).toEqual([
      expect.stringMatching(/^4: .*disposable/),
      expect.stringMatching(/^5: .*cannot receive email/),
      expect.stringMatching(/^6: .*role mailbox/),
      expect.stringMatching(/^7: .*not a valid email address/),
    ]);
    const emails = (await t.prisma.db.contact.findMany({ where: { workspaceId: w } })).map((c) => c.email);
    expect(emails).toEqual(expect.arrayContaining(["good@real.test", "someone@gmail.com"]));
    for (const refused of ["t@mailinator.com", "n@nowhere.test", "info@real.test"]) expect(emails).not.toContain(refused);
  });

  it("refuses a bad lead from the leads API without failing the batch", async () => {
    const key = (await owner.post(`/v1/workspaces/${w}/api-keys`).send({ name: "Leads", scopes: ["leads:write"] }).expect(201)).body.data;
    const res = await t
      .http()
      .post(`/v1/workspaces/${w}/leads`)
      .set({ Authorization: `Bearer ${key.secret}` })
      .send({ leads: [{ fullName: "Ok", email: "ok@real.test" }, { fullName: "Bad", email: "bad@mailinator.com" }] });
    expect(res.status).toBeLessThan(300);
    expect(res.body.data.summary).toMatchObject({ received: 2, created: 1, failed: 1 });
    const bad = res.body.data.results.find((r: { status: string }) => r.status === "failed");
    expect(bad.error).toMatchObject({ code: "email_rejected" });
  });

  it("the admin's test box explains every check", async () => {
    const res = await admin.post("/v1/admin/settings/email-validation/test").send({ email: "n@nowhere.test" }).expect(200);
    expect(res.body.data).toMatchObject({ enabled: true, ok: false, reason: "mail_server" });
    expect(res.body.data.checks.map((c: { check: string }) => c.check)).toEqual(["syntax", "disposable", "role", "mail_server"]);
    await owner.post("/v1/admin/settings/email-validation/test").send({ email: "a@b.test" }).expect(403);
  });
});
