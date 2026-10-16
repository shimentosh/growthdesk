import { z } from "zod";
import { API_SCOPES, ContactInput, INTEGRATION_APPS, requiredText, text } from "./schemas.js";

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
  "customers:write": {
    label: "Sync clients and orders",
    description: "Keep clients and their orders in step with another system (the client portal): creates and updates contacts, companies and orders.",
  },
  "products:write": {
    label: "Sync products",
    description: "Keep the product catalog in step with another system (the client portal's services): creates, updates and archives the products that system owns.",
  },
};

export type IntegrationApp = (typeof INTEGRATION_APPS)[number];

/**
 * The apps connected from Settings → Integrations. Connecting one creates an
 * API key that holds exactly these scopes, tagged with the app, so the page can
 * tell whether the app is connected and when it last called.
 */
export const INTEGRATION_APP_INFO: Record<IntegrationApp, { label: string; description: string; scopes: readonly ApiScope[] }> = {
  clientdesk: {
    label: "Clientdesk",
    description: "Your client portal. Sends its leads, clients and orders here, and keeps Products in step with its services.",
    scopes: ["leads:write", "products:write", "customers:write"],
  },
  business_os: {
    label: "Business OS",
    description: "Sends the leads it finds and qualifies here as contacts, ready for routing and campaigns.",
    scopes: ["leads:write"],
  },
};

/** How many active (unrevoked, unexpired) keys a workspace may hold. */
export const MAX_API_KEYS = 25;

/** Leads per ingest request. Larger lists go through several requests (or a CSV import). */
export const MAX_LEADS_PER_REQUEST = 100;

/** How long a response is kept for replay under its Idempotency-Key. */
export const IDEMPOTENCY_TTL_HOURS = 24;

/** Where an ingested lead says it came from; recorded on the contact's source (ContactSource.source). */
export const LEAD_SOURCES = ["business_os", "api", "clientdesk"] as const;

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
  /**
   * The lead list this lead belongs on, by name: the active list with that
   * name (ignoring case) or a new one. Overrides the request's listName.
   */
  listName: requiredText(120).optional(),
});
export type LeadInputT = z.infer<typeof LeadInput>;

export const LeadIngestInput = z.object({
  /**
   * Each lead is checked against LeadInput on its own, by the ingest service,
   * so one lead with a bad field (a malformed email, a phone too long) fails
   * alone in the results instead of refusing the whole request.
   */
  leads: z.array(z.unknown()).min(1, "Send at least one lead").max(MAX_LEADS_PER_REQUEST, `Send up to ${MAX_LEADS_PER_REQUEST} leads per request`),
  source: z.enum(LEAD_SOURCES).default("business_os"),
  /** A lead matching an existing contact: fill its blank fields ("update", never overwrites) or leave it ("skip"). */
  onDuplicate: z.enum(["update", "skip"]).default("update"),
  /** Tags added to every lead in the request. */
  tags: z.array(requiredText(50)).max(20).default([]),
  /** Enroll every lead that resolves to a contact in this (launched) campaign. */
  campaignId: z.string().uuid().optional(),
  /** Subscribe every lead that resolves to a contact to this lead list (e.g. a newsletter signup form). */
  listId: z.string().uuid().optional(),
  /** The same by name: the active list with that name (ignoring case), created if there is none. A lead's own listName wins. */
  listName: requiredText(120).optional(),
  /**
   * The leads agreed to marketing email (a ticked opt-in box): recorded on
   * each contact with where they agreed, so list campaigns reach them.
   */
  consent: z.object({ confirmed: z.literal(true), source: requiredText(200) }).optional(),
});
export type LeadIngestInputT = z.infer<typeof LeadIngestInput>;

/** The Idempotency-Key header: 1–200 visible ASCII characters. */
export const IdempotencyKeyHeader = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, "Use visible ASCII characters only");
