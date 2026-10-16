import { z } from "zod";
import { email } from "./schemas.js";

/*
 * Commerce sync: a client portal (Clientdesk) keeps Growthdesk told about its
 * clients and their orders, so a contact shows what they bought and the team
 * can market by it ("signed up, never ordered", "repeat customers").
 *
 *   POST /workspaces/:id/commerce/customers   — up to 100 clients
 *   POST /workspaces/:id/commerce/orders      — up to 100 orders
 *   GET  /workspaces/:id/commerce/status      — the connection check, and counts
 *
 * API key with `customers:write`. Each record is upserted by (source,
 * externalId), so sending one again updates it; each is checked on its own,
 * so one bad record fails alone. The sender sends what changed — it is the
 * source of truth for these records.
 */

export const COMMERCE_SOURCES = ["clientdesk"] as const;

/** Records per request. */
export const MAX_COMMERCE_BATCH = 100;

const money = z.number().min(0).max(999_999_999_999.99);
const iso = z.coerce.date();
const data = z
  .record(z.string().max(60), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 10_000, "Keep data under 10,000 characters of JSON");

/** The client's company, keyed on the sender's id ("cmp_…"). */
export const CommerceCompanyInput = z.object({
  externalId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(200).optional(),
  country: z.string().trim().max(100).optional(),
});

/** A client: a person with an account in the portal ("per_…"). */
export const CustomerInput = z.object({
  externalId: z.string().trim().min(1).max(200),
  fullName: z.string().trim().max(200).optional(),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  email: z.union([email, z.literal("")]).optional(),
  phone: z.string().trim().max(40).optional(),
  country: z.string().trim().max(100).optional(),
  company: CommerceCompanyInput.optional(),
  /** When they became a client: signed up, or were added. */
  since: iso.optional(),
  /** The sender's own word for them ("Client", "VIP", "Churned"). */
  status: z.string().trim().max(60).optional(),
  data: data.optional(),
});
export type CustomerInputT = z.infer<typeof CustomerInput>;

export const ORDER_STATES = ["open", "completed", "cancelled"] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const OrderItemInput = z.object({
  name: z.string().trim().min(1).max(300),
  quantity: z.number().min(0).max(1_000_000).default(1),
  unitPrice: money.default(0),
  total: money.default(0),
  /** The catalog item it was, as the catalog sync keys it ("tier:…"), to link the Product. */
  productExternalId: z.string().trim().max(200).optional(),
});

export const OrderInput = z.object({
  externalId: z.string().trim().min(1).max(200),
  /** As people see it ("ORD-482913"). */
  number: z.string().trim().max(60).default(""),
  /** The client who placed it (a CustomerInput externalId). */
  customerExternalId: z.string().trim().max(200).optional(),
  company: CommerceCompanyInput.optional(),
  /** The sender's own status words ("In progress"). */
  status: z.string().trim().max(60).default(""),
  state: z.enum(ORDER_STATES),
  paid: z.boolean(),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((c) => c.toUpperCase()),
  total: money,
  placedAt: iso,
  paidAt: iso.nullable().optional(),
  completedAt: iso.nullable().optional(),
  cancelledAt: iso.nullable().optional(),
  items: z.array(OrderItemInput).max(200).default([]),
  data: data.optional(),
});
export type OrderInputT = z.infer<typeof OrderInput>;

/** Records are checked one by one (CustomerInput / OrderInput) so a bad one fails alone. */
export const CustomersSyncInput = z.object({
  source: z.enum(COMMERCE_SOURCES),
  customers: z.array(z.unknown()).min(1, "Send at least one client").max(MAX_COMMERCE_BATCH, `Send up to ${MAX_COMMERCE_BATCH} clients per request`),
});
export const OrdersSyncInput = z.object({
  source: z.enum(COMMERCE_SOURCES),
  orders: z.array(z.unknown()).min(1, "Send at least one order").max(MAX_COMMERCE_BATCH, `Send up to ${MAX_COMMERCE_BATCH} orders per request`),
});

export type CommerceRecordStatus = "created" | "updated" | "unchanged" | "failed";
export type CommerceSyncResult = {
  summary: { received: number; created: number; updated: number; unchanged: number; failed: number };
  results: { index: number; externalId: string | null; status: CommerceRecordStatus; contactId: string | null; error: { code: string; message: string } | null }[];
};

/** A contact's orders on its page (GET /contacts/:id/orders). */
export type ContactOrder = {
  id: string;
  number: string;
  status: string;
  state: OrderState;
  paid: boolean;
  currency: string;
  total: number;
  items: { name: string; quantity: number; total: number }[];
  placedAt: string;
  paidAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
};
