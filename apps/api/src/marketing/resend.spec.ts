import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ProviderError } from "../platform-mail/provider.js";
import { resendCheckKey, resendEnsureDomain, resendFailure, resendSend, resendVerifyDomain } from "./resend.js";

/* A fake Resend: just enough of /domains and /emails to exercise the marketing client. */
type Seen = { method: string; url: string; auth: string; idempotency: string; body: unknown };
let server: Server;
let seen: Seen[] = [];
let domains: Record<string, { id: string; name: string; status: string; region: string; records: unknown[] }> = {};
const RECORDS = [
  { record: "SPF", name: "send.news", type: "MX", ttl: "Auto", status: "not_started", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
  { record: "SPF", name: "send.news", type: "TXT", ttl: "Auto", status: "not_started", value: "v=spf1 include:amazonses.com ~all" },
  { record: "DKIM", name: "resend._domainkey.news", type: "TXT", ttl: "Auto", status: "not_started", value: "p=MIGfMA0" },
];

const read = (req: IncomingMessage) => new Promise<string>((resolve) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => resolve(b));
});

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await read(req);
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization), idempotency: String(req.headers["idempotency-key"] ?? ""), body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization === "Bearer re_sendingonly") return send(401, { statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" });
    if (req.headers.authorization !== "Bearer re_fullaccess1") return send(403, { statusCode: 403, name: "validation_error", message: "API key is invalid" });
    if (req.method === "GET" && req.url === "/domains") return send(200, { object: "list", data: Object.values(domains).map(({ records: _r, ...d }) => d) });
    if (req.method === "POST" && req.url === "/domains") {
      const id = `dom_${Object.keys(domains).length + 1}`;
      domains[id] = { id, name: body.name, status: "not_started", region: body.region, records: RECORDS };
      return send(200, domains[id]);
    }
    const m = req.url!.match(/^\/domains\/([^/]+)(\/verify)?$/);
    if (m && domains[m[1]!]) {
      if (m[2]) {
        domains[m[1]!]!.status = "verified";
        domains[m[1]!]!.records = RECORDS.map((r) => ({ ...r, status: "verified" }));
        return send(200, { object: "domain", id: m[1] });
      }
      return send(200, domains[m[1]!]);
    }
    if (req.method === "POST" && req.url === "/emails") {
      if (body.to[0] === "quota@x.example") return send(429, { name: "daily_quota_exceeded", message: "You have reached your daily quota" });
      return send(200, { id: "email_123" });
    }
    send(404, { name: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.RESEND_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  delete process.env.RESEND_API_URL;
  server.close();
});
beforeEach(() => {
  seen = [];
  domains = {};
});

describe("marketing Resend client", () => {
  it("accepts a Full access key and explains a Sending access one", async () => {
    await expect(resendCheckKey("re_fullaccess1")).resolves.toEqual([]);
    await expect(resendCheckKey("re_sendingonly")).rejects.toMatchObject({ kind: "auth", message: expect.stringContaining("Full access") });
    await expect(resendCheckKey("re_wrong")).rejects.toMatchObject({ kind: "auth" });
  });

  it("creates a domain in the chosen region, and adopts one the account already has", async () => {
    const d = await resendEnsureDomain("re_fullaccess1", "news.acme.example", "eu-west-1");
    expect(d).toMatchObject({ id: "dom_1", name: "news.acme.example", region: "eu-west-1" });
    expect(d.records.map((r) => `${r.record} ${r.type} ${r.name}`)).toEqual(["SPF MX send.news", "SPF TXT send.news", "DKIM TXT resend._domainkey.news"]);
    expect(d.records[0]!.priority).toBe(10);
    const again = await resendEnsureDomain("re_fullaccess1", "news.acme.example", "eu-west-1");
    expect(again.id).toBe("dom_1");
    expect(seen.filter((s) => s.method === "POST" && s.url === "/domains")).toHaveLength(1);
  });

  it("verifies, then reads the domain back", async () => {
    const d = await resendEnsureDomain("re_fullaccess1", "news.acme.example", "us-east-1");
    const v = await resendVerifyDomain("re_fullaccess1", d.id);
    expect(v.status).toBe("verified");
    expect(v.records.every((r) => r.status === "verified")).toBe(true);
  });

  it("sends with the send id as the idempotency key", async () => {
    const r = await resendSend("re_fullaccess1", { from: "News <news@news.acme.example>", to: "ada@x.example", subject: "Hi", html: "<p>Hi</p>", text: "Hi", headers: { "X-Growthdesk-Send": "s1" } }, "s1");
    expect(r).toEqual({ sent: true, providerMessageId: "email_123" });
    const call = seen.find((s) => s.url === "/emails")!;
    expect(call.idempotency).toBe("s1");
    expect(call.body).toMatchObject({ to: ["ada@x.example"], headers: { "X-Growthdesk-Send": "s1" } });
  });

  it("turns a used-up quota into a deferral that pauses the campaign", async () => {
    const r = await resendSend("re_fullaccess1", { from: "a@b.example", to: "quota@x.example", subject: "s", html: "h", text: "t", headers: {} }, "s2");
    expect(r).toMatchObject({ sent: false, failure: { outcome: "deferred", mailboxAtFault: true } });
  });

  it("maps every failure kind", () => {
    const f = (kind: ConstructorParameters<typeof ProviderError>[0]) => resendFailure(new ProviderError(kind, "x"));
    expect(f("auth")).toMatchObject({ outcome: "rejected", mailboxAtFault: true });
    expect(f("rate_limited")).toMatchObject({ outcome: "deferred", mailboxAtFault: false });
    expect(f("unknown_outcome")).toMatchObject({ outcome: "unknown" });
    expect(f("rejected")).toMatchObject({ outcome: "rejected", mailboxAtFault: false });
  });
});
