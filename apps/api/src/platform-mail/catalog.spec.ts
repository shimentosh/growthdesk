import { PLATFORM_TEMPLATE_KEYS, PLATFORM_TEMPLATES, platformTemplateVariables, tokensIn } from "@growthdesk/shared";
import { PLATFORM_TEMPLATE_DEFAULTS } from "./catalog.js";
import { contentStrings, renderPlatformTemplate, sampleVars, templateProblems } from "./render.js";

const brand = { productName: "Acme CRM", supportEmail: "help@acme.test", primaryColor: "#112233" };

describe("system email catalogue", () => {
  it.each(PLATFORM_TEMPLATE_KEYS)("%s: the default passes its own checks and uses only its variables", (key) => {
    const content = PLATFORM_TEMPLATE_DEFAULTS[key];
    expect(templateProblems(key, content)).toEqual([]);
    const allowed = new Set(platformTemplateVariables(key).map((v) => v.key));
    const used = contentStrings(content).flatMap((s) => tokensIn(s).map((t) => t.name));
    expect(used.filter((n) => !allowed.has(n))).toEqual([]);
    for (const r of PLATFORM_TEMPLATES[key].required) expect(used).toContain(r);
    expect(contentStrings(content).join(" ")).not.toMatch(/Growthdesk/);
  });

  it.each(PLATFORM_TEMPLATE_KEYS)("%s: renders with sample values and leaves no token behind", (key) => {
    const out = renderPlatformTemplate(PLATFORM_TEMPLATE_DEFAULTS[key], sampleVars(key, brand), brand);
    expect(out.subject).not.toMatch(/\{\{|\}\}/);
    expect(out.html).not.toMatch(/\{\{|\}\}/);
    expect(out.text).not.toMatch(/\{\{|\}\}/);
    expect(out.html).not.toMatch(/unsubscribe/i);
    expect(out.text).toContain("Acme CRM");
  });
});

describe("templateProblems", () => {
  const base = PLATFORM_TEMPLATE_DEFAULTS.verify_email;

  it("refuses unknown tokens, naming what is allowed", () => {
    const problems = templateProblems("verify_email", { ...base, subject: "Hi {{first_name}}" });
    expect(problems[0]).toMatch(/Unknown variable: \{\{first_name\}\}/);
    expect(problems[0]).toContain("{{action_url}}");
  });

  it("refuses content without a required token", () => {
    const blocks = base.blocks.filter((b) => b.type === "heading");
    expect(templateProblems("verify_email", { ...base, blocks })).toContain("This email must include {{action_url}}.");
  });

  it("refuses an empty subject", () => {
    expect(templateProblems("account_deleted", { ...PLATFORM_TEMPLATE_DEFAULTS.account_deleted, subject: " " })).toContain("Add a subject.");
  });
});

describe("renderPlatformTemplate", () => {
  it("fills the brand, uses the accent colour and the transactional footer", () => {
    const out = renderPlatformTemplate(PLATFORM_TEMPLATE_DEFAULTS.verify_email, { name: "Ada", action_url: "https://app.test/verify-email?token=abc" }, brand);
    expect(out.subject).toBe("Confirm your email for Acme CRM");
    expect(out.html).toContain("background:#112233");
    expect(out.html).toContain('href="https://app.test/verify-email?token=abc"');
    expect(out.html).toContain("mailto:help@acme.test");
    expect(out.text).toContain("Hi Ada,");
    expect(out.text).toContain("Confirm email: https://app.test/verify-email?token=abc");
  });

  it("keeps people's text as text: no HTML, no markup links", () => {
    const out = renderPlatformTemplate(
      PLATFORM_TEMPLATE_DEFAULTS.invitation,
      { inviter: "<b>Eve</b> [Click here](https://evil.test)", workspace: "Acme", action_url: "https://app.test/invite/tok" },
      brand,
    );
    expect(out.html).not.toContain("<b>Eve</b>");
    expect(out.html).not.toContain('href="https://evil.test"');
    expect(out.html).toContain("&lt;b&gt;Eve&lt;/b&gt;");
    expect(out.subject).toBe("<b>Eve</b> [Click here](https://evil.test) invited you to Acme on Acme CRM");
  });
});
