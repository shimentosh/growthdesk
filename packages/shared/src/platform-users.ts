import { z } from "zod";
import { AdminUsersQuery } from "./admin.js";
import { requiredText } from "./schemas.js";

/*
 * Registration policy and platform user management (super-admin Phase 3):
 * sign-up modes, the waitlist, one-time sign-up invitations, first-touch
 * attribution, and the admin's user actions (notes, tags, change email,
 * export). The API is apps/api/src/auth and apps/api/src/admin/admin-users.*.
 */

export const SIGNUP_MODES = ["open", "invite_only", "waitlist", "closed"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** How an account came to exist. `invite` = a platform sign-up invitation; `workspace_invite` = a workspace invitation. */
export const SIGNUP_SOURCES = ["password", "google", "invite", "workspace_invite"] as const;
export type SignupSource = (typeof SIGNUP_SOURCES)[number];

/** Error codes POST /auth/register (and the Google callback's `?error=`) use when the sign-up policy refuses. */
export const SIGNUP_ERROR_CODES = [
  "signup_closed",
  "signup_waitlist",
  "signup_invite_required",
  "signup_invite_invalid",
  "signup_domain_not_allowed",
  "signup_domain_blocked",
] as const;
export type SignupErrorCode = (typeof SIGNUP_ERROR_CODES)[number];

export const ATTRIBUTION_COOKIE = "gd_attr";
/** The cookie is ignored above this size. */
export const ATTRIBUTION_MAX_BYTES = 2048;
export const ATTRIBUTION_UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

const attrText = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform((v) => v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max))
    .optional();

/** First-touch attribution, as the web proxy writes it into the `gd_attr` cookie (JSON). Unknown keys are dropped. */
export const SignupAttribution = z.object({
  utm_source: attrText(100),
  utm_medium: attrText(100),
  utm_campaign: attrText(150),
  utm_term: attrText(150),
  utm_content: attrText(150),
  referrer: attrText(500),
  landingPath: attrText(300),
});
export type SignupAttributionT = z.infer<typeof SignupAttribution>;

/** GET /auth/signup-policy?invite=… */
export const SignupPolicyQuery = z.object({ invite: z.string().max(200).optional() });

/** POST /auth/waitlist */
export const WaitlistJoinInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  name: z.string().trim().max(120).default(""),
});

// ─── Admin ───────────────────────────────────────────────────────────────────

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(200).default(50);
const search = z.string().trim().max(200).optional();
const boolParam = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();
const dateParam = z.coerce.date().optional();

/** A user tag: lower-case letters, digits and - _ : . (spaces become -). */
export const USER_TAG_PATTERN = /^[a-z0-9][a-z0-9_:.-]{0,39}$/;
export const normalizeUserTag = (t: string) => t.trim().toLowerCase().replace(/\s+/g, "-");

/** GET /admin/users — the original filters plus the Phase 3 ones. */
export const AdminUsersListQuery = AdminUsersQuery.extend({
  verified: boolParam,
  lastLoginFrom: dateParam,
  lastLoginTo: dateParam,
  /** A plan key: people in any workspace whose account is on this plan. */
  plan: z.string().trim().max(60).optional(),
  signupSource: z.enum(SIGNUP_SOURCES).optional(),
  tag: z.string().trim().max(40).transform(normalizeUserTag).optional(),
  /** Marketing consent: true = opted in; false = not opted in (no profile counts as not opted in). */
  consent: boolParam,
});
export type AdminUsersListQueryT = z.infer<typeof AdminUsersListQuery>;

/** GET /admin/users/export.csv — the list filters, without paging. */
export const AdminUsersExportQuery = AdminUsersListQuery.omit({ page: true, pageSize: true });

export const AdminUserNoteInput = z.object({ body: requiredText(5000) });

export const AdminUserTagsInput = z.object({
  tags: z
    .array(z.string().max(60).transform(normalizeUserTag))
    .max(20, "At most 20 tags")
    .refine((tags) => tags.every((t) => USER_TAG_PATTERN.test(t)), "Tags use letters, digits and - _ : . (up to 40 characters)"),
});

export const AdminChangeEmailInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
});

export const WAITLIST_STATUSES = ["pending", "invited", "rejected"] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export const AdminWaitlistQuery = z.object({
  page,
  pageSize,
  q: search,
  status: z.enum(WAITLIST_STATUSES).optional(),
});

export const SIGNUP_INVITE_STATUSES = ["pending", "used", "expired"] as const;
export type SignupInviteStatus = (typeof SIGNUP_INVITE_STATUSES)[number];

export const AdminSignupInvitesQuery = z.object({
  page,
  pageSize,
  q: search,
  status: z.enum(SIGNUP_INVITE_STATUSES).optional(),
});

export const SIGNUP_INVITE_DEFAULT_DAYS = 14;

export const AdminSignupInviteInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  expiresDays: z.number().int().min(1).max(90).default(SIGNUP_INVITE_DEFAULT_DAYS),
});

export const AdminWaitlistInviteInput = z.object({
  expiresDays: z.number().int().min(1).max(90).default(SIGNUP_INVITE_DEFAULT_DAYS),
});
