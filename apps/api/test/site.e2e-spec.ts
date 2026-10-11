import { DEFAULT_SITE_LANDING, SITE_DEFAULTS } from "@growthdesk/shared";
import { bootApp, createWorkspace, signUp, type Agent, type TestApp } from "./helpers.js";
import { PlatformSettingsService } from "../src/core/platform-settings.service.js";

/*
 * The public website: defaults before anything is published, the draft →
 * publish → discard cycle, branding reaching every reader as soon as it is
 * published, the image upload checks (size, type by magic bytes, never SVG),
 * platform rank on every admin route, and legal slugs.
 */

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const pngBytes = Buffer.from(PNG_1x1, "base64");
/** An ICO wrapping the PNG above (ICONDIR + one ICONDIRENTRY + PNG data). */
const icoBytes = (() => {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt8(1, 6);
  head.writeUInt8(1, 7);
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(pngBytes.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, pngBytes]);
})();
const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0"), Buffer.alloc(64, 1), Buffer.from([0xff, 0xd9])]);
const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");

describe("Public site", () => {
  let t: TestApp;
  let admin: Agent;
  let support: Agent;
  let customer: Agent;

  const setRole = (userId: string, platformRole: "none" | "support" | "admin" | "owner") =>
    t.prisma.db.user.update({ where: { id: userId }, data: { platformRole } });
  const site = async () => (await t.http().get("/v1/site").expect(200)).body.data;

  beforeAll(async () => {
    t = await bootApp();
    admin = await signUp(t, "site-admin@platform.test", "Site Admin");
    support = await signUp(t, "site-support@platform.test", "Site Support");
    customer = await signUp(t, "site-customer@acme.test", "Cus Tomer");
    await setRole(admin.userId, "admin");
    await setRole(support.userId, "support");
  });
  afterAll(async () => t.close());

  describe("defaults", () => {
    it("serves the built-in content before anything is published, with a short public cache", async () => {
      const res = await t.http().get("/v1/site").expect(200);
      expect(res.headers["cache-control"]).toMatch(/^public, max-age=60/);
      const d = res.body.data;
      expect(d).toMatchObject({
        productName: "Growthdesk",
        supportEmail: "",
        primaryColor: "",
        logoUrl: null,
        faviconUrl: null,
        landingEnabled: true,
        announcement: null,
        analytics: { provider: "none", plausibleDomain: "", ga4MeasurementId: "" },
        seo: { title: "", ogImageUrl: null },
      });
      expect(d.landing.hero.headline).toBe(DEFAULT_SITE_LANDING.hero.headline);
      expect(d.landing.testimonials.items).toEqual([]);
      expect(d.landing.features.items.length).toBeGreaterThan(0);
      // {{product_name}} is filled in for readers.
      expect(JSON.stringify(d)).not.toContain("{{product_name}}");
      expect(JSON.stringify(d.landing.faq)).toContain("Growthdesk");
    });

    it("serves both legal pages and 404s any other slug", async () => {
      const terms = (await t.http().get("/v1/site/legal/terms").expect(200)).body.data;
      expect(terms).toMatchObject({ slug: "terms", title: "Terms of Service", publishedAt: null });
      expect(terms.markdown).toContain("Growthdesk");
      expect(terms.markdown).not.toContain("{{product_name}}");
      const privacy = (await t.http().get("/v1/site/legal/privacy").expect(200)).body.data;
      expect(privacy.title).toBe("Privacy Policy");
      for (const slug of ["cookies", "Terms", "terms.md", "legal.terms", "%2e%2e"]) {
        const res = await t.http().get(`/v1/site/legal/${slug}`).expect(404);
        expect(res.body.error.code).toBe("not_found");
      }
    });

    it("follows the landingEnabled platform setting", async () => {
      const settings = t.app.get(PlatformSettingsService);
      await settings.update({ landingEnabled: false }, null);
      expect((await site()).landingEnabled).toBe(false);
      await settings.update({ landingEnabled: true }, null);
      expect((await site()).landingEnabled).toBe(true);
    });
  });

  describe("rank checks", () => {
    it("keeps signed-out visitors and customers out of the editor", async () => {
      await t.http().get("/v1/admin/site").expect(401);
      await t.http().put("/v1/admin/site/landing").send(SITE_DEFAULTS.landing).expect(401);
      await customer.get("/v1/admin/site").expect(403);
      await customer.get("/v1/admin/site/assets").expect(403);
      await customer.put("/v1/admin/site/landing").send(SITE_DEFAULTS.landing).expect(403);
      await customer.post("/v1/admin/site/landing/publish").expect(403);
      await customer.post("/v1/admin/site/assets").send({ kind: "logo", data: PNG_1x1 }).expect(403);
    });

    it("lets support read but not change", async () => {
      const view = (await support.get("/v1/admin/site").expect(200)).body.data;
      expect(Object.keys(view.content).sort()).toEqual(["analytics", "announcement", "branding", "landing", "legal.privacy", "legal.terms", "seo"]);
      expect(view.content.landing).toMatchObject({ isDefault: true, hasUnpublishedChanges: false, publishedAt: null });
      await support.get("/v1/admin/site/branding").expect(200);
      await support.get("/v1/admin/site/assets").expect(200);
      await support.put("/v1/admin/site/landing").send(SITE_DEFAULTS.landing).expect(403);
      await support.post("/v1/admin/site/landing/publish").expect(403);
      await support.post("/v1/admin/site/landing/discard").expect(403);
      await support.post("/v1/admin/site/assets").send({ kind: "logo", data: PNG_1x1 }).expect(403);
    });

    it("404s unknown content keys", async () => {
      await admin.get("/v1/admin/site/footer").expect(404);
      await admin.put("/v1/admin/site/footer").send({}).expect(404);
      await admin.post("/v1/admin/site/footer/publish").expect(404);
    });
  });

  describe("draft and publish", () => {
    const changed = { ...SITE_DEFAULTS.landing, hero: { ...SITE_DEFAULTS.landing.hero, headline: "Sell more with {{product_name}}" } };

    it("validates drafts against the key's schema", async () => {
      const bad = { ...changed, hero: { ...changed.hero, primaryCta: { label: "Go", href: "javascript:alert(1)" } } };
      const res = await admin.put("/v1/admin/site/landing").send(bad).expect(400);
      expect(res.body.error.fields["hero.primaryCta.href"]).toBeTruthy();
      await admin.put("/v1/admin/site/landing").send({ ...changed, features: { ...changed.features, items: Array(13).fill(changed.features.items[0]) } }).expect(400);
      await admin.put("/v1/admin/site/landing").send({ ...changed, features: { ...changed.features, items: [{ icon: "skull", title: "x", body: "y" }] } }).expect(400);
      await admin.put("/v1/admin/site/analytics").send({ provider: "ga4", plausibleDomain: "", ga4MeasurementId: "UA-1234-1" }).expect(400);
      await admin.put("/v1/admin/site/analytics").send({ provider: "plausible", plausibleDomain: "", ga4MeasurementId: "" }).expect(400);
      await admin.put("/v1/admin/site/legal.terms").send({ title: "T", markdown: "x".repeat(100_001), updatedLabel: "" }).expect(400);
      await admin.put("/v1/admin/site/announcement").send({ ...SITE_DEFAULTS.announcement, enabled: true, message: "" }).expect(400);
    });

    it("keeps a saved draft off the public site until it is published", async () => {
      const saved = (await admin.put("/v1/admin/site/landing").send(changed).expect(200)).body.data;
      expect(saved).toMatchObject({ key: "landing", isDefault: false, hasUnpublishedChanges: true, publishedAt: null });
      expect(saved.draft.hero.headline).toBe("Sell more with {{product_name}}");
      expect(saved.published.hero.headline).toBe(DEFAULT_SITE_LANDING.hero.headline);
      expect((await site()).landing.hero.headline).toBe(DEFAULT_SITE_LANDING.hero.headline);

      const published = (await admin.post("/v1/admin/site/landing/publish").expect(200)).body.data;
      expect(published).toMatchObject({ hasUnpublishedChanges: false, publishedBy: { id: admin.userId } });
      expect(published.publishedAt).toBeTruthy();
      expect((await site()).landing.hero.headline).toBe("Sell more with Growthdesk");

      const audits = await t.prisma.db.auditEvent.findMany({ where: { action: { startsWith: "site." }, targetId: "landing" } });
      expect(audits.map((a) => a.action).sort()).toEqual(["site.draft_saved", "site.published"]);
      expect(audits.every((a) => a.actorType === "platform_admin" && a.actorUserId === admin.userId)).toBe(true);
    });

    it("discards a draft back to the published copy, or to the defaults if never published", async () => {
      await admin.put("/v1/admin/site/landing").send({ ...changed, hero: { ...changed.hero, headline: "Scrapped" } }).expect(200);
      const back = (await admin.post("/v1/admin/site/landing/discard").expect(200)).body.data;
      expect(back.draft.hero.headline).toBe("Sell more with {{product_name}}");
      expect(back.hasUnpublishedChanges).toBe(false);

      await admin.put("/v1/admin/site/seo").send({ title: "Draft title", description: "d", ogAssetId: null }).expect(200);
      const reset = (await admin.post("/v1/admin/site/seo/discard").expect(200)).body.data;
      expect(reset).toMatchObject({ isDefault: true, draft: SITE_DEFAULTS.seo });
      expect(await t.prisma.db.auditEvent.count({ where: { action: "site.draft_discarded" } })).toBe(2);
    });

    it("publishes an announcement with a stable id, and hides it when switched off", async () => {
      const on = { enabled: true, message: "{{product_name}} 2.0 is here", href: "/pricing", tone: "success", audience: "both", dismissible: true };
      await admin.put("/v1/admin/site/announcement").send(on).expect(200);
      expect((await site()).announcement).toBeNull();
      await admin.post("/v1/admin/site/announcement/publish").expect(200);
      const a = (await site()).announcement;
      expect(a).toMatchObject({ message: "Growthdesk 2.0 is here", href: "/pricing", tone: "success", audience: "both", dismissible: true });
      expect(a.id).toMatch(/^[0-9a-f]{16}$/);
      expect((await site()).announcement.id).toBe(a.id);
      await admin.put("/v1/admin/site/announcement").send({ ...on, enabled: false }).expect(200);
      await admin.post("/v1/admin/site/announcement/publish").expect(200);
      expect((await site()).announcement).toBeNull();
    });

    it("publishes legal pages and analytics", async () => {
      await admin.put("/v1/admin/site/legal.privacy").send({ title: "Privacy at {{product_name}}", markdown: "## Hello\n\nWe keep little.", updatedLabel: "Updated 1 Oct 2026" }).expect(200);
      await admin.post("/v1/admin/site/legal.privacy/publish").expect(200);
      const privacy = (await t.http().get("/v1/site/legal/privacy").expect(200)).body.data;
      expect(privacy).toMatchObject({ title: "Privacy at Growthdesk", markdown: "## Hello\n\nWe keep little.", updatedLabel: "Updated 1 Oct 2026" });
      expect(privacy.publishedAt).toBeTruthy();

      await admin.put("/v1/admin/site/analytics").send({ provider: "ga4", plausibleDomain: "", ga4MeasurementId: "g-ab12cd34" }).expect(200);
      await admin.post("/v1/admin/site/analytics/publish").expect(200);
      expect((await site()).analytics).toEqual({ provider: "ga4", plausibleDomain: "", ga4MeasurementId: "G-AB12CD34" });
    });
  });

  describe("assets", () => {
    let logoId: string;
    let faviconId: string;

    const upload = (body: Record<string, unknown>) => admin.post("/v1/admin/site/assets").send(body);

    it("stores a PNG and serves it with safe, immutable headers", async () => {
      const res = await upload({ kind: "logo", mime: "image/png", data: PNG_1x1 }).expect(201);
      const a = res.body.data;
      expect(a).toMatchObject({ kind: "logo", mime: "image/png", size: pngBytes.length });
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.url).toBe(`http://localhost:3600/api/site/assets/${a.id}`);
      logoId = a.id;

      const file = await t.http().get(`/v1/site/assets/${logoId}`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(Buffer.compare(file.body as Buffer, pngBytes)).toBe(0);
      expect(file.headers["content-type"]).toBe("image/png");
      expect(file.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(file.headers["x-content-type-options"]).toBe("nosniff");
      expect(file.headers["content-disposition"]).toBe('inline; filename="logo.png"');
      await t.http().get(`/v1/site/assets/${logoId}`).set("if-none-match", `"${a.sha256}"`).expect(304);

      // The same image again reuses the stored copy.
      const again = await upload({ kind: "logo", data: `data:image/png;base64,${PNG_1x1}` }).expect(201);
      expect(again.body.data.id).toBe(logoId);
      expect(await t.prisma.db.auditEvent.count({ where: { action: "site.asset_uploaded" } })).toBe(1);

      const list = (await support.get("/v1/admin/site/assets").expect(200)).body.data;
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty("bytes");
    });

    it("refuses SVG however it is labelled", async () => {
      for (const body of [
        { kind: "logo", mime: "image/svg+xml", data: b64(SVG) },
        { kind: "logo", mime: "image/png", data: b64(SVG) },
        { kind: "logo", data: b64(`  \n${SVG}`) },
        { kind: "logo", data: `data:image/svg+xml;base64,${b64(SVG)}` },
        { kind: "favicon", mime: "image/svg+xml", data: PNG_1x1 },
      ]) {
        const res = await upload(body).expect(400);
        expect(res.body.error.message).toMatch(/SVG/);
      }
    });

    it("checks size, magic bytes and the slot's allowed types", async () => {
      // Too big for the schema, and just over the limit for the decoder.
      await upload({ kind: "logo", data: b64(Buffer.alloc(300 * 1024, 1)) }).expect(400);
      const justOver = Buffer.concat([pngBytes, Buffer.alloc(256 * 1024 + 1 - pngBytes.length)]);
      expect((await upload({ kind: "logo", data: b64(justOver) }).expect(400)).body.error.message).toMatch(/256 KB/);
      // Not an image at all.
      expect((await upload({ kind: "logo", data: b64("GIF89a....") }).expect(400)).body.error.message).toMatch(/Only PNG, JPEG, WebP and ICO/);
      expect((await upload({ kind: "logo", data: "not base64!!" }).expect(400)).body.error.message).toMatch(/base64/);
      // The claimed type must match the bytes.
      expect((await upload({ kind: "logo", mime: "image/jpeg", data: PNG_1x1 }).expect(400)).body.error.message).toMatch(/do not match/);
      // Slots: ICO only as a favicon, JPEG not as a favicon.
      await upload({ kind: "logo", data: b64(icoBytes) }).expect(400);
      await upload({ kind: "favicon", data: b64(jpegBytes) }).expect(400);
      const fav = await upload({ kind: "favicon", mime: "image/vnd.microsoft.icon", data: b64(icoBytes) }).expect(201);
      expect(fav.body.data.mime).toBe("image/x-icon");
      faviconId = fav.body.data.id;
      const og = await upload({ kind: "og", mime: "image/jpeg", data: b64(jpegBytes) }).expect(201);
      expect(og.body.data.mime).toBe("image/jpeg");
      await t.http().get("/v1/site/assets/not-a-uuid").expect(404);
      await t.http().get("/v1/site/assets/0190a3c4-0000-7000-8000-000000000000").expect(404);
    });

    it("only lets branding point at existing assets of the right kind", async () => {
      const base = { ...SITE_DEFAULTS.branding, productName: "Acme Reach" };
      let res = await admin.put("/v1/admin/site/branding").send({ ...base, logoAssetId: faviconId }).expect(400);
      expect(res.body.error.fields.logoAssetId).toMatch(/favicon/);
      res = await admin.put("/v1/admin/site/branding").send({ ...base, logoAssetId: "0190a3c4-0000-7000-8000-000000000000" }).expect(400);
      expect(res.body.error.fields.logoAssetId).toMatch(/not found/);
      await admin.put("/v1/admin/site/branding").send({ ...base, logoAssetId: "nope" }).expect(400);
      await admin.put("/v1/admin/site/branding").send({ ...base, primaryColor: "red" }).expect(400);
    });
  });

  describe("branding", () => {
    it("reaches the public site and the maintenance message as soon as it is published", async () => {
      // Warm the branding cache with the old values first.
      expect((await site()).productName).toBe("Growthdesk");
      const assets = (await admin.get("/v1/admin/site/assets").expect(200)).body.data as { id: string; kind: string }[];
      const logo = assets.find((a) => a.kind === "logo")!;
      const favicon = assets.find((a) => a.kind === "favicon")!;
      await admin
        .put("/v1/admin/site/branding")
        .send({ productName: "Acme Reach", supportEmail: "help@acme.test", primaryColor: "#7c3aed", logoAssetId: logo.id, faviconAssetId: favicon.id, ogAssetId: null })
        .expect(200);
      expect((await site()).productName).toBe("Growthdesk");

      await admin.post("/v1/admin/site/branding/publish").expect(200);
      const d = await site();
      expect(d).toMatchObject({
        productName: "Acme Reach",
        supportEmail: "help@acme.test",
        primaryColor: "#7c3aed",
        logoUrl: `http://localhost:3600/api/site/assets/${logo.id}`,
        faviconUrl: `http://localhost:3600/api/site/assets/${favicon.id}`,
      });
      expect(d.landing.hero.headline).toBe("Sell more with Acme Reach");
      expect((await t.http().get("/v1/site/legal/terms").expect(200)).body.data.markdown).toContain("Acme Reach");

      const settings = t.app.get(PlatformSettingsService);
      await settings.update({ maintenanceMode: true, maintenanceMessage: "" }, null);
      try {
        const res = await customer.post("/v1/workspaces").send({ name: "Blocked", businessType: "agency", timezone: "UTC" }).expect(503);
        expect(res.body.error.message).toMatch(/^Acme Reach is in maintenance/);
      } finally {
        await settings.update({ maintenanceMode: false }, null);
      }
      await createWorkspace(customer, "Allowed again");
    });
  });
});
