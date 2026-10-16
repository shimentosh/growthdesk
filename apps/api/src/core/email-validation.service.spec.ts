import { describe, expect, it } from "vitest";
import { DEFAULT_EMAIL_VALIDATION, EmailValidationService, MailDomainResolver } from "./email-validation.service.js";
import type { ContactEmailValidation, PlatformSettingsService } from "./platform-settings.service.js";

/** A resolver that knows a few domains: acme.test has MX, bare.test only an address, nomail.test a null MX, the rest do not exist. */
function fakeResolver(calls: string[] = []) {
  const r = new MailDomainResolver();
  const missing = () => Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
  r.mx = (d) => {
    calls.push(d);
    if (d === "acme.test") return Promise.resolve([{ exchange: "mx2.acme.test", priority: 20 }, { exchange: "mx1.acme.test", priority: 10 }]);
    if (d === "nomail.test") return Promise.resolve([{ exchange: ".", priority: 0 }]);
    if (d === "flaky.test") return Promise.reject(Object.assign(new Error("server failure"), { code: "ESERVFAIL" }));
    if (d === "bare.test") return Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" }));
    return missing();
  };
  r.address = async (d) => d === "bare.test";
  return r;
}

function service(config: Partial<ContactEmailValidation> = {}, calls: string[] = []) {
  const platform = { get: async () => ({ contactEmailValidation: { ...DEFAULT_EMAIL_VALIDATION, enabled: true, ...config } }) } as unknown as PlatformSettingsService;
  return new EmailValidationService(platform, fakeResolver(calls));
}

describe("EmailValidationService.check", () => {
  it("accepts an address whose domain has a mail server", async () => {
    const v = await service().check("Ada@Acme.test");
    expect(v.ok).toBe(true);
    expect(v.email).toBe("ada@acme.test");
    expect(v.checks.find((c) => c.check === "mail_server")?.detail).toBe("mail server mx1.acme.test");
  });

  it("refuses bad syntax", async () => {
    const v = await service().check("not-an-email");
    expect(v).toMatchObject({ ok: false, reason: "syntax" });
  });

  it("refuses disposable services, including their subdomains", async () => {
    expect(await service().check("x@mailinator.com")).toMatchObject({ ok: false, reason: "disposable" });
    expect(await service().check("x@eu.mailinator.com")).toMatchObject({ ok: false, reason: "disposable" });
    expect(await service({ blockDisposable: false, checkMailServer: false }).check("x@mailinator.com")).toMatchObject({ ok: true });
  });

  it("refuses the admin's blocked domains", async () => {
    expect(await service({ blockedDomains: ["competitor.test"] }).check("a@sales.competitor.test")).toMatchObject({ ok: false, reason: "blocked" });
  });

  it("refuses role mailboxes only when that is switched on", async () => {
    expect(await service().check("info@acme.test")).toMatchObject({ ok: true });
    expect(await service({ blockRoleAccounts: true }).check("info@acme.test")).toMatchObject({ ok: false, reason: "role" });
    expect(await service({ blockRoleAccounts: true }).check("sales+eu@acme.test")).toMatchObject({ ok: false, reason: "role" });
    expect(await service({ blockRoleAccounts: true }).check("ada@acme.test")).toMatchObject({ ok: true });
  });

  it("refuses domains that do not exist or take no mail", async () => {
    expect(await service().check("a@nowhere.test")).toMatchObject({ ok: false, reason: "mail_server" });
    expect(await service().check("a@nomail.test")).toMatchObject({ ok: false, reason: "mail_server" });
  });

  it("accepts a domain with no MX but an address record (implicit MX)", async () => {
    expect(await service().check("a@bare.test")).toMatchObject({ ok: true });
  });

  it("lets an address through when DNS cannot answer", async () => {
    expect(await service().check("a@flaky.test")).toMatchObject({ ok: true });
  });

  it("skips the lookup for well-known providers and caches the rest per domain", async () => {
    const calls: string[] = [];
    const s = service({}, calls);
    await s.check("a@gmail.com");
    await s.check("a@acme.test");
    await s.check("b@acme.test");
    await Promise.all([s.check("c@nowhere.test"), s.check("d@nowhere.test")]);
    expect(calls).toEqual(["acme.test", "nowhere.test"]);
  });
});

describe("EmailValidationService.assertAcceptable", () => {
  it("does nothing while validation is off", async () => {
    await expect(service({ enabled: false }).assertAcceptable(["x@mailinator.com"])).resolves.toBeUndefined();
  });

  it("throws email_rejected with the reason for the first bad address", async () => {
    await expect(service().assertAcceptable(["ok@acme.test", "x@mailinator.com"])).rejects.toMatchObject({ status: 400, code: "email_rejected", fields: { email: "disposable" } });
  });

  it("never refuses inbound mail, live chat or system contacts, and ignores blanks", async () => {
    await expect(service().assertAcceptable(["x@mailinator.com"], "inbound")).resolves.toBeUndefined();
    await expect(service().assertAcceptable(["x@mailinator.com"], "web_chat")).resolves.toBeUndefined();
    await expect(service().assertAcceptable([null, "", "  "])).resolves.toBeUndefined();
  });
});
