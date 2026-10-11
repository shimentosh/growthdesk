import { randomUUID } from "node:crypto";
import { TransportPool, classifySmtpError, dropTransport, sendSmtp, transportOptions, type SmtpSettings } from "./smtp.js";
import { startFakeSmtp, type FakeSmtp } from "../../test/fake-smtp.js";

describe("classifySmtpError", () => {
  it("defers a message the pool dropped before sending it (nothing went out)", () => {
    expect(classifySmtpError(new Error("Connection pool was closed"))).toEqual({ error: "Connection pool was closed", outcome: "deferred", mailboxAtFault: false });
  });

  it("flags a 5.1.x refusal of the recipient as a bad address", () => {
    const f = classifySmtpError({ message: "Can't send mail - all recipients were rejected: 550 5.1.1 <x@y.test>: User unknown", code: "EENVELOPE", responseCode: 550, command: "RCPT TO" });
    expect(f).toMatchObject({ outcome: "rejected", mailboxAtFault: false, badAddress: true });
  });

  it("does not call a policy refusal or a sign-in failure a bad address", () => {
    expect(classifySmtpError({ message: "550 5.7.1 Message rejected as spam", responseCode: 550, command: "DATA" }).badAddress).toBeUndefined();
    const auth = classifySmtpError({ message: "Invalid login: 535 5.7.8 Authentication failed", code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" });
    expect(auth).toMatchObject({ outcome: "rejected", mailboxAtFault: true });
    expect(auth.badAddress).toBeUndefined();
    // A 5.1.x on MAIL FROM is about the sender, which is the mailbox's problem.
    expect(classifySmtpError({ message: "553 5.1.8 Sender address rejected", responseCode: 553, command: "MAIL FROM" })).toMatchObject({ mailboxAtFault: true });
  });

  it("keeps the existing outcomes for 4xx, unreachable servers and dropped sockets", () => {
    expect(classifySmtpError({ message: "451 try later", responseCode: 451 }).outcome).toBe("deferred");
    expect(classifySmtpError({ message: "connect ECONNREFUSED 127.0.0.1:1", code: "ESOCKET" })).toMatchObject({ outcome: "deferred", mailboxAtFault: true });
    expect(classifySmtpError({ message: "Timeout", code: "ETIMEDOUT" }).outcome).toBe("unknown");
  });
});

describe("TransportPool", () => {
  const settings = (pass: string): SmtpSettings => ({ mailboxId: "m1", host: "h", port: 25, security: "none", auth: { user: "u", pass }, allowSelfSigned: false });
  const fake = () => {
    const made: { closed: boolean }[] = [];
    const pool = new TransportPool(() => {
      const t = { closed: false, sendMail: vi.fn(), close: vi.fn(() => void (t.closed = true)) };
      made.push(t);
      return t as never;
    });
    return { pool, made };
  };

  it("reuses one transport per mailbox while the credentials are unchanged", () => {
    const { pool, made } = fake();
    pool.acquire(settings("a")).release();
    pool.acquire(settings("a")).release();
    expect(made).toHaveLength(1);
    expect(made[0]!.closed).toBe(false);
  });

  it("retires a transport whose credentials changed, closing it only when its in-flight sends settle", () => {
    const { pool, made } = fake();
    const first = pool.acquire(settings("a"));
    const second = pool.acquire(settings("a"));
    const fresh = pool.acquire(settings("b"));
    expect(made).toHaveLength(2);
    expect(fresh.transport).toBe(made[1]);
    expect(made[0]!.closed).toBe(false);
    first.release();
    expect(made[0]!.closed).toBe(false);
    second.release();
    second.release(); // a double release counts once
    expect(made[0]!.closed).toBe(true);
    expect(made[1]!.closed).toBe(false);
  });

  it("closes an idle retired transport at once", () => {
    const { pool, made } = fake();
    pool.acquire(settings("a")).release();
    pool.retire("m1");
    expect(made[0]!.closed).toBe(true);
    pool.acquire(settings("a")).release();
    expect(made).toHaveLength(2);
  });
});

describe("transportOptions (DNS rebinding, GAP_PLAN 2.10)", () => {
  const base: SmtpSettings = { mailboxId: "m1", host: "smtp.example.com", port: 587, security: "starttls", auth: { user: "u", pass: "p" }, allowSelfSigned: false };

  it("connects to the pinned address and checks TLS against the name", () => {
    const o = transportOptions({ ...base, address: "203.0.113.10" });
    expect(o).toMatchObject({ host: "203.0.113.10", servername: "smtp.example.com", requireTLS: true });
    expect(o.tls).toEqual({ rejectUnauthorized: true, servername: "smtp.example.com" });
  });

  it("keeps OAuth provider hosts working the same way", () => {
    const o = transportOptions({ ...base, host: "smtp.gmail.com", address: "142.250.0.108", auth: { user: "sam@gmail.com", accessToken: "tok" } });
    expect(o).toMatchObject({ host: "142.250.0.108", servername: "smtp.gmail.com", auth: { type: "OAuth2", user: "sam@gmail.com", accessToken: "tok" } });
  });

  it("leaves the host alone when nothing was pinned (or the name was returned unresolved)", () => {
    for (const s of [base, { ...base, address: "smtp.example.com" }]) {
      const o = transportOptions(s);
      expect(o.host).toBe("smtp.example.com");
      expect(o).not.toHaveProperty("servername");
      expect(o.tls).toEqual({ rejectUnauthorized: true });
    }
  });

  it("sets no TLS name for an IP literal host", () => {
    const o = transportOptions({ ...base, host: "203.0.113.10", address: "203.0.113.10" });
    expect(o.host).toBe("203.0.113.10");
    expect(o).not.toHaveProperty("servername");
  });

  it("opens a fresh pooled transport when the pinned address changes", () => {
    const made: SmtpSettings[] = [];
    const pool = new TransportPool((s) => {
      made.push(s);
      return { sendMail: vi.fn(), close: vi.fn() } as never;
    });
    pool.acquire({ ...base, address: "203.0.113.10" }).release();
    pool.acquire({ ...base, address: "203.0.113.10" }).release();
    pool.acquire({ ...base, address: "203.0.113.11" }).release();
    expect(made.map((s) => s.address)).toEqual(["203.0.113.10", "203.0.113.11"]);
  });
});

describe("sendSmtp over a pooled connection", () => {
  let smtp: FakeSmtp;
  beforeAll(async () => {
    smtp = await startFakeSmtp();
  });
  afterAll(async () => smtp.close());

  const box = (pass = "secret"): SmtpSettings => ({ mailboxId: randomUUID(), host: "127.0.0.1", port: smtp.port, security: "none", auth: { user: "sender@fake.test", pass }, allowSelfSigned: false });
  const mail = (to: string) => ({ from: "sender@fake.test", to, subject: "Hi", text: "Hello", messageId: `<${randomUUID()}@fake.test>` });

  it("delivers queued sends when the transport is dropped mid-flight (never 'pool closed')", async () => {
    smtp.setDataDelay(150);
    const s = box();
    // One connection per mailbox: the second and third wait in the pool's queue behind the first.
    const sends = [sendSmtp(s, mail("one@fake.test")), sendSmtp(s, mail("two@fake.test")), sendSmtp(s, mail("three@fake.test"))];
    await new Promise((r) => setTimeout(r, 30));
    dropTransport(s.mailboxId);
    // A credential change (e.g. an OAuth token refresh) while they are queued.
    const after = sendSmtp({ ...s, auth: { user: "sender@fake.test", pass: "rotated" } }, mail("four@fake.test"));
    const results = await Promise.all([...sends, after]);
    expect(results.map((r) => r.sent)).toEqual([true, true, true, true]);
    expect(smtp.accepted).toEqual(expect.arrayContaining(["one@fake.test", "two@fake.test", "three@fake.test", "four@fake.test"]));
    smtp.setDataDelay(0);
  });

  it("reports a 5.1.1 refusal as a bad address and keeps serving the mailbox", async () => {
    const s = box();
    const bad = await sendSmtp(s, mail("bad-user@fake.test"));
    expect(bad.sent).toBe(false);
    if (!bad.sent) expect(bad.failure).toMatchObject({ outcome: "rejected", mailboxAtFault: false, badAddress: true });
    const ok = await sendSmtp(s, mail("fine@fake.test"));
    expect(ok.sent).toBe(true);
  });

  it("reports a refused sign-in as the mailbox's fault", async () => {
    const r = await sendSmtp(box("wrong"), mail("x@fake.test"));
    expect(r.sent).toBe(false);
    if (!r.sent) expect(r.failure).toMatchObject({ outcome: "rejected", mailboxAtFault: true });
  });

  it("connects to the pinned IP, not to whatever the name resolves to", async () => {
    // .invalid never resolves (RFC 2606): the send can only succeed by using the pinned address.
    const pinned = { ...box(), host: "smtp.rebind.invalid", address: "127.0.0.1" };
    const ok = await sendSmtp(pinned, mail("pinned@fake.test"));
    expect(ok.sent).toBe(true);
    expect(smtp.accepted).toContain("pinned@fake.test");
    const unpinned = await sendSmtp({ ...pinned, mailboxId: randomUUID(), address: undefined }, mail("unpinned@fake.test"));
    expect(unpinned.sent).toBe(false);
    expect(smtp.accepted).not.toContain("unpinned@fake.test");
  });
});
