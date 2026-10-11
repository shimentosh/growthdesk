import type { EmailBlock, PlatformTemplateKey } from "@growthdesk/shared";

/*
 * The code defaults for every system email (keys and variables:
 * packages/shared/src/platform-mail.ts). An admin-published version replaces
 * one of these until it is reset. Wording is ported from the old hardcoded
 * mail (core/mail.service.ts, billing.service.ts); the product name is always
 * {{product_name}} so branding applies.
 */

export type PlatformTemplateContent = { subject: string; preheader: string; blocks: EmailBlock[] };

const heading = (id: string, text: string): EmailBlock => ({ type: "heading", id, text, level: 1, align: "left" });
const text = (id: string, body: string): EmailBlock => ({ type: "text", id, text: body, align: "left" });
const button = (id: string, label: string, url = "{{action_url}}"): EmailBlock => ({ type: "button", id, label, url, align: "left" });
const pasteLink = (id: string, after = ""): EmailBlock =>
  text(id, `If the button does not work, paste this link into your browser:\n{{action_url}}${after ? `\n\n${after}` : ""}`);

export const PLATFORM_TEMPLATE_DEFAULTS: Record<PlatformTemplateKey, PlatformTemplateContent> = {
  verify_email: {
    subject: "Confirm your email for {{product_name}}",
    preheader: "One click to finish setting up your account.",
    blocks: [
      heading("h", "Confirm your email"),
      text("t", "Hi {{name|there}},\n\nConfirm your email address to finish setting up {{product_name}}. The link expires in 24 hours."),
      button("b", "Confirm email"),
      pasteLink("p", "If you did not sign up, ignore this email."),
    ],
  },
  reset_password: {
    subject: "Reset your {{product_name}} password",
    preheader: "The link is valid for one hour.",
    blocks: [
      heading("h", "Reset your password"),
      text("t", "Someone asked to reset the password for this account. The link is valid for one hour."),
      button("b", "Choose a new password"),
      pasteLink("p", "If it was not you, ignore this email — your password has not changed."),
    ],
  },
  account_exists: {
    subject: "You already have a {{product_name}} account",
    preheader: "Sign in instead, or reset your password.",
    blocks: [
      heading("h", "You already have an account"),
      text(
        "t",
        "Hi {{name|there}},\n\nSomeone tried to create a {{product_name}} account with this email address, but it already has one. No new account was created and nothing about your account has changed.\n\nIf it was you, sign in instead. Forgot your password? Choose \"Forgot password\" on the sign-in page.",
      ),
      button("b", "Sign in"),
      pasteLink("p", "If it was not you, you can ignore this email."),
    ],
  },
  invitation: {
    subject: "{{inviter}} invited you to {{workspace}} on {{product_name}}",
    preheader: "The invitation is valid for 7 days.",
    blocks: [
      heading("h", "Join {{workspace}}"),
      text("t", "{{inviter}} invited you to join {{workspace}} on {{product_name}}. The invitation is valid for 7 days."),
      button("b", "Accept invitation"),
      pasteLink("p"),
    ],
  },
  notification: {
    subject: "{{title}}",
    preheader: "",
    blocks: [heading("h", "{{title}}"), text("t", "{{body}}"), button("b", "Open in {{product_name}}")],
  },
  payment_failed: {
    subject: "Payment failed for your {{product_name}} subscription",
    preheader: "Update your payment method to keep sending.",
    blocks: [
      heading("h", "We could not take your payment"),
      text(
        "t",
        "We could not take the latest payment. Your workspace keeps working for {{grace_days}} days; after that, sending pauses until the invoice is paid. Update your payment method from Billing.",
      ),
      button("b", "Open billing"),
    ],
  },
  trial_ended: {
    subject: "Your {{product_name}} trial has ended",
    preheader: "Nothing has been deleted.",
    blocks: [
      heading("h", "Your trial has ended"),
      text("t", "Your trial has ended and your workspace has moved to the {{plan|free}} allowance. Nothing has been deleted — choose a plan to restore your full limits."),
      button("b", "Choose a plan"),
    ],
  },
  email_changed: {
    subject: "Your {{product_name}} email address was changed",
    preheader: "",
    blocks: [
      heading("h", "Your email address was changed"),
      text(
        "t",
        "Hi {{name|there}},\n\nThe email address for your {{product_name}} account was changed from {{old_email}} to {{new_email}}.\n\nIf you made this change, there is nothing else to do. If you did not, contact {{support_email|our support team}} right away.",
      ),
    ],
  },
  two_factor_reset: {
    subject: "Two-factor authentication was turned off for your {{product_name}} account",
    preheader: "",
    blocks: [
      heading("h", "Two-factor authentication was reset"),
      text(
        "t",
        "Hi {{name|there}},\n\nAt your request, our support team turned off two-factor authentication for your {{product_name}} account and signed it out everywhere. Your old recovery codes no longer work.\n\nSign in with your password and set up two-factor again from your account settings. If you did not ask for this, contact {{support_email|our support team}} right away.",
      ),
    ],
  },
  account_deleted: {
    subject: "Your {{product_name}} account has been deleted",
    preheader: "",
    blocks: [
      heading("h", "Your account has been deleted"),
      text(
        "t",
        "Hi {{name|there}},\n\nYour {{product_name}} account and the personal data in it have been deleted. You will not receive further emails about this account.\n\nIf you did not expect this, contact {{support_email|our support team}}.",
      ),
    ],
  },
  waitlist_confirmed: {
    subject: "You're on the {{product_name}} waitlist",
    preheader: "We will email you when a place opens up.",
    blocks: [
      heading("h", "You're on the waitlist"),
      text("t", "Hi {{name|there}},\n\nThanks for your interest in {{product_name}}. You are on the waitlist, and we will email you an invitation as soon as a place opens up."),
    ],
  },
  signup_invite: {
    subject: "You're invited to {{product_name}}",
    preheader: "Create your account — the link is valid for {{expires_days|14}} days.",
    blocks: [
      heading("h", "You're invited"),
      text("t", "You have been invited to create a {{product_name}} account. The invitation link is valid for {{expires_days|14}} days."),
      button("b", "Create your account"),
      pasteLink("p"),
    ],
  },
};
