import { describe, expect, it } from "vitest";
import { renderEmail, type EmailBlock } from "../src/email-design.js";

/* renderEmail footer modes: marketing (the default, unchanged) and transactional (system mail). */

const blocks: EmailBlock[] = [{ type: "text", id: "t", text: "Hello", align: "left" }];
const marketing = { legalName: "Acme Ltd", postalAddress: "1 Main St\nSpringfield", preferencesUrl: "https://app.test/preferences/tok" };

describe("renderEmail footer", () => {
  it("defaults to the marketing footer with the unsubscribe link", () => {
    const implicit = renderEmail(blocks, { footer: marketing });
    const explicit = renderEmail(blocks, { footer: { ...marketing, mode: "marketing" } });
    expect(explicit).toEqual(implicit);
    expect(implicit.html).toContain("You are receiving this because you subscribed.");
    expect(implicit.html).toContain('href="https://app.test/preferences/tok"');
    expect(implicit.html).toContain("1 Main St · Springfield");
    expect(implicit.text).toBe("Hello\n\n--\n\nAcme Ltd\n1 Main St\nSpringfield\n\nUnsubscribe or manage preferences: https://app.test/preferences/tok");
  });

  it("transactional mode shows the product and support address, never an unsubscribe link", () => {
    const { html, text } = renderEmail(blocks, {
      footer: { mode: "transactional", legalName: "Growthdesk", postalAddress: "", preferencesUrl: "https://ignored.test", supportEmail: "help@growthdesk.test" },
    });
    expect(html).not.toMatch(/unsubscribe/i);
    expect(html).not.toContain("ignored.test");
    expect(html).toContain("<div>Growthdesk</div>");
    expect(html).toContain('<a href="mailto:help@growthdesk.test"');
    expect(text).toBe("Hello\n\n--\n\nGrowthdesk\nQuestions? Contact help@growthdesk.test");
  });

  it("transactional mode without a support address shows only the name", () => {
    const { html, text } = renderEmail(blocks, { footer: { mode: "transactional", legalName: "Growthdesk", postalAddress: "", preferencesUrl: "" } });
    expect(html).not.toContain("Questions?");
    expect(text.endsWith("--\n\nGrowthdesk")).toBe(true);
  });
});
