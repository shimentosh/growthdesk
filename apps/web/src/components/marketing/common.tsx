"use client";

import { useMemo } from "react";
import { renderEmail, type EmailBlock, type EmailTheme, type ListMembershipStatus, type MarketingCampaignStatus, type MarketingSendStatus, type SendingDomainStatus } from "@growthdesk/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { MarketingList, MarketingSetup, SkipReason } from "@/lib/types/marketing";

/*
 * Shared by the marketing screens: API paths and query keys, status badges,
 * the skip-reason wording, and the in-browser email preview (renderEmail is
 * pure and is exactly what the API sends).
 */

/** Marketing API path and query key under the current workspace: mk.path("/lists") → /workspaces/:id/marketing/lists. */
export function useMarketing() {
  const ws = useWorkspace();
  return useMemo(
    () => ({
      path: (p = "") => ws.path(`/marketing${p}`),
      key: (...parts: unknown[]) => ws.key("marketing", ...parts),
      href: (p = "") => ws.href(`/marketing${p}`),
    }),
    [ws],
  );
}

/** Active lists, for pickers. */
export function useMarketingLists(includeArchived = false) {
  const mk = useMarketing();
  return useApiQuery<MarketingList[]>(mk.key("lists", { archived: includeArchived }), mk.path(`/lists${includeArchived ? "?archived=true" : ""}`));
}

export function useMarketingSetup() {
  const mk = useMarketing();
  return useApiQuery<MarketingSetup>(mk.key("setup"), mk.path("/setup"));
}

const CAMPAIGN_TONE: Record<MarketingCampaignStatus, Tone> = { draft: "mute", scheduled: "info", sending: "live", paused: "warn", sent: "ok", canceled: "mute" };
const CAMPAIGN_LABEL: Record<MarketingCampaignStatus, string> = { draft: "Draft", scheduled: "Scheduled", sending: "Sending", paused: "Paused", sent: "Sent", canceled: "Canceled" };

export function CampaignStatusBadge({ status }: { status: MarketingCampaignStatus }) {
  return (
    <Badge tone={CAMPAIGN_TONE[status]} dot>
      {CAMPAIGN_LABEL[status]}
    </Badge>
  );
}

const MEMBER_TONE: Record<ListMembershipStatus, Tone> = { subscribed: "ok", unsubscribed: "mute", pending: "warn" };

export function MembershipBadge({ status }: { status: ListMembershipStatus }) {
  return (
    <Badge tone={MEMBER_TONE[status]} dot>
      {status === "subscribed" ? "Subscribed" : status === "unsubscribed" ? "Unsubscribed" : "Pending"}
    </Badge>
  );
}

const DOMAIN_TONE: Record<SendingDomainStatus, Tone> = { pending: "warn", verified: "ok", failed: "bad" };

export function DomainStatusBadge({ status, paused }: { status: SendingDomainStatus; paused?: boolean }) {
  if (paused)
    return (
      <Badge tone="warn" dot>
        Paused
      </Badge>
    );
  return (
    <Badge tone={DOMAIN_TONE[status]} dot>
      {status === "verified" ? "Verified" : status === "failed" ? "Failed" : "Pending"}
    </Badge>
  );
}

const SEND_TONE: Record<MarketingSendStatus, Tone> = { queued: "mute", sent: "ok", failed: "bad", skipped: "mute", bounced: "warn", complained: "bad" };

export function SendStatusBadge({ status }: { status: MarketingSendStatus }) {
  return <Badge tone={SEND_TONE[status]}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>;
}

/** Why a contact was not added to a list, in words for people. */
export const SKIP_LABEL: Record<SkipReason, string> = {
  not_found: "not found",
  no_email: "no email address",
  do_not_contact: "marked do not contact",
  no_consent: "no recorded marketing consent",
  consent_denied: "declined marketing",
  suppressed: "on the suppression list",
  unsubscribed: "unsubscribed before",
};

/** Sample values for previews, so tokens like {{first_name|there}} read naturally. */
export const PREVIEW_VARS = { first_name: "Alex", last_name: "Rivera", full_name: "Alex Rivera", email: "alex@example.com", company: "Acme" };

/**
 * The email exactly as recipients get it, in a sandboxed frame. The footer
 * uses placeholder company details; the real ones come from the company profile.
 */
export function EmailPreview({
  blocks,
  theme,
  preheader,
  legalName = "Your company",
  postalAddress = "Your postal address",
  className,
}: {
  blocks: EmailBlock[];
  /** The design's or campaign's theme, so the preview matches what is sent. */
  theme?: EmailTheme | null;
  preheader?: string;
  legalName?: string;
  postalAddress?: string;
  className?: string;
}) {
  const html = useMemo(
    () => renderEmail(blocks, { preheader, theme, vars: PREVIEW_VARS, footer: { legalName, postalAddress, preferencesUrl: "#" } }).html,
    [blocks, theme, preheader, legalName, postalAddress],
  );
  return <iframe title="Email preview" sandbox="" srcDoc={html} className={className ?? "h-full min-h-[560px] w-full rounded-lg border border-line bg-white"} />;
}
