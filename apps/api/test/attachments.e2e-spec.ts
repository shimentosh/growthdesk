import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Attachments: upload (base64 JSON) to contacts, companies, deals and
 * quotes; the type comes from the bytes; programs are refused; per-file and
 * per-workspace limits; list never carries bytes; download is a nosniff
 * attachment; rename; soft delete; timeline entries; the record's own
 * read/write permission and visibility; and no crossing workspaces.
 */
describe("Attachments", () => {
  let t: TestApp;
  let owner: Agent;
  let member: Agent;
  let viewer: Agent;
  let other: Agent;
  let w: string;
  let w2: string;
  const ids: Record<string, string> = {};
  const api = (p: string, ws = w) => `/v1/workspaces/${ws}${p}`;
  const b64 = (s: string | Buffer) => (typeof s === "string" ? Buffer.from(s) : s).toString("base64");
  const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
  /** Collects a download's raw bytes (supertest would otherwise try to read it as text). */
  const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  };
  const upload = (a: Agent, entityType: string, entityId: string, fileName: string, data: string | Buffer, ws = w) => a.post(api("/attachments", ws)).send({ entityType, entityId, fileName, data: b64(data) });
  const list = (a: Agent, entityType: string, entityId: string, ws = w) => a.get(api("/attachments", ws)).query({ entityType, entityId });

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "files-owner@acme.test", "Fiona Owner");
    w = await createWorkspace(owner, "Files Co");
    await setPlan(t, w, "agency");
    member = await addMember(t, owner, w, "files-member@acme.test", "member");
    viewer = await addMember(t, owner, w, "files-viewer@acme.test", "viewer");
    other = await signUp(t, "files-other@else.test", "Oscar Other");
    w2 = await createWorkspace(other, "Elsewhere");

    ids.company = (await owner.post(api("/companies")).send({ name: "Acme Ltd" }).expect(201)).body.data.id;
    ids.contact = (await owner.post(api("/contacts")).send({ fullName: "Cara Client", email: "cara@acme.example", companyId: ids.company }).expect(201)).body.data.id;
    ids.owned = (await owner.post(api("/contacts")).send({ fullName: "Owen Owned", email: "owen@acme.example", ownerId: owner.userId }).expect(201)).body.data.id;
    ids.deal = (await owner.post(api("/deals")).send({ name: "Acme pilot", contactId: ids.contact }).expect(201)).body.data.id;
    const quote = await t.prisma.db.quote.create({ data: { workspaceId: w, number: 1, title: "Pilot quote", contactId: ids.contact, publicToken: "files-test-quote-token" } });
    ids.quote = quote.id;
    ids.foreign = (await other.post(api("/contacts", w2)).send({ fullName: "Fay Foreign", email: "fay@else.example" }).expect(201)).body.data.id;
  });
  afterAll(async () => t.close());

  it("uploads to a contact, lists without bytes, and logs it on the timeline", async () => {
    const res = await upload(member, "contact", ids.contact!, "Brief.pdf", PDF).expect(201);
    ids.pdf = res.body.data.id;
    expect(res.body.data).toMatchObject({ fileName: "Brief.pdf", contentType: "application/pdf", size: PDF.length, uploadedBy: { id: member.userId } });
    expect(res.body.data.bytes).toBeUndefined();

    const listed = (await list(viewer, "contact", ids.contact!).expect(200)).body.data;
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: ids.pdf, fileName: "Brief.pdf", uploadedBy: { name: "files-member" } });
    expect(listed.items[0].bytes).toBeUndefined();
    expect(listed.limits).toMatchObject({ fileBytes: 10 * 1024 * 1024, usedBytes: PDF.length });

    const entry = await t.prisma.db.activity.findFirstOrThrow({ where: { workspaceId: w, contactId: ids.contact!, type: "file.added" } });
    expect(entry.summary).toBe("File added: Brief.pdf");
  });

  it("decides the type from the bytes and refuses programs", async () => {
    expect((await upload(owner, "contact", ids.contact!, "notes.txt", "Call notes\nGood call.").expect(201)).body.data.contentType).toBe("text/plain");
    expect((await upload(owner, "contact", ids.contact!, "page.html", "<html><script>alert(1)</script></html>").expect(201)).body.data.contentType).toBe("application/octet-stream");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect((await upload(owner, "contact", ids.contact!, "photo.txt", png).expect(201)).body.data.contentType).toBe("image/png");
    expect((await upload(owner, "contact", ids.contact!, "../../etc/report.csv", "a,b\n1,2").expect(201)).body.data.fileName).toBe("report.csv");

    await upload(owner, "contact", ids.contact!, "setup.exe", "hello").expect(400);
    await upload(owner, "contact", ids.contact!, "invoice.pdf", Buffer.from("MZ\x90\x00\x03\x00\x00\x00")).expect(400);
    await upload(owner, "contact", ids.contact!, "readme.txt", "#!/bin/sh\necho hi").expect(400);
    await owner.post(api("/attachments")).send({ entityType: "contact", entityId: ids.contact, fileName: "x.txt", data: "not base64!!" }).expect(400);
    await upload(owner, "contact", ids.contact!, "empty.txt", "").expect(400);
  });

  it("enforces the per-file and per-workspace limits", async () => {
    const big = await upload(owner, "contact", ids.contact!, "big.pdf", Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)])).expect(400);
    expect(big.body.error.message).toMatch(/up to 10 MB/);

    // A stand-in row that fills the workspace (its size, not its bytes, counts).
    const filler = await t.prisma.db.attachment.create({ data: { workspaceId: w, entityType: "contact", entityId: ids.contact!, fileName: "filler.bin", contentType: "application/octet-stream", size: 1024 * 1024 * 1024 - 100, sha256: "x", bytes: new Uint8Array([0]) } });
    const full = await upload(owner, "contact", ids.contact!, "one-more.pdf", PDF).expect(409);
    expect(full.body.error.message).toMatch(/of 1 GB/);
    await t.prisma.db.attachment.deleteMany({ where: { workspaceId: w, id: filler.id } });
  });

  it("downloads as a nosniff attachment with the stored type", async () => {
    const res = await viewer.get(api(`/attachments/${ids.pdf}/download`)).buffer(true).parse(binary as never).expect(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="Brief.pdf"; filename*=UTF-8''Brief.pdf`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
    await t.http().get(api(`/attachments/${ids.pdf}/download`)).expect(401);
  });

  it("renames and soft-deletes with the record's write permission", async () => {
    await viewer.patch(api(`/attachments/${ids.pdf}`)).send({ fileName: "x.pdf" }).expect(403);
    await viewer.delete(api(`/attachments/${ids.pdf}`)).expect(403);
    await upload(viewer, "contact", ids.contact!, "v.txt", "hi").expect(403);

    expect((await member.patch(api(`/attachments/${ids.pdf}`)).send({ fileName: "Brief v2.pdf" }).expect(200)).body.data.fileName).toBe("Brief v2.pdf");
    await member.patch(api(`/attachments/${ids.pdf}`)).send({ fileName: "Brief.exe" }).expect(400);

    await member.delete(api(`/attachments/${ids.pdf}`)).expect(200);
    await member.delete(api(`/attachments/${ids.pdf}`)).expect(404);
    await owner.get(api(`/attachments/${ids.pdf}/download`)).expect(404);
    expect((await list(owner, "contact", ids.contact!).expect(200)).body.data.items.map((i: { id: string }) => i.id)).not.toContain(ids.pdf);
    expect(await t.prisma.db.attachment.findFirstOrThrow({ where: { workspaceId: w, id: ids.pdf! } })).toMatchObject({ deletedAt: expect.any(Date) });
    expect(await t.prisma.db.activity.count({ where: { workspaceId: w, contactId: ids.contact!, type: "file.removed", summary: "File removed: Brief v2.pdf" } })).toBe(1);
  });

  it("attaches to companies, deals and quotes, each on its own timeline", async () => {
    await upload(owner, "company", ids.company!, "MSA.pdf", PDF).expect(201);
    expect(await t.prisma.db.activity.count({ where: { workspaceId: w, companyId: ids.company!, type: "file.added" } })).toBe(1);
    await upload(member, "deal", ids.deal!, "Proposal.pdf", PDF).expect(201);
    expect(await t.prisma.db.activity.count({ where: { workspaceId: w, dealId: ids.deal!, type: "file.added" } })).toBe(1);
    const q = (await upload(owner, "quote", ids.quote!, "Signed.pdf", PDF).expect(201)).body.data;
    expect(q).toMatchObject({ entityType: "quote", entityId: ids.quote });
    expect(await t.prisma.db.activity.findFirstOrThrow({ where: { workspaceId: w, contactId: ids.contact!, type: "file.added", summary: "File added: Signed.pdf" } })).toMatchObject({ data: expect.objectContaining({ quoteId: ids.quote }) });
    expect((await list(viewer, "deal", ids.deal!).expect(200)).body.data.items).toHaveLength(1);
    expect((await list(viewer, "quote", ids.quote!).expect(200)).body.data.items).toHaveLength(1);

    await list(owner, "deal", "00000000-0000-4000-8000-000000000000").expect(404);
    await owner.get(api("/attachments")).query({ entityType: "invoice", entityId: ids.deal }).expect(400);
  });

  it("follows record visibility: a member under team visibility cannot reach someone else's contact's files", async () => {
    await upload(owner, "contact", ids.owned!, "Private.pdf", PDF).expect(201);
    const row = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: w }, select: { settings: true } });
    await t.prisma.db.workspace.update({ where: { id: w }, data: { settings: { ...(row.settings as object), recordVisibility: "team" } } });
    const file = await t.prisma.db.attachment.findFirstOrThrow({ where: { workspaceId: w, entityId: ids.owned!, deletedAt: null } });
    await list(member, "contact", ids.owned!).expect(404);
    await member.get(api(`/attachments/${file.id}/download`)).expect(404);
    await member.delete(api(`/attachments/${file.id}`)).expect(404);
    // Unowned contacts stay visible.
    await list(member, "contact", ids.contact!).expect(200);
    await t.prisma.db.workspace.update({ where: { id: w }, data: { settings: row.settings as object } });
  });

  it("keeps workspaces apart", async () => {
    const mine = await t.prisma.db.attachment.findFirstOrThrow({ where: { workspaceId: w, deletedAt: null } });
    await list(other, "contact", ids.contact!).expect(404);
    await list(other, "contact", ids.contact!, w2).expect(404);
    await other.get(api(`/attachments/${mine.id}/download`, w2)).expect(404);
    await other.patch(api(`/attachments/${mine.id}`, w2)).send({ fileName: "mine.pdf" }).expect(404);
    await other.delete(api(`/attachments/${mine.id}`, w2)).expect(404);
    await upload(other, "contact", ids.contact!, "x.pdf", PDF, w2).expect(404);
    await upload(other, "contact", ids.foreign!, "ok.pdf", PDF, w2).expect(201);
    expect((await list(other, "contact", ids.foreign!, w2).expect(200)).body.data.limits.usedBytes).toBe(PDF.length);
  });
});
