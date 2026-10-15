import { EMAIL_DESIGN_LIBRARY } from "@growthdesk/shared";
import { bootApp, createWorkspace, signUp, type Agent, type TestApp } from "./helpers.js";
import { LibrarySeedService } from "../src/workspaces/library-seed.service.js";

/*
 * The email design template library: the built-ins bootstrapped once by key
 * (edits kept, deletions sticking), platform rank on every admin route, the
 * draft → publish cycle with its checks, importing a workspace's design, the
 * workspace gallery and "use template", and new workspaces getting an
 * admin's edit to a built-in.
 */

const BLOCKS = [
  { type: "heading", id: "h1", text: "Hello {{first_name}}", level: 1, align: "left" },
  { type: "text", id: "t1", text: "A short note.", align: "left" },
  { type: "button", id: "b1", label: "Read more", url: "https://example.com", align: "left" },
];

describe("Email design template library", () => {
  let t: TestApp;
  let admin: Agent;
  let support: Agent;
  let customer: Agent;
  let workspaceId: string;
  const first = EMAIL_DESIGN_LIBRARY[0]!;
  const second = EMAIL_DESIGN_LIBRARY[1]!;

  const setRole = (userId: string, platformRole: "none" | "support" | "admin" | "owner") => t.prisma.db.user.update({ where: { id: userId }, data: { platformRole } });
  const seeds = () => t.app.get(LibrarySeedService);
  const entry = async (key: string) => (await admin.get("/v1/admin/email-designs").expect(200)).body.data.find((d: { key: string }) => d.key === key);

  beforeAll(async () => {
    t = await bootApp();
    // bootApp empties the tables after start, so fill the library the way a start does.
    expect(await seeds().ensureBuiltInDesigns()).toBe(EMAIL_DESIGN_LIBRARY.length);
    admin = await signUp(t, "lib-admin@platform.test", "Lib Admin");
    support = await signUp(t, "lib-support@platform.test", "Lib Support");
    customer = await signUp(t, "lib-customer@acme.test", "Cus Tomer");
    await setRole(admin.userId, "admin");
    await setRole(support.userId, "support");
    workspaceId = await createWorkspace(customer, "Acme Mail");
  });
  afterAll(async () => t.close());

  it("lists the built-ins, published, in library order", async () => {
    const list = (await support.get("/v1/admin/email-designs").expect(200)).body.data;
    expect(list.map((d: { key: string }) => d.key)).toEqual(EMAIL_DESIGN_LIBRARY.map((d) => d.key));
    expect(list.every((d: { status: string; builtIn: boolean }) => d.status === "published" && d.builtIn)).toBe(true);
  });

  it("keeps admin routes to platform staff, and changes to admins", async () => {
    await customer.get("/v1/admin/email-designs").expect(403);
    await support.post("/v1/admin/email-designs").send({ name: "Nope" }).expect(403);
    await support.post("/v1/admin/email-designs/preview").send({ blocks: BLOCKS }).expect(200);
    const id = (await entry(first.key)).id;
    await support.post(`/v1/admin/email-designs/${id}/unpublish`).expect(403);
    await support.delete(`/v1/admin/email-designs/${id}`).expect(403);
  });

  it("creates a draft, validates its JSON, publishes it, and audits each change", async () => {
    await admin.post("/v1/admin/email-designs").send({ name: "Bad", blocks: [{ type: "nope" }] }).expect(400);
    await admin.post("/v1/admin/email-designs").send({ name: "Bad", theme: { accent: "red" } }).expect(400);
    const created = (await admin.post("/v1/admin/email-designs").send({ name: "Spring sale!", category: "Promotion" }).expect(201)).body.data;
    expect(created).toMatchObject({ key: "spring-sale", status: "draft", builtIn: false, blocks: [] });
    // Nothing to send yet.
    await admin.post(`/v1/admin/email-designs/${created.id}/publish`).expect(400);
    const updated = (await admin.patch(`/v1/admin/email-designs/${created.id}`).send({ blocks: BLOCKS, description: "For seasonal offers" }).expect(200)).body.data;
    expect(updated.blocks).toHaveLength(3);
    const published = (await admin.post(`/v1/admin/email-designs/${created.id}/publish`).expect(200)).body.data;
    expect(published.status).toBe("published");
    // A published entry stays sendable.
    await admin
      .patch(`/v1/admin/email-designs/${created.id}`)
      .send({ blocks: [{ type: "button", id: "x", label: "Go", url: "not a url", align: "left" }] })
      .expect(400);
    // The same name again gets the next free key.
    expect((await admin.post("/v1/admin/email-designs").send({ name: "Spring sale" }).expect(201)).body.data.key).toBe("spring-sale-2");
    const preview = (await admin.post("/v1/admin/email-designs/preview").send({ blocks: BLOCKS }).expect(200)).body.data;
    expect(preview.html).toContain("Hello Alex");
    expect(preview.problems).toEqual([]);
    const actions = (await t.prisma.db.auditEvent.findMany({ where: { targetId: created.id }, select: { action: true, actorType: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["design_library.created", "design_library.updated", "design_library.published"]));
  });

  it("shows workspaces only published entries, and copies one on use", async () => {
    const gallery = (await customer.get(`/v1/workspaces/${workspaceId}/marketing/design-library`).expect(200)).body.data;
    const keys = gallery.map((d: { key: string }) => d.key);
    expect(keys).toContain("spring-sale");
    expect(keys).not.toContain("spring-sale-2");
    const sale = gallery.find((d: { key: string }) => d.key === "spring-sale");
    const design = (await customer.post(`/v1/workspaces/${workspaceId}/marketing/design-library/${sale.id}/use`).expect(201)).body.data;
    expect(design).toMatchObject({ name: "Spring sale!", fromLibrary: true });
    expect(design.blocks).toHaveLength(3);
    expect((await t.prisma.db.emailDesign.findFirst({ where: { id: design.id, workspaceId } }))?.libraryKey).toBe("spring-sale");
    // A draft cannot be used, and nobody outside the workspace can use its gallery.
    const draft = await entry("spring-sale-2");
    await customer.post(`/v1/workspaces/${workspaceId}/marketing/design-library/${draft.id}/use`).expect(404);
    await admin.get(`/v1/workspaces/${workspaceId}/marketing/design-library`).expect(404);
  });

  it("imports a design from the admin's own workspace, or a customer's only under a support grant", async () => {
    // Staff publishing their own design (the web app's "Publish to template library").
    const staffWs = await createWorkspace(admin, "Platform Team");
    const mine = (await admin.post(`/v1/workspaces/${staffWs}/marketing/designs`).send({ name: "Team pick", blocks: BLOCKS }).expect(201)).body.data;
    expect((await admin.post("/v1/admin/email-designs/import").send({ workspaceId: staffWs, designId: mine.id }).expect(201)).body.data).toMatchObject({ key: "team-pick", status: "draft" });

    const own = (await customer.post(`/v1/workspaces/${workspaceId}/marketing/designs`).send({ name: "Our newsletter", blocks: BLOCKS }).expect(201)).body.data;
    await support.get(`/v1/admin/email-designs/sources/${workspaceId}`).expect(403);
    // A customer's designs are theirs: no grant, no read.
    await admin.get(`/v1/admin/email-designs/sources/${workspaceId}`).expect(403);
    await admin.post("/v1/admin/email-designs/import").send({ workspaceId, designId: own.id }).expect(403);
    await customer.post(`/v1/workspaces/${workspaceId}/support-access`).send({ hours: 2, reason: "Share our newsletter layout" }).expect(201);
    const sources = (await admin.get(`/v1/admin/email-designs/sources/${workspaceId}`).expect(200)).body.data;
    expect(sources.workspace.name).toBe("Acme Mail");
    expect(sources.designs.map((d: { id: string }) => d.id)).toContain(own.id);
    await customer.post("/v1/admin/email-designs/import").send({ workspaceId, designId: own.id }).expect(403);
    await admin.post("/v1/admin/email-designs/import").send({ workspaceId: "00000000-0000-4000-8000-000000000000", designId: own.id }).expect(404);
    const imported = (await admin.post("/v1/admin/email-designs/import").send({ workspaceId, designId: own.id, category: "Newsletter" }).expect(201)).body.data;
    expect(imported).toMatchObject({ key: "our-newsletter", name: "Our newsletter", status: "draft", category: "Newsletter" });
    expect(imported.blocks).toHaveLength(3);
    // Filed in the customer's own audit log, with the support view's read.
    const audit = await t.prisma.db.auditEvent.findFirst({ where: { targetId: imported.id, action: "design_library.imported" } });
    expect(audit).toMatchObject({ workspaceId, actorType: "platform_admin", metadata: expect.objectContaining({ designId: own.id }) });
    expect(await t.prisma.db.auditEvent.count({ where: { workspaceId, action: "platform.support_viewed" } })).toBeGreaterThanOrEqual(2);
  });

  it("gives new workspaces an admin's edit to a built-in; deleting one sticks across restarts", async () => {
    const launch = await entry(first.key);
    await admin.patch(`/v1/admin/email-designs/${launch.id}`).send({ name: "Launch, our way" }).expect(200);
    const newsletter = await entry(second.key);
    await admin.delete(`/v1/admin/email-designs/${newsletter.id}`).expect(200);
    await admin.get(`/v1/admin/email-designs/${newsletter.id}`).expect(404);

    // A restart: neither the edit nor the deletion is undone.
    expect(await seeds().ensureBuiltInDesigns()).toBe(0);
    expect((await entry(first.key)).name).toBe("Launch, our way");
    expect(await entry(second.key)).toBeUndefined();

    const other = await signUp(t, "lib-other@acme.test", "Other Person");
    const fresh = await createWorkspace(other, "Acme Two");
    const designs = await t.prisma.db.emailDesign.findMany({ where: { workspaceId: fresh }, select: { name: true, libraryKey: true } });
    expect(designs.find((d) => d.libraryKey === first.key)?.name).toBe("Launch, our way");
    expect(designs.some((d) => d.libraryKey === second.key)).toBe(false);
    // Admin-made entries are offered in the gallery, not copied into every workspace.
    expect(designs.some((d) => d.libraryKey === "spring-sale")).toBe(false);
  });
});
