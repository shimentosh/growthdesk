import { z } from "zod";
import { requiredText, text, uuid } from "./schemas.js";
import { EmailBlocks, EmailTheme, renderEmail, type EmailBlock } from "./email-design.js";

/*
 * The email design template library platform staff curate in the operator
 * console (PlatformEmailDesign). Workspaces browse the published entries and
 * copy one into their own designs; the built-ins in email-library.ts are
 * inserted once by key and from then on are ordinary, editable entries.
 */

export const PLATFORM_EMAIL_DESIGN_STATUSES = ["draft", "published"] as const;
export type PlatformEmailDesignStatus = (typeof PLATFORM_EMAIL_DESIGN_STATUSES)[number];

/** Lower-case words joined by hyphens, e.g. "design-product-launch". Never changes once created. */
export const libraryKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,79}$/, "Use 2–80 lower-case letters, digits and hyphens");

export const PlatformEmailDesignInput = z.object({
  /** Optional: made from the name when left out. */
  key: libraryKey.optional(),
  name: requiredText(120),
  description: text(500).default(""),
  category: text(60).default(""),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  theme: EmailTheme.default({}),
  blocks: EmailBlocks.default([]),
});

/** PATCH: every field optional, the key is fixed. */
export const PlatformEmailDesignUpdate = z.object({
  name: requiredText(120).optional(),
  description: text(500).optional(),
  category: text(60).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  theme: EmailTheme.optional(),
  blocks: EmailBlocks.optional(),
});

/** Copy a workspace's design into the library as a draft. */
export const PlatformEmailDesignImport = z.object({
  workspaceId: uuid,
  designId: uuid,
  name: requiredText(120).optional(),
  description: text(500).optional(),
  category: text(60).optional(),
});

/** Render an unsaved theme + blocks (the admin editor's live preview). */
export const PlatformEmailDesignPreviewInput = z.object({
  theme: EmailTheme.default({}),
  blocks: EmailBlocks,
});

/** The sample contact library previews are rendered for. */
export const LIBRARY_PREVIEW_VARS = {
  first_name: "Alex",
  last_name: "Rivera",
  full_name: "Alex Rivera",
  email: "alex@example.com",
  company: "Acme",
  sender_name: "Sam from Acme",
};

/** A library design as recipients would see it, with a sample contact and placeholder footer. */
export function renderLibraryPreview(blocks: EmailBlock[], theme: EmailTheme | null | undefined, footer?: { legalName?: string; postalAddress?: string }) {
  return renderEmail(blocks, {
    theme,
    vars: LIBRARY_PREVIEW_VARS,
    footer: { legalName: footer?.legalName ?? "Your company", postalAddress: footer?.postalAddress ?? "Your postal address", preferencesUrl: "#" },
  });
}
