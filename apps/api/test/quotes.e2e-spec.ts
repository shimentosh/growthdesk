import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";
import { startFakeSmtp, type FakeSmtp } from "./fake-smtp.js";
import { quoteInclude } from "../src/quotes/quotes.service.js";
import { quoteDocumentHash } from "../src/quotes/quote-document.js";

/*
 * Products, quotes and the buyer's public page: catalogue CRUD and
 * permissions, numbering, totals, sending through a workspace mailbox (a
 * fake SMTP server), view tracking, acceptance with a signature (hash,
 * frozen quote, quote.accepted, the owner's task), decline, expiry, void and
 * tenant isolation.
 */

const BUYER = "dana@buyer.test";

describe("Products and quotes", () => {
  let t: TestApp;
  let smtp: FakeSmtp;
  let owner: Agent;
  let member: Agent;
  let viewer: Agent;
  let w: string;
  let contactId: string;
  let dealId: string;
  let mailboxId: string;
  let quoteId: string;
  let token: string;

  const api = (path: string, ws = w) => `/v1/workspaces/${ws}${path}`;
  const pub = (tok: string, sub = "") => `/v1/public/quotes/${tok}${sub}`;
  const tokenOf = (q: { publicUrl: string }) => q.publicUrl.split("/q/")[1]!;
  const LINES = [
    { name: "Website build", quantity: 1, unitPrice: "1200", taxRate: "10" },
    { name: "Hosting", quantity: 2, unitPrice: 50, discountPercent: "10", billingPeriod: "monthly" },
  ];

  async function newQuote(body: Record<string, unknown> = {}) {
    return (await owner.post(api("/quotes")).send({ dealId, lineItems: LINES, ...body }).expect(201)).body.data;
  }

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    t = await bootApp();
    owner = await signUp(t, "quotes-owner@acme.test", "Olive Owner");
    w = await createWorkspace(owner, "Acme Quotes");
    await setPlan(t, w, "growth");
    member = await addMember(t, owner, w, "quotes-member@acme.test", "member");
    viewer = await addMember(t, owner, w, "quotes-viewer@acme.test", "viewer");
    contactId = (await owner.post(api("/contacts")).send({ firstName: "Dana", lastName: "Buyer", email: BUYER }).expect(201)).body.data.id;
    dealId = (await owner.post(api("/deals")).send({ name: "Acme website", contactId, value: 0 }).expect(201)).body.data.id;
  });
  afterAll(async () => {
    await t.close();
    await smtp.close();
  });

  it("manages the product catalogue with products.manage; quotes.read lists it", async () => {
    const created = (
      await owner.post(api("/products")).send({ name: "Guest post DR50", sku: "GP-50", unitPrice: 249.5, costPrice: "120", taxRate: 7.5, category: "Link building", groupName: "Guest Posts", unit: "post" }).expect(201)
    ).body.data;
    expect(created).toMatchObject({ unitPrice: "249.50", costPrice: "120.00", taxRate: "7.50", currency: "USD", billingPeriod: "one_time", synced: false, archived: false, groupName: "Guest Posts" });
    await member.post(api("/products")).send({ name: "Nope" }).expect(403);
    await viewer.patch(api(`/products/${created.id}`)).send({ name: "Nope" }).expect(403);
    // Sellers see the catalogue, not what delivery costs.
    const seen = (await member.get(api("/products")).expect(200)).body.data;
    expect(seen.items.find((p: { id: string }) => p.id === created.id)).toMatchObject({ unitPrice: "249.50", costPrice: null });
    await viewer.get(api("/products")).expect(200);

    const updated = (await owner.patch(api(`/products/${created.id}`)).send({ unitPrice: "260", billingPeriod: "monthly" }).expect(200)).body.data;
    expect(updated).toMatchObject({ unitPrice: "260.00", billingPeriod: "monthly" });
    await owner.patch(api(`/products/${created.id}`)).send({ archived: true }).expect(200);
    expect((await owner.get(api("/products")).expect(200)).body.data.items.map((p: { id: string }) => p.id)).not.toContain(created.id);
    expect((await owner.get(api("/products?state=archived")).expect(200)).body.data.items.map((p: { id: string }) => p.id)).toContain(created.id);
    await owner.post(api("/products")).send({ name: "Bad", unitPrice: "12,50" }).expect(400);
    await owner.delete(api(`/products/${created.id}`)).expect(200);
    await owner.get(api(`/products/${created.id}`)).expect(404);

    // A product synced from the client portal is changed there, not here.
    const synced = await t.prisma.db.product.create({ data: { workspaceId: w, name: "Synced tier", unitPrice: "99.00", source: "clientdesk", externalId: "tier:1", syncedAt: new Date() } });
    const refused = await owner.patch(api(`/products/${synced.id}`)).send({ unitPrice: "1" }).expect(409);
    expect(refused.body.error.message).toMatch(/synced from the client portal/);
    await owner.patch(api(`/products/${synced.id}`)).send({ archived: true }).expect(409);
    await owner.delete(api(`/products/${synced.id}`)).expect(409);
    expect((await owner.get(api(`/products/${synced.id}`)).expect(200)).body.data).toMatchObject({ synced: true, source: "clientdesk" });
  });

  it("creates a quote from a deal with lines, totals and Q-numbers", async () => {
    const product = (await owner.post(api("/products")).send({ name: "Setup", unitPrice: "300" }).expect(201)).body.data;
    const q = await newQuote({ lineItems: [...LINES, { productId: product.id, name: "Setup", unitPrice: "300" }] });
    quoteId = q.id;
    token = tokenOf(q);
    expect(q).toMatchObject({
      numberLabel: "Q-0001",
      status: "draft",
      title: "Acme website",
      currency: "USD",
      deal: { id: dealId, name: "Acme website" },
      contact: { id: contactId, email: BUYER },
      owner: { id: owner.userId },
      // 1200 + 10% tax; 2 × 50 − 10%; 300.
      subtotal: "1600.00",
      discountTotal: "10.00",
      taxTotal: "120.00",
      total: "1710.00",
      oneTimeTotal: "1620.00",
      recurring: { monthly: "90.00", quarterly: "0.00", yearly: "0.00" },
      summary: "$1,620 one-time + $90/month",
    });
    expect(q.lineItems.map((l: { name: string; total: string; position: number }) => [l.position, l.name, l.total])).toEqual([
      [0, "Website build", "1200.00"],
      [1, "Hosting", "90.00"],
      [2, "Setup", "300.00"],
    ]);
    expect(q.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await viewer.post(api("/quotes")).send({ dealId }).expect(403);

    // Numbers stay unique under concurrent creation.
    const many = await Promise.all([1, 2, 3, 4, 5].map(() => owner.post(api("/quotes")).send({ title: "Burst" }).expect(201)));
    const numbers = many.map((r) => r.body.data.number as number).sort((a, b) => a - b);
    expect(numbers).toEqual([2, 3, 4, 5, 6]);
    const blank = many[0]!.body.data;
    expect(blank).toMatchObject({ deal: null, contact: null, total: "0.00", owner: { id: owner.userId } });

    const listed = (await owner.get(api("/quotes?q=Q-0001")).expect(200)).body.data;
    expect(listed.items.map((r: { id: string }) => r.id)).toEqual([quoteId]);
    expect((await owner.get(api(`/deals/${dealId}/quotes`)).expect(200)).body.data.map((r: { id: string }) => r.id)).toContain(quoteId);
    expect((await viewer.get(api(`/quotes/${quoteId}`)).expect(200)).body.data.id).toBe(quoteId);

    // Replacing lines recomputes the totals.
    const edited = (await owner.patch(api(`/quotes/${quoteId}`)).send({ lineItems: LINES, terms: "Net 30.", intro: "Thanks!" }).expect(200)).body.data;
    expect(edited).toMatchObject({ total: "1410.00", lineCount: 2, terms: "Net 30.", status: "draft" });
  });

  it("refuses to send without a mailbox, then emails the buyer a link from the owner's mailbox", async () => {
    const none = await owner.post(api(`/quotes/${quoteId}/send`)).send({}).expect(409);
    expect(none.body.error.message).toMatch(/mailbox/i);
    mailboxId = (
      await owner
        .post(api("/mailboxes/smtp"))
        .send({ email: "olive@acme.test", displayName: "Olive at Acme", smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecurity: "none", smtpUser: "olive@acme.test", password: "secret", imapEnabled: false, minDelaySeconds: 0 })
        .expect(201)
    ).body.data.id;
    const options = (await owner.get(api(`/quotes/${quoteId}/send-options`)).expect(200)).body.data;
    expect(options).toMatchObject({ defaultMailboxId: mailboxId, to: BUYER, subject: "Quote Q-0001: Acme website" });
    await viewer.post(api(`/quotes/${quoteId}/send`)).send({}).expect(403);

    const sent = (await member.post(api(`/quotes/${quoteId}/send`)).send({ message: "Hi Dana, here it is." }).expect(200)).body.data;
    expect(sent).toMatchObject({ status: "sent" });
    expect(sent.sentAt).not.toBeNull();
    expect(smtp.accepted).toContain(BUYER);
    const msg = await t.prisma.db.message.findFirstOrThrow({ where: { workspaceId: w, toAddress: BUYER }, include: { conversation: true } });
    expect(msg.bodyText).toContain(`/q/${token}`);
    expect(msg.bodyText).toContain("Hi Dana, here it is.");
    expect(msg.conversation).toMatchObject({ contactId, dealId, mailboxId });
    const activity = await t.prisma.db.activity.findFirstOrThrow({ where: { workspaceId: w, type: "quote.sent", dealId } });
    expect(activity.contactId).toBe(contactId);

    // Sent again: threaded onto the first email, in the same conversation.
    await owner.post(api(`/quotes/${quoteId}/send`)).send({}).expect(200);
    const again = await t.prisma.db.message.findMany({ where: { workspaceId: w, toAddress: BUYER }, orderBy: { createdAt: "asc" } });
    expect(again).toHaveLength(2);
    expect(again[1]).toMatchObject({ conversationId: msg.conversationId, inReplyTo: msg.providerMessageId });

    // A sent quote cannot be deleted, only voided.
    await owner.delete(api(`/quotes/${quoteId}`)).expect(409);
  });

  it("marks the quote viewed on the buyer's first visit, not on a teammate's", async () => {
    await owner.get(pub(token)).expect(200);
    expect((await t.prisma.db.quote.findFirstOrThrow({ where: { id: quoteId, workspaceId: w } })).viewCount).toBe(0);

    const view = (await t.http().get(pub(token)).expect(200)).body.data;
    expect(view).toMatchObject({
      number: "Q-0001",
      status: "viewed",
      from: { workspaceName: "Acme Quotes", senderName: "Olive Owner" },
      to: { name: "Dana Buyer", email: BUYER },
      terms: "Net 30.",
      totals: { total: "1410.00", summary: "$1,320 one-time + $90/month" },
      acceptance: null,
    });
    expect(view.lineItems).toHaveLength(2);
    await t.http().get(pub(token)).expect(200);
    const q = await t.prisma.db.quote.findFirstOrThrow({ where: { id: quoteId, workspaceId: w } });
    expect(q).toMatchObject({ status: "viewed", viewCount: 2 });
    expect(q.firstViewedAt).not.toBeNull();
    expect(await t.prisma.db.notification.count({ where: { workspaceId: w, userId: owner.userId, type: "quote.viewed" } })).toBe(1);
    await t.http().get(pub("0".repeat(48))).expect(404);
    await t.http().get(pub("not-a-token")).expect(404);
  });

  it("accepts with a typed signature: hash, frozen quote, deal value, event and the owner's task", async () => {
    const signature = { type: "typed", data: "Dana Buyer" };
    await t.http().post(pub(token, "/accept")).send({ signerName: "Dana Buyer", signerEmail: BUYER, signature, agree: false }).expect(400);
    await t.http().post(pub(token, "/accept")).set("Origin", "https://evil.test").send({ signerName: "Dana Buyer", signerEmail: BUYER, signature, agree: true }).expect(403);

    const res = await t.http().post(pub(token, "/accept")).set("User-Agent", "BuyerBrowser/1.0").send({ signerName: "Dana Buyer", signerEmail: BUYER, signerTitle: "CEO", signature, agree: true }).expect(200);
    expect(res.body.data).toMatchObject({ status: "accepted", acceptance: { signerName: "Dana Buyer", signerTitle: "CEO", signatureType: "typed", signature: "Dana Buyer" } });

    const row = await t.prisma.db.quote.findFirstOrThrow({ where: { id: quoteId, workspaceId: w }, include: quoteInclude });
    expect(row).toMatchObject({ status: "accepted", signerEmail: BUYER, signerUserAgent: "BuyerBrowser/1.0" });
    expect(row.signerIp).not.toBe("");
    expect(row.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.documentHash).toBe(quoteDocumentHash(row));
    const detail = (await owner.get(api(`/quotes/${quoteId}`)).expect(200)).body.data;
    expect(detail.acceptance).toMatchObject({ documentHash: row.documentHash, hashMatches: true, signerIp: row.signerIp });

    // Frozen.
    await owner.patch(api(`/quotes/${quoteId}`)).send({ title: "Changed" }).expect(409);
    await owner.post(api(`/quotes/${quoteId}/void`)).expect(409);
    await owner.post(api(`/quotes/${quoteId}/send`)).send({}).expect(409);
    const twice = await t.http().post(pub(token, "/accept")).send({ signerName: "Eve", signerEmail: "eve@x.test", signature, agree: true }).expect(409);
    expect(twice.body.error.message).toMatch(/already been accepted/);
    await t.http().post(pub(token, "/decline")).send({ reason: "Changed my mind" }).expect(409);

    // The deal had no value: it takes the quote's one-time total.
    expect(Number((await t.prisma.db.deal.findFirstOrThrow({ where: { id: dealId, workspaceId: w } })).value)).toBe(1320);
    const event = await t.prisma.db.domainEvent.findFirstOrThrow({ where: { workspaceId: w, type: "quote.accepted", subjectId: quoteId } });
    expect(event.payload).toEqual({ quoteId, quoteNumber: "Q-0001", dealId, contactId, total: "1410.00", currency: "USD" });
    const task = await t.prisma.db.task.findFirstOrThrow({ where: { workspaceId: w, dealId, title: { contains: "Q-0001 accepted" } } });
    expect(task).toMatchObject({ priority: "high", assigneeId: owner.userId, contactId, status: "open" });
    expect(await t.prisma.db.activity.count({ where: { workspaceId: w, type: "quote.accepted", dealId } })).toBe(1);
    expect(await t.prisma.db.notification.count({ where: { workspaceId: w, userId: owner.userId, type: "quote.accepted" } })).toBe(1);

    // A duplicate is the way to change it: a fresh draft with the same lines.
    const copy = (await owner.post(api(`/quotes/${quoteId}/duplicate`)).expect(201)).body.data;
    expect(copy).toMatchObject({ status: "draft", total: "1410.00", lineCount: 2, deal: { id: dealId } });
    expect(copy.numberLabel).not.toBe("Q-0001");

    // A second accepted quote leaves the now-valued deal alone.
    const second = await newQuote();
    await owner.post(api(`/quotes/${second.id}/link`)).expect(200);
    await t.http().post(pub(tokenOf(second), "/accept")).send({ signerName: "Dana Buyer", signerEmail: BUYER, signature: { type: "drawn", data: "data:image/png;base64,iVBORw0KGgo=" }, agree: true }).expect(200);
    expect(Number((await t.prisma.db.deal.findFirstOrThrow({ where: { id: dealId, workspaceId: w } })).value)).toBe(1320);
    expect((await t.http().get(pub(tokenOf(second))).expect(200)).body.data.acceptance).toMatchObject({ signatureType: "drawn" });
  });

  it("records a decline, and reopens a sent quote as a draft while it is edited", async () => {
    const q = await newQuote();
    const shared = (await owner.post(api(`/quotes/${q.id}/link`)).expect(200)).body.data;
    expect(shared.url).toContain(`/q/${tokenOf(q)}`);
    expect(shared.quote.status).toBe("sent");

    // Editing a sent quote turns it back into a draft: the buyer's page withholds the content meanwhile.
    expect((await owner.patch(api(`/quotes/${q.id}`)).send({ terms: "Net 15." }).expect(200)).body.data.status).toBe("draft");
    const hidden = (await t.http().get(pub(tokenOf(q))).expect(200)).body.data;
    expect(hidden).toMatchObject({ status: "draft", lineItems: [], terms: "" });
    await t.http().post(pub(tokenOf(q), "/accept")).send({ signerName: "Dana", signerEmail: BUYER, signature: { type: "typed", data: "Dana" }, agree: true }).expect(409);
    await owner.post(api(`/quotes/${q.id}/link`)).expect(200);

    const declined = (await t.http().post(pub(tokenOf(q), "/decline")).send({ reason: "Over budget" }).expect(200)).body.data;
    expect(declined.status).toBe("declined");
    const row = (await owner.get(api(`/quotes/${q.id}`)).expect(200)).body.data;
    expect(row).toMatchObject({ status: "declined", declineReason: "Over budget" });
    expect(await t.prisma.db.activity.count({ where: { workspaceId: w, type: "quote.declined" } })).toBe(1);
    await owner.post(api(`/quotes/${q.id}/send`)).send({}).expect(409);
  });

  it("reads a quote past its valid-until date as expired and refuses to accept it", async () => {
    const q = await newQuote();
    await owner.post(api(`/quotes/${q.id}/link`)).expect(200);
    await t.prisma.db.quote.updateMany({ where: { id: q.id, workspaceId: w }, data: { validUntil: new Date(Date.UTC(2026, 0, 1)) } });
    expect((await t.http().get(pub(tokenOf(q))).expect(200)).body.data.status).toBe("expired");
    expect((await owner.get(api(`/quotes/${q.id}`)).expect(200)).body.data.status).toBe("expired");
    expect((await owner.get(api("/quotes?status=expired")).expect(200)).body.data.items.map((r: { id: string }) => r.id)).toContain(q.id);
    expect((await owner.get(api("/quotes?status=sent")).expect(200)).body.data.items.map((r: { id: string }) => r.id)).not.toContain(q.id);
    const refused = await t.http().post(pub(tokenOf(q), "/accept")).send({ signerName: "Dana", signerEmail: BUYER, signature: { type: "typed", data: "Dana" }, agree: true }).expect(409);
    expect(refused.body.error.message).toMatch(/expired on 2026-01-01/);
    await owner.post(api(`/quotes/${q.id}/send`)).send({}).expect(409);
    // A new valid-until date reopens it (as a draft, to be sent again).
    const reopened = (await owner.patch(api(`/quotes/${q.id}`)).send({ validUntil: "2099-12-31" }).expect(200)).body.data;
    expect(reopened.status).toBe("draft");
  });

  it("voids a quote and deletes drafts", async () => {
    const q = await newQuote();
    await owner.post(api(`/quotes/${q.id}/link`)).expect(200);
    expect((await owner.post(api(`/quotes/${q.id}/void`)).expect(200)).body.data.status).toBe("void");
    expect((await t.http().get(pub(tokenOf(q))).expect(200)).body.data).toMatchObject({ status: "void", lineItems: [] });
    const refused = await t.http().post(pub(tokenOf(q), "/accept")).send({ signerName: "Dana", signerEmail: BUYER, signature: { type: "typed", data: "Dana" }, agree: true }).expect(409);
    expect(refused.body.error.message).toMatch(/withdrawn/);
    await owner.patch(api(`/quotes/${q.id}`)).send({ title: "Again" }).expect(409);
    await owner.post(api(`/quotes/${q.id}/link`)).expect(409);

    const draft = await newQuote();
    await viewer.delete(api(`/quotes/${draft.id}`)).expect(403);
    await owner.delete(api(`/quotes/${draft.id}`)).expect(200);
    await owner.get(api(`/quotes/${draft.id}`)).expect(404);
    await t.http().get(pub(tokenOf(draft))).expect(404);
  });

  it("keeps quotes and products inside their workspace", async () => {
    const other = await signUp(t, "quotes-other@rival.test", "Rita Rival");
    const w2 = await createWorkspace(other, "Rival Co");
    await other.get(api(`/quotes/${quoteId}`, w2)).expect(404);
    await other.get(api(`/quotes/${quoteId}`)).expect(404);
    await other.patch(api(`/quotes/${quoteId}`, w2)).send({ title: "Mine" }).expect(404);
    await other.post(api("/quotes", w2)).send({ dealId }).expect(404);
    expect((await other.get(api("/quotes", w2)).expect(200)).body.data.total).toBe(0);
    expect((await other.get(api("/products", w2)).expect(200)).body.data.total).toBe(0);
    const theirs = (await other.post(api("/quotes", w2)).send({ title: "Rival quote", lineItems: [{ name: "Thing", unitPrice: "5" }] }).expect(201)).body.data;
    // Numbering is per workspace.
    expect(theirs.numberLabel).toBe("Q-0001");
    // A signed-in person of another workspace opening our link sees our quote, as any buyer would — and counts as one.
    const before = (await t.prisma.db.quote.findFirstOrThrow({ where: { id: quoteId, workspaceId: w } })).viewCount;
    expect((await other.get(pub(token)).expect(200)).body.data.from.workspaceName).toBe("Acme Quotes");
    // Their own link is just their own quote.
    expect((await t.http().get(pub(tokenOf(theirs))).expect(200)).body.data).toMatchObject({ from: { workspaceName: "Rival Co" }, title: "Rival quote", status: "draft" });
    // Our accepted quote's view count does not move after acceptance (only open quotes count views).
    expect((await t.prisma.db.quote.findFirstOrThrow({ where: { id: quoteId, workspaceId: w } })).viewCount).toBe(before);
  });
});
