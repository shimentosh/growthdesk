import { describe, expect, test } from "vitest";
import {
  CHANNELS,
  EMAIL_DESIGN_LIBRARY,
  EmailBlocks,
  EmailTheme,
  TEMPLATE_LIBRARY,
  TEMPLATE_LIBRARY_CATEGORIES,
  TemplateInput,
  designProblems,
  renderEmail,
} from "../src/index.js";

// Library keys are how workspaces remember what they were given (LibrarySeed):
// a renamed key would be copied into every workspace a second time.
describe("built-in email designs", () => {
  test("keys are unique and stable-looking", () => {
    const keys = EMAIL_DESIGN_LIBRARY.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^design-[a-z0-9-]+$/);
  });

  test.each(EMAIL_DESIGN_LIBRARY.map((d) => [d.key, d] as const))("%s is valid and sendable", (_key, d) => {
    expect(EmailBlocks.parse(d.blocks)).toEqual(d.blocks);
    expect(EmailTheme.parse(d.theme)).toEqual(d.theme);
    expect(new Set(d.blocks.map((b) => b.id)).size).toBe(d.blocks.length);
    expect(designProblems(d.blocks)).toEqual([]);
    const { html, text } = renderEmail(d.blocks, { theme: d.theme, footer: { legalName: "Acme", postalAddress: "1 Road", preferencesUrl: "https://example.com/p" } });
    expect(html).not.toContain("{{");
    expect(text).not.toContain("{{");
  });
});

describe("built-in templates", () => {
  test("keys are unique and every category is listed", () => {
    const keys = TEMPLATE_LIBRARY.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of TEMPLATE_LIBRARY) {
      expect(t.key).toMatch(/^tpl-[a-z0-9-]+$/);
      expect(TEMPLATE_LIBRARY_CATEGORIES).toContain(t.category);
      expect(CHANNELS).toContain(t.channel);
    }
  });

  test.each(TEMPLATE_LIBRARY.map((t) => [t.key, t] as const))("%s passes the template input rules", (_key, t) => {
    expect(() => TemplateInput.parse({ channel: t.channel, name: t.name, category: t.category, subject: t.subject, body: t.body })).not.toThrow();
    if (t.channel === "email") expect(t.subject.trim()).not.toBe("");
    expect(t.body).not.toMatch(/<[a-z][^>]*>/i);
  });
});
