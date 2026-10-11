import { z } from "zod";
import { API_SCOPES, ContactInput, requiredText, text } from "./schemas.js";

/*
 * Integrations: what an API key may do, and the Business OS lead-ingest body.
 *
 * The scope ids themselves (API_SCOPES) and the key-creation body
 * (ApiKeyInput) live in schemas.ts; the permissions each scope grants are
 * decided server-side by AccessGuard (SCOPE_PERMISSIONS). The labels here are
 * for the key-creation screen and the API docs — keep them true of what the
 * guard allows.
 */

export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_INFO: Record<ApiScope, { label: string; description: string }> = {
  "leads:write": {
    label: "Ingest leads",
    description: "Send leads to the lead-ingest endpoint: creates or updates contacts and companies, and can enroll them in a running campaign.",
  },
  "contacts:read": {
    label: "Read contacts and companies",
    description: "List and fetch contacts, companies and tags — every record in the workspace, whoever owns it.",
  },
  "contacts:write": {
    label: "Write contacts and companies",
    description: "Create and edit contacts and companies, and add notes to them. Cannot delete.",
  },
  "campaigns:read": {
    label: "Read campaigns",
    description: "List campaigns, fetch one, and list its enrollments.",
  },
};

/** How many active (unrevoked, unexpired) keys a workspace may hold. */
export const MAX_API_KEYS = 25;

/** Leads per ingest request. Larger lists go through several requests (or a CSV import). */
export const MAX_LEADS_PER_REQUEST = 100;

/** How long a response is kept for replay under its Idempotency-Key. */
export const IDEMPOTENCY_TTL_HOURS = 24;

/** Where an ingested lead says it came from; recorded on the contact's source (ContactSource.source). */
export const LEAD_SOURCES = ["business_os", "api"] as const;

/** A company named by a lead. Matched by domain, then by normalised name; created when neither exists. */
export const LeadCompanyInput = z.object({
  name: text(200).optional(),
  domain: text(200).optional(),
  website: text(500).optional(),
  industry: text(100).optional(),
  country: text(100).optional(),
  city: text(100).optional(),
  description: text(5000).optional(),
});

const LeadContactFields = ContactInput.pick({
  firstName: true,
  lastName: true,
  fullName: true,
  email: true,
  emails: true,
  phone: true,
  phones: true,
  jobTitle: true,
  website: true,
  linkedinUrl: true,
  city: true,
  country: true,
  timezone: true,
  leadSource: true,
  priority: true,
  score: true,
  customFields: true,
  doNotContact: true,
  consentStatus: true,
  consentSource: true,
  tags: true,
});

/** Small JSON kept with the contact's source record (e.g. the Business OS lead's own fields). */
const sourceData = z
  .record(z.string().max(60), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 10_000, "Keep data under 10,000 characters of JSON");

export const LeadInput = LeadContactFields.extend({
  /** The lead's id in the sending system. The same id always resolves to the same contact. */
  externalId: requiredText(200).optional(),
  /** A company name (shorthand for company.name). */
  companyName: text(200).optional(),
  company: LeadCompanyInput.optional(),
  /** Added as a note on the contact. */
  notes: text(5000).optional(),
  data: sourceData.optional(),
});
export type LeadInputT = z.infer<typeof LeadInput>;

export const LeadIngestInput = z.object({
  leads: z.array(LeadInput).min(1, "Send at least one lead").max(MAX_LEADS_PER_REQUEST, `Send up to ${MAX_LEADS_PER_REQUEST} leads per request`),
  source: z.enum(LEAD_SOURCES).default("business_os"),
  /** A lead matching an existing contact: fill its blank fields ("update", never overwrites) or leave it ("skip"). */
  onDuplicate: z.enum(["update", "skip"]).default("update"),
  /** Tags added to every lead in the request. */
  tags: z.array(requiredText(50)).max(20).default([]),
  /** Enroll every lead that resolves to a contact in this (launched) campaign. */
  campaignId: z.string().uuid().optional(),
});
export type LeadIngestInputT = z.infer<typeof LeadIngestInput>;

/** The Idempotency-Key header: 1–200 visible ASCII characters. */
export const IdempotencyKeyHeader = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, "Use visible ASCII characters only");
