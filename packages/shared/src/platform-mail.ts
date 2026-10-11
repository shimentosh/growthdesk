/*
 * The platform's own (system) email templates — the SaaS talking to its users,
 * not a workspace talking to its contacts. Each key has a fixed variable list;
 * a template edited in the super-admin may only use these, and every key that
 * carries a link must keep {{action_url}}.
 *
 * The code defaults live in the API (apps/api/src/platform-mail); this file is
 * the contract both apps share.
 */

export const PLATFORM_TEMPLATE_KEYS = [
  "verify_email",
  "reset_password",
  "invitation",
  "notification",
  "payment_failed",
  "trial_ended",
  "email_changed",
  "account_deleted",
  "waitlist_confirmed",
  "signup_invite",
] as const;
export type PlatformTemplateKey = (typeof PLATFORM_TEMPLATE_KEYS)[number];

export type PlatformTemplateVariable = { key: string; label: string; sample: string };

/** Available to every template. */
export const PLATFORM_COMMON_VARIABLES: PlatformTemplateVariable[] = [
  { key: "product_name", label: "Product name", sample: "Growthdesk" },
  { key: "support_email", label: "Support email", sample: "support@example.com" },
  { key: "name", label: "Recipient's name", sample: "Alex" },
];

export const PLATFORM_TEMPLATES: Record<
  PlatformTemplateKey,
  { label: string; category: "account" | "team" | "billing" | "notifications" | "signup"; variables: PlatformTemplateVariable[]; required: string[] }
> = {
  verify_email: {
    label: "Confirm email",
    category: "account",
    variables: [{ key: "action_url", label: "Confirmation link", sample: "https://app.example.com/verify-email?token=…" }],
    required: ["action_url"],
  },
  reset_password: {
    label: "Reset password",
    category: "account",
    variables: [{ key: "action_url", label: "Reset link", sample: "https://app.example.com/reset-password?token=…" }],
    required: ["action_url"],
  },
  invitation: {
    label: "Workspace invitation",
    category: "team",
    variables: [
      { key: "inviter", label: "Who invited them", sample: "Sam Rivera" },
      { key: "workspace", label: "Workspace name", sample: "Acme Sales" },
      { key: "action_url", label: "Accept link", sample: "https://app.example.com/invite/…" },
    ],
    required: ["action_url"],
  },
  notification: {
    label: "Notification",
    category: "notifications",
    variables: [
      { key: "title", label: "Title", sample: "A reply arrived" },
      { key: "body", label: "Body", sample: "Jordan replied to your campaign." },
      { key: "action_url", label: "Link", sample: "https://app.example.com/w/…" },
    ],
    required: ["title", "body"],
  },
  payment_failed: {
    label: "Payment failed",
    category: "billing",
    variables: [
      { key: "grace_days", label: "Days until restricted", sample: "7" },
      { key: "action_url", label: "Billing link", sample: "https://app.example.com/w/…/settings/billing" },
    ],
    required: ["action_url"],
  },
  trial_ended: {
    label: "Trial ended",
    category: "billing",
    variables: [
      { key: "plan", label: "Plan they fell back to", sample: "Free" },
      { key: "action_url", label: "Billing link", sample: "https://app.example.com/w/…/settings/billing" },
    ],
    required: ["action_url"],
  },
  email_changed: {
    label: "Email address changed",
    category: "account",
    variables: [
      { key: "old_email", label: "Old address", sample: "alex@old.example" },
      { key: "new_email", label: "New address", sample: "alex@new.example" },
    ],
    required: [],
  },
  account_deleted: {
    label: "Account deleted",
    category: "account",
    variables: [],
    required: [],
  },
  waitlist_confirmed: {
    label: "Joined the waitlist",
    category: "signup",
    variables: [],
    required: [],
  },
  signup_invite: {
    label: "Sign-up invitation",
    category: "signup",
    variables: [
      { key: "action_url", label: "Sign-up link", sample: "https://app.example.com/register?invite=…" },
      { key: "expires_days", label: "Days the link is valid", sample: "14" },
    ],
    required: ["action_url"],
  },
};

/** The variables a template may use: its own plus the common ones. */
export function platformTemplateVariables(key: PlatformTemplateKey): PlatformTemplateVariable[] {
  return [...PLATFORM_COMMON_VARIABLES, ...PLATFORM_TEMPLATES[key].variables];
}
