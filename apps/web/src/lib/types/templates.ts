/*
 * Message templates. Kept in step with apps/api/src/campaigns/templates.service.ts
 * (`templateDto`, `TemplatePatch`, `TemplatePreviewInput`, `TemplateListQuery`,
 * `variables()`, `preview()`, `versions()`, `remove()`).
 */
import type { Channel } from "@growthdesk/shared";

/** GET /templates/:id, POST, PATCH — `templateDto()`. `usedBySteps` is only on the single-record answers, not the list. */
export type Template = {
  id: string;
  channel: Channel;
  name: string;
  category: string;
  subject: string;
  body: string;
  version: number;
  /** WhatsApp: the approved template name the chat provider sends instead of free text. */
  waTemplate: string;
  waLanguage: string;
  archivedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  /** Sequence steps (library or campaign) that point at this template. */
  usedBySteps?: number;
};

/** GET /templates query (`TemplateListQuery`). */
export type TemplateListParams = {
  page?: number;
  pageSize?: number;
  channel?: Channel;
  q?: string;
  archived?: "true" | "false" | "all";
};

/** POST /templates body (shared `TemplateInput`) and PATCH body (`TemplatePatch`, every key optional). */
export type TemplateBody = {
  channel?: Channel;
  name?: string;
  category?: string;
  subject?: string;
  body?: string;
  waTemplate?: string;
  waLanguage?: string;
};

/** GET /templates/:id/versions — newest first. */
export type TemplateVersion = {
  id: string;
  version: number;
  subject: string;
  body: string;
  createdById: string | null;
  createdAt: string;
};

export type TemplateVariable = { key: string; label: string; token: string; type?: string };

/** GET /templates/variables */
export type TemplateVariables = {
  standard: TemplateVariable[];
  custom: TemplateVariable[];
  fallbackSyntax: string;
};

/** POST /templates/:id/preview body. subject/body preview unsaved editor text instead of the stored version. */
export type TemplatePreviewBody = {
  contactId: string;
  mailboxId?: string | null;
  subject?: string;
  body?: string;
};

/** POST /templates/:id/preview answer. */
export type TemplatePreview = {
  templateId: string;
  version: number;
  channel: Channel;
  contact: { id: string; fullName: string | null; email: string | null };
  sender: { name: string; email: string; mailboxId: string | null };
  subject: string;
  body: string;
  /** Tokens with no value for this contact and no fallback — the campaign engine will not send such a message. */
  missing: string[];
  /** Tokens that name neither a standard variable nor a contact custom field (usually a typo). */
  unknown: string[];
};

/** DELETE /templates/:id — a template still used by a step is archived instead. */
export type TemplateDeleteResult = { archived: boolean; deleted: boolean; usedBySteps: number };
