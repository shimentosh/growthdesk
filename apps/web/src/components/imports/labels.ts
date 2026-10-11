/*
 * Display names for the import destinations and tag colours. The field keys
 * are camelCase identifiers, which labelOf() would not turn into words.
 */
import type { Tone } from "@/components/ui/Badge";
import type { ImportField } from "@/lib/types/imports";

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  email: "Email",
  phone: "Phone",
  jobTitle: "Job title",
  company: "Company name",
  companyDomain: "Company domain",
  website: "Website",
  linkedinUrl: "LinkedIn URL",
  city: "City",
  country: "Country",
  leadSource: "Lead source",
  tags: "Tags",
  externalId: "External ID",
  notes: "Note",
};

/** Short explanations for the destinations that do something less obvious than store the value. */
export const IMPORT_FIELD_HINTS: Partial<Record<ImportField, string>> = {
  tags: "Split on , ; or |",
  companyDomain: "Used as website and company name when those are blank",
  notes: "Added as a note on the contact",
  externalId: "Your system's ID, kept on the contact's source",
};

/** At least one of these must be mapped (imports.service.ts `start()`). */
export const IMPORT_IDENTITY_FIELDS = ["email", "phone", "fullName", "firstName", "lastName"] as const;

/** "email" → "Email", "custom.plan" → the custom field's label (or the key when unknown). */
export function importFieldLabel(target: string, customLabels: Record<string, string> = {}): string {
  if (!target) return "Skipped";
  if (target.startsWith("custom.")) {
    const key = target.slice(7);
    return customLabels[key] ?? key;
  }
  return IMPORT_FIELD_LABELS[target as ImportField] ?? target;
}

/** The colours offered for a tag. The API stores any short name; these are the ones the design tokens can draw. */
export const TAG_COLORS = ["gray", "blue", "green", "amber", "red", "purple"] as const;

const TAG_TONES: Record<string, Tone> = {
  gray: "mute",
  slate: "mute",
  blue: "live",
  indigo: "live",
  green: "ok",
  amber: "warn",
  orange: "warn",
  yellow: "warn",
  red: "bad",
  purple: "info",
  violet: "info",
};

/** A tag's stored colour name as a Badge tone (unknown names are grey). */
export const tagTone = (color: string | null | undefined): Tone => TAG_TONES[(color ?? "").toLowerCase()] ?? "mute";
