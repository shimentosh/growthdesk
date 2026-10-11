/*
 * Tags, custom fields and the suppression list — shapes of
 * apps/api/src/crm/crm-extras.service.ts and suppression.service.ts.
 */
import type { SuppressionKind, SuppressionScope } from "@growthdesk/shared";

/** What each suppression scope stops, in words. */
export const SCOPE_LABELS: Record<SuppressionScope, string> = {
  all: "All sending",
  outreach: "Outreach only",
  marketing: "Marketing only",
};

/** GET /tags — `tags()` (sorted by name, not paged) */
export type TagRow = {
  id: string;
  name: string;
  /** A colour name (default "gray"); see tagTone() in components/imports/labels.ts. */
  color: string;
  contactCount: number;
  companyCount: number;
};

/** POST /tags — the created row. PATCH answers { updated: true }, DELETE { deleted: true }. */
export type TagCreated = { id: string; workspaceId: string; name: string; color: string; createdAt: string };

export type CustomFieldEntity = "contact" | "company" | "deal";
export type CustomFieldType = "text" | "number" | "date" | "boolean" | "select" | "url";

/** GET /custom-fields[?entity=] — `fields()` (by entity, then position). POST answers the created row. */
export type CustomFieldDefinition = {
  id: string;
  workspaceId: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  position: number;
  createdAt: string;
  updatedAt: string;
};

export const SUPPRESSION_REASONS = ["manual", "do_not_contact", "unsubscribed", "bounced", "complained", "opted_out"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** GET /suppressions — `list()`, paged ({ items, total, page, pageSize }); POST answers the row (existing one when already listed). */
export type SuppressionRow = {
  id: string;
  workspaceId: string;
  kind: SuppressionKind;
  /** Normalised: lower-case email, bare domain, E.164 phone. */
  value: string;
  reason: SuppressionReason | string;
  /** Which engine it stops: `all`, or only `outreach` / `marketing`. */
  scope: SuppressionScope;
  /** Where it came from: "manual", or the system path that added it (empty for older rows). */
  source: string;
  createdById: string | null;
  createdAt: string;
};
