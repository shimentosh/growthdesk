import {
  designProblems,
  type EmailBlock,
  fill,
  platformTemplateVariables,
  PLATFORM_TEMPLATES,
  type PlatformTemplateKey,
  renderEmail,
  tokensIn,
} from "@growthdesk/shared";
import type { PlatformTemplateContent } from "./catalog.js";

/*
 * Rendering and checking system-email content (pure, unit-tested).
 *
 * Tokens: `fill()` silently drops a token it cannot resolve, so a template
 * edited in admin is checked before it is saved — every token must be one of
 * the template's variables (platformTemplateVariables) and every required
 * one (e.g. {{action_url}}) must appear somewhere.
 *
 * Variable values come from people (a name, a workspace, an inviter): they
 * are escaped by renderEmail, and the one piece of text-block markup that
 * could turn them into something else — a [label](https://…) link — is
 * broken with a zero-width joiner, so "[Click](https://evil)" as a display
 * name stays text.
 */

export type Brand = { productName: string; supportEmail: string; primaryColor: string };

/** Every text field of the content that may hold tokens. */
export function contentStrings(content: PlatformTemplateContent): string[] {
  const out = [content.subject, content.preheader];
  for (const b of content.blocks as EmailBlock[]) {
    switch (b.type) {
      case "heading":
      case "text":
        out.push(b.text);
        break;
      case "button":
        out.push(b.label, b.url);
        break;
      case "image":
        out.push(b.src, b.alt, b.href ?? "");
        break;
      default:
        break;
    }
  }
  return out;
}

/** Problems that stop this content from being published for `key`, in words for people. */
export function templateProblems(key: PlatformTemplateKey, content: PlatformTemplateContent): string[] {
  return contentProblems(
    content,
    platformTemplateVariables(key).map((v) => v.key),
    PLATFORM_TEMPLATES[key].required,
  );
}

/**
 * The same checks for any variable set: a subject, only `allowed` tokens,
 * every `required` one present, and a sendable design. Used by system
 * templates (above) and platform marketing (broadcasts and drip steps, whose
 * variables are PLATFORM_MARKETING_VARIABLES).
 */
export function contentProblems(content: PlatformTemplateContent, allowedKeys: readonly string[], required: readonly string[] = []): string[] {
  const problems: string[] = [];
  if (!content.subject.trim()) problems.push("Add a subject.");
  const allowed = new Set(allowedKeys);
  const used = new Set(contentStrings(content).flatMap((s) => tokensIn(s).map((t) => t.name)));
  const unknown = [...used].filter((n) => !allowed.has(n));
  if (unknown.length) problems.push(`Unknown variable${unknown.length > 1 ? "s" : ""}: ${unknown.map((n) => `{{${n}}}`).join(", ")}. This email can use ${[...allowed].map((n) => `{{${n}}}`).join(", ")}.`);
  const missing = required.filter((n) => !used.has(n));
  if (missing.length) problems.push(`This email must include ${missing.map((n) => `{{${n}}}`).join(", ")}.`);
  problems.push(...designProblems(content.blocks));
  return problems;
}

/** Sample values for previews and test sends. */
export function sampleVars(key: PlatformTemplateKey, brand?: Partial<Brand>): Record<string, string> {
  const vars = Object.fromEntries(platformTemplateVariables(key).map((v) => [v.key, v.sample.replace(/…/g, "example")]));
  if (brand?.productName) vars.product_name = brand.productName;
  if (brand?.supportEmail) vars.support_email = brand.supportEmail;
  return vars;
}

const defuse = (v: string) => v.replace(/\]\(/g, "]‍(");

export function renderPlatformTemplate(content: PlatformTemplateContent, vars: Record<string, string | null | undefined>, brand: Brand) {
  const all: Record<string, string> = { product_name: brand.productName, support_email: brand.supportEmail };
  for (const [k, v] of Object.entries(vars)) if (v !== undefined && v !== null) all[k] = String(v);
  const bodyVars = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, k === "action_url" ? v : defuse(v)]));
  const subject = fill(content.subject, all).replace(/[\r\n]+/g, " ").trim().slice(0, 998);
  const { html, text } = renderEmail(content.blocks, {
    preheader: content.preheader,
    vars: bodyVars,
    accent: brand.primaryColor || undefined,
    footer: { mode: "transactional", legalName: brand.productName, postalAddress: "", preferencesUrl: "", supportEmail: brand.supportEmail },
  });
  return { subject, html, text };
}

/**
 * Platform marketing (broadcasts, drip steps): the marketing footer — product
 * name, support email and this recipient's unsubscribe / preferences link.
 * `unsubscribe_url` is also available as a token in the content. There is no
 * postal address in Branding yet (CAN-SPAM wants one), so none is printed.
 */
export function renderPlatformMarketing(content: PlatformTemplateContent, vars: Record<string, string | null | undefined>, brand: Brand, unsubscribeUrl: string) {
  const all: Record<string, string> = { product_name: brand.productName, support_email: brand.supportEmail, unsubscribe_url: unsubscribeUrl };
  for (const [k, v] of Object.entries(vars)) if (v !== undefined && v !== null && k !== "unsubscribe_url") all[k] = String(v);
  const bodyVars = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, k === "unsubscribe_url" ? v : defuse(v)]));
  const subject = fill(content.subject, all).replace(/[\r\n]+/g, " ").trim().slice(0, 998);
  const { html, text } = renderEmail(content.blocks, {
    preheader: content.preheader,
    vars: bodyVars,
    accent: brand.primaryColor || undefined,
    footer: { mode: "marketing", legalName: brand.productName, postalAddress: brand.supportEmail, preferencesUrl: unsubscribeUrl },
  });
  return { subject, html, text };
}
