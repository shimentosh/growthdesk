import { describe, expect, it } from "vitest";
import { MAIL_PROVIDERS, MAIL_PROVIDER_ORDER, detectMailProvider } from "../src/mail-providers.js";

describe("detectMailProvider", () => {
  it("knows free-mail domains without a lookup", () => {
    expect(detectMailProvider("ada@gmail.com")).toMatchObject({ provider: "google", via: "domain", smtp: { host: "smtp.gmail.com" } });
    expect(detectMailProvider("ada@Hotmail.com").provider).toBe("microsoft");
    expect(detectMailProvider("ada@icloud.com").provider).toBe("icloud");
  });

  it("reads a company domain's MX, lowest priority first", () => {
    expect(detectMailProvider("ada@acme.example", ["aspmx.l.google.com", "alt1.aspmx.l.google.com"])).toMatchObject({ provider: "google", via: "mx" });
    expect(detectMailProvider("ada@acme.example", ["acme-example.mail.protection.outlook.com."]).provider).toBe("microsoft");
    expect(detectMailProvider("ada@acme.example", ["mx1.titan.email"]).provider).toBe("titan");
    expect(detectMailProvider("ada@acme.example", ["mailstore1.secureserver.net"]).provider).toBe("godaddy");
  });

  it("follows Zoho's data centre from the MX", () => {
    const d = detectMailProvider("ada@acme.example", ["mx.zoho.eu"]);
    expect(d).toMatchObject({ provider: "zoho", smtp: { host: "smtp.zoho.eu" }, imap: { host: "imap.zoho.eu" } });
  });

  it("falls back to entering the servers by hand", () => {
    expect(detectMailProvider("ada@acme.example", ["mail.acme.example"])).toMatchObject({ provider: "smtp", via: "none", smtp: { host: "" } });
    expect(detectMailProvider("not-an-address")).toMatchObject({ provider: "smtp", via: "none" });
  });

  it("names a forward-only MX, which has no mailbox to sign in to", () => {
    expect(detectMailProvider("ada@acme.example", ["route1.mx.cloudflare.net"])).toMatchObject({ provider: "smtp", forwarder: "Cloudflare Email Routing" });
    expect(detectMailProvider("ada@acme.example", ["mail.acme.example"]).forwarder).toBeUndefined();
  });

  it("does not match a lookalike host", () => {
    expect(detectMailProvider("ada@acme.example", ["mx.notgoogle.com.evil.example"]).provider).toBe("smtp");
  });
});

describe("MAIL_PROVIDERS", () => {
  it("offers every provider exactly once, each with steps", () => {
    expect(new Set(MAIL_PROVIDER_ORDER).size).toBe(Object.keys(MAIL_PROVIDERS).length);
    for (const id of MAIL_PROVIDER_ORDER) expect(MAIL_PROVIDERS[id].steps.length).toBeGreaterThan(0);
  });
});
