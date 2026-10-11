import { describe, expect, it } from "vitest";
import { designProblems, EmailBlocks, renderEmail, type EmailBlock } from "../src/email-design.js";

const footer = { legalName: "Acme Ltd", postalAddress: "1 Main St\nSpringfield", preferencesUrl: "https://app.test/preferences/tok" };

describe("renderEmail", () => {
  it("escapes everything typed and only turns the small markup into tags", () => {
    const blocks: EmailBlock[] = [
      { type: "heading", id: "h", text: "<script>alert(1)</script>", level: 1, align: "left" },
      { type: "text", id: "t", text: 'Hi **bold** *it* [site](https://x.test/?a=1&b="2") <img src=x onerror=alert(1)>', align: "left" },
    ];
    const { html } = renderEmail(blocks, { footer });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain('<a href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
  });

  it("never links javascript: or data: URLs", () => {
    const blocks: EmailBlock[] = [
      { type: "text", id: "t", text: "[x](javascript:alert(1))", align: "left" },
      { type: "button", id: "b", label: "Go", url: "javascript:alert(1)", align: "center" },
      { type: "image", id: "i", src: "data:image/png;base64,AAAA", alt: "", width: 100 },
    ];
    const { html } = renderEmail(blocks, { footer });
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toContain("data:image");
    expect(html).not.toContain(">Go</a>");
  });

  it("fills tokens, uses fallbacks, and drops unresolved ones", () => {
    const blocks: EmailBlock[] = [{ type: "text", id: "t", text: "Hi {{first_name|there}} {{custom.plan}}!", align: "left" }];
    expect(renderEmail(blocks, { footer, vars: { first_name: "Ada" } }).text).toContain("Hi Ada !");
    expect(renderEmail(blocks, { footer, vars: {} }).text).toContain("Hi there !");
  });

  it("always prints the company, address and preference link", () => {
    const { html, text } = renderEmail([{ type: "text", id: "t", text: "Body", align: "left" }], { footer, preheader: "Peek" });
    expect(html).toContain("Acme Ltd");
    expect(html).toContain("1 Main St · Springfield");
    expect(html).toContain('href="https://app.test/preferences/tok"');
    expect(html).toContain(">Peek</div>");
    expect(text).toContain("Unsubscribe or manage preferences: https://app.test/preferences/tok");
  });
});

describe("designProblems", () => {
  it("asks for text and real links", () => {
    expect(designProblems([])).toEqual(["Add some text to the email."]);
    const blocks = EmailBlocks.parse([
      { type: "text", id: "t", text: "Hello" },
      { type: "button", id: "b", url: "https://" },
      { type: "image", id: "i" },
    ]);
    expect(designProblems(blocks)).toEqual(["Button 2 needs a full link (https://…).", "Image 3 needs an image URL (https://…)."]);
  });
});
