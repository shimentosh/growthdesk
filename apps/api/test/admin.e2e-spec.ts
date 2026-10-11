import request from "supertest";
import type { App } from "supertest/types.js";
import { bootApp, createWorkspace, signUp, type Agent, type TestApp } from "./helpers.js";
import { PlatformSettingsService } from "../src/core/platform-settings.service.js";
import { StripeProvider } from "../src/billing/providers/stripe.provider.js";

/*
 * Platform super-admin: rank gates on every route, the per-target rank rules,
 * audit rows for every change, and the effects of suspension, disabling,
 * maintenance mode and support access grants on customers.
 */

describe("Platform admin", () => {
  let t: TestApp;
  let owner: Agent; // platform owner
  let admin: Agent; // platform admin
  let support: Agent; // platform support
  let customer: Agent; // a customer with a workspace
  let w: string;
  let accountId: string;

  const setRole = (userId: string, platformRole: "none" | "support" | "admin" | "owner") =>
    t.prisma.db.user.update({ where: { id: userId }, data: { platformRole } });

  const auditRows = (action: string) => t.prisma.db.auditEvent.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "owner@platform.test", "Plat Owner");
    admin = await signUp(t, "admin@platform.test", "Plat Admin");
    support = await signUp(t, "support@platform.test", "Plat Support");
    customer = await signUp(t, "customer@acme.test", "Cus Tomer");
    await setRole(owner.userId, "owner");
    await setRole(admin.userId, "admin");
    await setRole(support.userId, "support");
    w = await createWorkspace(customer, "Acme Customer");
    accountId = (await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w } })).billingAccountId;
  });
  afterAll(async () => t.close());

  describe("access", () => {
    it("refuses signed-out visitors and customers", async () => {
      await t.http().get("/v1/admin/overview").expect(401);
      const res = await customer.get("/v1/admin/overview").expect(403);
      expect(res.body.error.code).toBe("forbidden");
      await customer.get("/v1/admin/users").expect(403);
      await customer.get("/v1/admin/support/cases").expect(403);
      await customer.post(`/v1/admin/workspaces/${w}/suspend`).send({ reason: "x" }).expect(403);
      await customer.patch("/v1/admin/settings").send({ maintenanceMode: true }).expect(403);
    });

    it("lets support read but not change", async () => {
      const overview = await support.get("/v1/admin/overview").expect(200);
      expect(overview.body.data.users.total).toBe(4);
      expect(overview.body.data.users.staff).toBe(3);
      expect(overview.body.data.workspaces.total).toBe(1);
      await support.get("/v1/admin/users?q=customer").expect(200);
      await support.get(`/v1/admin/workspaces/${w}`).expect(200);
      await support.post(`/v1/admin/workspaces/${w}/suspend`).send({ reason: "Abuse" }).expect(403);
      await support.post(`/v1/admin/users/${customer.userId}/disable`).send({ reason: "x" }).expect(403);
      await support.put(`/v1/admin/users/${customer.userId}/platform-role`).send({ role: "support" }).expect(403);
      await support.patch("/v1/admin/settings").send({ outreachEnabled: false }).expect(403);
    });

    it("answers 404 for an unknown user or workspace", async () => {
      await admin.get("/v1/admin/users/00000000-0000-4000-8000-000000000000").expect(404);
      await admin.get("/v1/admin/workspaces/not-a-uuid").expect(404);
    });
  });

  describe("users", () => {
    it("searches and filters users", async () => {
      const staff = await admin.get("/v1/admin/users?scope=staff").expect(200);
      expect(staff.body.data.items.map((u: { email: string }) => u.email).sort()).toEqual(["admin@platform.test", "owner@platform.test", "support@platform.test"]);
      const found = await admin.get("/v1/admin/users?q=acme").expect(200);
      expect(found.body.data.total).toBe(1);
      expect(found.body.data.items[0]).toMatchObject({ email: "customer@acme.test", platformRole: "none", workspaceCount: 1 });
      const detail = await admin.get(`/v1/admin/users/${customer.userId}`).expect(200);
      expect(detail.body.data.memberships[0]).toMatchObject({ workspaceId: w, role: "owner" });
      expect(detail.body.data.sessions.length).toBeGreaterThan(0);
    });

    it("enforces platform role ranks", async () => {
      // Nobody changes their own role.
      await admin.put(`/v1/admin/users/${admin.userId}/platform-role`).send({ role: "owner" }).expect(403);
      // An admin cannot grant admin or owner…
      await admin.put(`/v1/admin/users/${customer.userId}/platform-role`).send({ role: "admin" }).expect(403);
      await admin.put(`/v1/admin/users/${customer.userId}/platform-role`).send({ role: "owner" }).expect(403);
      // …nor touch someone at or above their rank.
      await admin.put(`/v1/admin/users/${owner.userId}/platform-role`).send({ role: "none" }).expect(403);
      // An admin may grant and remove support.
      const up = await admin.put(`/v1/admin/users/${customer.userId}/platform-role`).send({ role: "support" }).expect(200);
      expect(up.body.data.platformRole).toBe("support");
      await customer.get("/v1/admin/overview").expect(200);
      await admin.put(`/v1/admin/users/${customer.userId}/platform-role`).send({ role: "none" }).expect(200);
      await customer.get("/v1/admin/overview").expect(403);
      // The platform owner may appoint admins.
      await owner.put(`/v1/admin/users/${support.userId}/platform-role`).send({ role: "admin" }).expect(200);
      await owner.put(`/v1/admin/users/${support.userId}/platform-role`).send({ role: "support" }).expect(200);

      const rows = await auditRows("platform.role_changed");
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatchObject({ actorType: "platform_admin", actorUserId: admin.userId, targetType: "user", targetId: customer.userId, workspaceId: null });
      expect(rows[0]!.metadata).toMatchObject({ from: "none", to: "support" });
    });

    it("disables and re-enables an account", async () => {
      const victim = await signUp(t, "victim@acme.test", "Vic Tim");
      await victim.get("/v1/auth/me").expect(200);
      // Rank: an admin cannot disable the platform owner or themselves.
      await admin.post(`/v1/admin/users/${owner.userId}/disable`).send({ reason: "no" }).expect(403);
      await admin.post(`/v1/admin/users/${admin.userId}/disable`).send({ reason: "no" }).expect(403);
      await admin.post(`/v1/admin/users/${victim.userId}/disable`).send({ reason: "" }).expect(400);

      const res = await admin.post(`/v1/admin/users/${victim.userId}/disable`).send({ reason: "Spam reports" }).expect(200);
      expect(res.body.data.disabledReason).toBe("Spam reports");
      expect(res.body.data.sessions).toHaveLength(0);
      await victim.get("/v1/auth/me").expect(401);
      const login = await t.http().post("/v1/auth/login").send({ email: "victim@acme.test", password: "Correct-horse-9" }).expect(403);
      expect(login.body.error.message).toMatch(/suspended/);

      await admin.post(`/v1/admin/users/${victim.userId}/enable`).send({}).expect(200);
      await admin.post(`/v1/admin/users/${victim.userId}/enable`).send({}).expect(409);
      await t.http().post("/v1/auth/login").send({ email: "victim@acme.test", password: "Correct-horse-9" }).expect(200);

      expect(await auditRows("platform.user_disabled")).toHaveLength(1);
      expect(await auditRows("platform.user_enabled")).toHaveLength(1);
    });

    it("signs a person out everywhere", async () => {
      const second = request.agent(t.app.getHttpServer() as App);
      await second.post("/v1/auth/login").send({ email: "customer@acme.test", password: "Correct-horse-9" }).expect(200);
      await support.post(`/v1/admin/users/${customer.userId}/sign-out`).send({}).expect(403);
      const res = await admin.post(`/v1/admin/users/${customer.userId}/sign-out`).send({}).expect(200);
      expect(res.body.data.sessionsEnded).toBeGreaterThanOrEqual(2);
      await customer.get("/v1/auth/me").expect(401);
      await second.get("/v1/auth/me").expect(401);
      const [row] = await auditRows("platform.user_signed_out");
      expect(row).toMatchObject({ targetId: customer.userId, actorUserId: admin.userId });
      // Sign the customer back in for the tests below.
      await customer.post("/v1/auth/login").send({ email: "customer@acme.test", password: "Correct-horse-9" }).expect(200);
    });
  });

  describe("workspaces", () => {
    it("suspends a workspace: writes are refused, the customer can still read it", async () => {
      await admin.post(`/v1/admin/workspaces/${w}/suspend`).send({ reason: "" }).expect(400);
      const res = await admin.post(`/v1/admin/workspaces/${w}/suspend`).send({ reason: "Unpaid invoices" }).expect(200);
      expect(res.body.data).toMatchObject({ status: "suspended", suspendedReason: "Unpaid invoices" });
      await admin.post(`/v1/admin/workspaces/${w}/suspend`).send({ reason: "Again" }).expect(409);

      const write = await customer.patch(`/v1/workspaces/${w}`).send({ name: "Renamed" }).expect(423);
      expect(write.body.error.message).toMatch(/Unpaid invoices/);
      await customer.get(`/v1/workspaces/${w}/members`).expect(423);
      const detail = await customer.get(`/v1/workspaces/${w}`).expect(200);
      expect(detail.body.data.status).toBe("suspended");

      // Only the @AllowSuspended routes stay open; the audit log is not one of them.
      const log = await customer.get(`/v1/workspaces/${w}/audit`).expect(423);
      expect(log.body.error.code).toBe("locked");
      const [row] = await auditRows("platform.workspace_suspended");
      expect(row).toMatchObject({ workspaceId: w, actorType: "platform_admin", actorUserId: admin.userId });

      const list = await support.get("/v1/admin/workspaces?status=suspended").expect(200);
      expect(list.body.data.items.map((x: { id: string }) => x.id)).toEqual([w]);

      await admin.post(`/v1/admin/workspaces/${w}/unsuspend`).send({}).expect(200);
      await admin.post(`/v1/admin/workspaces/${w}/unsuspend`).send({}).expect(409);
      await customer.patch(`/v1/workspaces/${w}`).send({ name: "Acme Customer" }).expect(200);
      const audit = await customer.get(`/v1/workspaces/${w}/audit`).expect(200);
      expect(audit.body.data.items.map((e: { action: string }) => e.action)).toEqual(
        expect.arrayContaining(["platform.workspace_suspended", "platform.workspace_unsuspended"]),
      );
    });

    it("shows usage against limits", async () => {
      const res = await support.get(`/v1/admin/workspaces/${w}`).expect(200);
      expect(res.body.data.plan.usage.workspaces).toMatchObject({ used: 1 });
      expect(res.body.data.plan.usage.seats.used).toBe(1);
      expect(res.body.data.members).toHaveLength(1);
      expect(res.body.data.billingAccount.id).toBe(accountId);
    });
  });

  describe("billing", () => {
    it("assigns a manual plan, audited, and refuses to override Stripe", async () => {
      await support.post(`/v1/admin/billing-accounts/${accountId}/assign-plan`).send({ planKey: "agency", reason: "Partner" }).expect(403);
      await admin.post(`/v1/admin/billing-accounts/${accountId}/assign-plan`).send({ planKey: "agency" }).expect(400);
      const res = await admin.post(`/v1/admin/billing-accounts/${accountId}/assign-plan`).send({ planKey: "agency", reason: "Invoiced annually" }).expect(200);
      expect(res.body.data.plan).toMatchObject({ key: "agency", state: "active" });
      expect(res.body.data.plan.subscription.provider).toBe("manual");
      const [row] = await auditRows("platform.plan_assigned");
      expect(row).toMatchObject({ workspaceId: w, targetId: accountId, actorType: "platform_admin" });

      await t.prisma.db.subscription.update({ where: { billingAccountId: accountId }, data: { provider: "stripe", providerSubscriptionId: "sub_admin_test", status: "active" } });
      const detail = await admin.get(`/v1/admin/billing-accounts/${accountId}`).expect(200);
      expect(detail.body.data.manualAssign.allowed).toBe(false);
      await admin.post(`/v1/admin/billing-accounts/${accountId}/assign-plan`).send({ planKey: "free", reason: "Comp" }).expect(409);
      await t.prisma.db.subscription.update({ where: { billingAccountId: accountId }, data: { provider: "manual", providerSubscriptionId: null } });
    });

    it("edits plans, refusing to deactivate the fallback plan", async () => {
      const plans = await support.get("/v1/admin/plans").expect(200);
      const starter = plans.body.data.find((p: { key: string }) => p.key === "starter");
      const body = { ...starter, providerPrices: { stripe: { month: "price_123", year: "" } } };
      for (const k of ["id", "key", "subscriptions", "isDefault", "isExpiredFallback", "updatedAt"]) delete body[k];
      await support.put("/v1/admin/plans/starter").send(body).expect(403);
      // The amount is copied from the Stripe price the id points at, not from the form (docs/GAP_PLAN.md §3.1.7).
      t.app.get(StripeProvider).fetchPrice = async (id: string) => ({ id, active: true, amountCents: 4900, currency: "USD", interval: "month", intervalCount: 1 });
      const saved = await admin.put("/v1/admin/plans/starter").send({ ...body, monthlyPriceCents: 1 }).expect(200);
      expect(saved.body.data).toMatchObject({ monthlyPriceCents: 4900, providerPrices: { stripe: { month: "price_123" } }, priceNotices: [] });
      await admin.put("/v1/admin/plans/free").send({ ...body, name: "Free", isActive: false }).expect(409);
      await admin.put("/v1/admin/plans/starter").send({ ...body, limits: { ...body.limits, bogus: 1 } }).expect(400);
      const [row] = await auditRows("platform.plan_updated");
      expect(row!.metadata).toMatchObject({ key: "starter" });
    });
  });

  describe("platform settings", () => {
    it("maintenance mode refuses customer writes but not staff", async () => {
      await admin.patch("/v1/admin/settings").send({ maintenanceMode: true, maintenanceMessage: "Back at 10:00 UTC" }).expect(200);
      t.app.get(PlatformSettingsService).invalidate();
      const res = await customer.patch(`/v1/workspaces/${w}`).send({ name: "During maintenance" }).expect(503);
      expect(res.body.error.message).toBe("Back at 10:00 UTC");
      await customer.get(`/v1/workspaces/${w}`).expect(200);
      // Staff can still switch it off.
      await admin.patch("/v1/admin/settings").send({ maintenanceMode: false }).expect(200);
      await customer.patch(`/v1/workspaces/${w}`).send({ name: "Acme Customer" }).expect(200);

      const rows = await auditRows("platform.settings_updated");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.metadata).toMatchObject({ changes: { maintenanceMode: true, maintenanceMessage: "Back at 10:00 UTC" } });
    });

    it("validates settings and never returns the AI key", async () => {
      await admin.patch("/v1/admin/settings").send({ defaultPlanKey: "nope" }).expect(400);
      await admin.patch("/v1/admin/settings").send({ signupDomains: ["not a domain"] }).expect(400);
      const res = await admin.patch("/v1/admin/settings").send({ outreachEnabled: false, aiApiKey: "sk-secret-value" }).expect(200);
      expect(res.body.data.outreachEnabled).toBe(false);
      expect(res.body.data.aiApiKeySet).toBe(true);
      expect(JSON.stringify(res.body.data)).not.toContain("sk-secret-value");
      const rows = await auditRows("platform.settings_updated");
      expect(JSON.stringify(rows.at(-1)!.metadata)).not.toContain("sk-secret-value");
      await admin.patch("/v1/admin/settings").send({ outreachEnabled: true, aiApiKey: "" }).expect(200);
    });
  });

  describe("support", () => {
    it("opens the support view only under an active grant, and logs every look", async () => {
      const denied = await support.get(`/v1/admin/support/workspaces/${w}`).expect(403);
      expect(denied.body.error.message).toMatch(/Support access/);
      await support.get(`/v1/admin/support/workspaces/${w}/contacts`).expect(403);

      await customer.post(`/v1/workspaces/${w}/support-access`).send({ hours: 2, reason: "Replies missing" }).expect(201);
      const grants = await support.get("/v1/admin/support/grants").expect(200);
      expect(grants.body.data).toHaveLength(1);
      const view = await support.get(`/v1/admin/support/workspaces/${w}`).expect(200);
      expect(view.body.data.grant.reason).toBe("Replies missing");
      expect(view.body.data.counts).toMatchObject({ contacts: 0, conversations: 0 });
      await support.get(`/v1/admin/support/workspaces/${w}/contacts?q=x`).expect(200);
      await support.get(`/v1/admin/support/workspaces/${w}/conversations`).expect(200);

      const viewed = await auditRows("platform.support_viewed");
      expect(viewed).toHaveLength(3);
      expect(viewed[0]).toMatchObject({ workspaceId: w, actorUserId: support.userId, actorType: "platform_admin" });

      await customer.delete(`/v1/workspaces/${w}/support-access`).expect(200);
      await support.get(`/v1/admin/support/workspaces/${w}`).expect(403);

      // An expired grant does not open it either.
      await t.prisma.db.supportAccessGrant.create({ data: { workspaceId: w, grantedById: customer.userId, reason: "old", expiresAt: new Date(Date.now() - 1000) } });
      await support.get(`/v1/admin/support/workspaces/${w}`).expect(403);
    });

    it("works a case: open, note, assign, close", async () => {
      await customer.post("/v1/admin/support/cases").send({ subject: "Help", body: "x" }).expect(403);
      await support.post("/v1/admin/support/cases").send({ subject: "Help", body: "x", userEmail: "nobody@nowhere.test" }).expect(400);
      const opened = await support
        .post("/v1/admin/support/cases")
        .send({ subject: "Replies not syncing", body: "Customer emailed about missing replies.", priority: "high", workspaceId: w, userEmail: "customer@acme.test" })
        .expect(201);
      const id = opened.body.data.id as string;
      expect(opened.body.data).toMatchObject({ status: "open", priority: "high", workspace: { id: w }, user: { email: "customer@acme.test" }, assignee: { id: support.userId } });

      const noted = await support.post(`/v1/admin/support/cases/${id}/notes`).send({ body: "Checked IMAP: auth error." }).expect(201);
      expect(noted.body.data.notes).toHaveLength(1);
      await support.patch(`/v1/admin/support/cases/${id}`).send({ assigneeId: customer.userId }).expect(400);
      await support.patch(`/v1/admin/support/cases/${id}`).send({}).expect(400);
      const closed = await support.patch(`/v1/admin/support/cases/${id}`).send({ status: "closed", assigneeId: admin.userId }).expect(200);
      expect(closed.body.data.status).toBe("closed");
      expect(closed.body.data.closedAt).toBeTruthy();
      expect(closed.body.data.assignee.id).toBe(admin.userId);

      const list = await support.get("/v1/admin/support/cases?status=closed").expect(200);
      expect(list.body.data.items[0]).toMatchObject({ id, notes: 1 });
      expect(await auditRows("platform.support_case_opened")).toHaveLength(1);
      expect(await auditRows("platform.support_note_added")).toHaveLength(1);
      expect((await auditRows("platform.support_case_updated"))[0]!.metadata).toMatchObject({ changes: { status: { from: "open", to: "closed" } } });
    });
  });

  describe("logs", () => {
    it("filters the platform audit log", async () => {
      const res = await support.get(`/v1/admin/audit?action=platform.&workspaceId=${w}`).expect(200);
      expect(res.body.data.total).toBeGreaterThan(0);
      for (const e of res.body.data.items) {
        expect(e.action.startsWith("platform.")).toBe(true);
        expect(e.workspace).toMatchObject({ id: w });
      }
      await support.get("/v1/admin/audit?workspaceId=nope").expect(400);
    });

    it("lists the platform's own email", async () => {
      const res = await support.get("/v1/admin/email-log?template=verify_email").expect(200);
      expect(res.body.data.total).toBeGreaterThanOrEqual(5);
      expect(res.body.data.templates).toContain("verify_email");
      const one = await support.get("/v1/admin/email-log?q=victim").expect(200);
      expect(one.body.data.items.every((m: { to: string }) => m.to === "victim@acme.test")).toBe(true);
    });
  });
});
