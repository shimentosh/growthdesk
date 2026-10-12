import type { EmailBlock, EmailTheme } from "@growthdesk/shared";
import { cleanTheme } from "@/components/marketing/designs/ThemePanel";
import type { MarketingCampaign, MarketingCampaignPatch } from "@/lib/types/marketing";

/*
 * The draft editor's model. Each section edits a few campaign fields; edits
 * are kept as overrides on top of the saved campaign, so a save (or a refetch)
 * flows straight through and "unsaved" is exactly "an override differs".
 */

export type Draft = {
  name: string;
  subject: string;
  preheader: string;
  fromName: string;
  fromLocalPart: string;
  sendingDomainId: string | null;
  replyTo: string;
  audience: MarketingCampaign["audience"];
  blocks: EmailBlock[];
  theme: EmailTheme;
  trackOpens: boolean;
  trackClicks: boolean;
};
export type DraftKey = keyof Draft;

export const SECTIONS = ["details", "audience", "content", "tracking", "review"] as const;
export type Section = (typeof SECTIONS)[number];
export type EditableSection = Exclude<Section, "review">;

export const SECTION_FIELDS: Record<EditableSection, DraftKey[]> = {
  details: ["name", "subject", "preheader", "fromName", "fromLocalPart", "sendingDomainId", "replyTo"],
  audience: ["audience"],
  content: ["blocks", "theme"],
  tracking: ["trackOpens", "trackClicks"],
};

export const SECTION_LABEL: Record<Section, string> = { details: "Details", audience: "Audience", content: "Content", tracking: "Tracking", review: "Review & send" };

export const draftOf = (c: MarketingCampaign): Draft => ({
  name: c.name,
  subject: c.subject,
  preheader: c.preheader,
  fromName: c.fromName,
  fromLocalPart: c.fromLocalPart,
  sendingDomainId: c.sendingDomainId,
  replyTo: c.replyTo,
  audience: c.audience,
  blocks: c.blocks,
  theme: cleanTheme(c.theme ?? {}),
  trackOpens: c.trackOpens,
  trackClicks: c.trackClicks,
});

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The PATCH body for some fields of the draft. */
export function patchOf(value: Draft, keys: DraftKey[]): MarketingCampaignPatch {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === "audience") out.audience = { listIds: value.audience.listIds, excludeListIds: value.audience.excludeListIds, viewId: value.audience.viewId };
    else out[k] = value[k];
  }
  return out as MarketingCampaignPatch;
}

/** Field errors from the API ("audience.listIds", "blocks.2.url") → the section they belong to. */
export function sectionOfField(field: string): EditableSection | null {
  const head = field.split(".")[0] as DraftKey;
  for (const s of Object.keys(SECTION_FIELDS) as EditableSection[]) if (SECTION_FIELDS[s].includes(head)) return s;
  return null;
}

/**
 * Where a readiness problem (campaigns.service `readiness`, in the API's
 * own words) is fixed: a section of this editor, or a settings page.
 */
export type ProblemHome = EditableSection | "setup" | "profile" | "plan";

export function problemHome(problem: string): ProblemHome {
  if (/^(Button|Image) \d+ needs|^Add some text|^The hero's button|^Column \d+ in block|^Every social link/.test(problem)) return "content";
  if (/email service/i.test(problem)) return "setup";
  if (/company profile/i.test(problem)) return "profile";
  if (/is not verified|^Sending from .* is paused/i.test(problem)) return "setup";
  if (/sending domain|From address|From name|subject line/i.test(problem)) return "details";
  if (/\blists?\b/i.test(problem)) return "audience";
  return "plan";
}
