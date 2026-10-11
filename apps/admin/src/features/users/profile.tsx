"use client";

import { Check } from "lucide-react";
import type { SignupSource } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import type { AdminUserDetail, AdminUserRow, Person } from "@/features/common/types";

/*
 * Platform user profile shapes and small pieces (super-admin Phase 3).
 * Keep in step with apps/api/src/admin/user-profile.ts (profileSummary /
 * profileDetail) and admin-users.service.ts.
 */

/** Every user row of GET /admin/users and /admin/users/:id carries these. */
export type UserProfileSummary = {
  signupSource: SignupSource | null;
  utmSource: string | null;
  tags: string[];
  marketingConsent: boolean;
  anonymisedAt: string | null;
};

export type UserProfile = {
  signupSource: SignupSource | null;
  utm: Partial<Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_term" | "utm_content", string>>;
  referrer: string;
  landingPath: string;
  marketingConsent: boolean;
  consentAt: string | null;
  consentSource: string;
  unsubscribedAt: string | null;
  suppressedAt: string | null;
  suppressionReason: string;
  tags: string[];
  anonymisedAt: string | null;
};

export type UserRow = AdminUserRow & UserProfileSummary;
export type UserDetailData = AdminUserDetail & UserProfileSummary & { profile: UserProfile | null };

/** GET /admin/users/:id/notes */
export type UserNote = { id: string; body: string; createdAt: string; author: Person | null };

export const SIGNUP_SOURCE_LABELS: Record<SignupSource, string> = {
  password: "Email & password",
  google: "Google",
  invite: "Sign-up invitation",
  workspace_invite: "Workspace invitation",
};

const SOURCE_TONES: Record<SignupSource, Tone> = { password: "mute", google: "live", invite: "info", workspace_invite: "info" };

export const CONSENT_SOURCE_LABELS: Record<string, string> = {
  signup_form: "the sign-up form",
  account_settings: "account settings",
  admin: "platform staff",
  preference_page: "the email preferences page",
};

export function SignupSourceBadge({ source }: { source: SignupSource | null }) {
  if (!source)
    return (
      <span className="text-text-3" title="Created before sign-up tracking">
        —
      </span>
    );
  return (
    <Badge tone={SOURCE_TONES[source]} quiet>
      {SIGNUP_SOURCE_LABELS[source] ?? source}
    </Badge>
  );
}

export function ConsentMark({ consent }: { consent: boolean }) {
  return consent ? (
    <span className="inline-flex items-center gap-1 text-xs text-ok-ink">
      <Check aria-hidden className="size-3.5" /> Opted in
    </span>
  ) : (
    <span className="text-xs text-text-3">No</span>
  );
}

/** Tag chips; `max` collapses the rest into "+n". */
export function TagChips({ tags, max, className }: { tags: string[]; max?: number; className?: string }) {
  if (!tags.length) return <span className="text-text-3">—</span>;
  const shown = max ? tags.slice(0, max) : tags;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {shown.map((t) => (
        <Badge key={t} tone="mute">
          {t}
        </Badge>
      ))}
      {max && tags.length > max && (
        <span className="text-2xs text-text-3" title={tags.slice(max).join(", ")}>
          +{tags.length - max}
        </span>
      )}
    </span>
  );
}
