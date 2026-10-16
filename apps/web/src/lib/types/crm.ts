/*
 * Response shapes for the contacts & companies area. Each type names the
 * service method it mirrors (apps/api/src/crm/*); keep them in step.
 * Dates arrive as ISO strings.
 */
import type {
  CallStatus,
  Channel,
  ConsentStatus,
  ContactStatus,
  ConversationStatus,
  DealStatus,
  EnrollmentStatus,
  IdentifierKind,
  LifecycleStage,
  MeetingStatus,
  Priority,
  Qualification,
  StageKind,
  TaskStatus,
  TaskType,
} from "@growthdesk/shared";

export type TagRef = { id: string; name: string; color: string };

export type CustomFieldValue = string | number | boolean | null;

/** contacts.service.ts `contactDto()` — a row of GET /contacts, and the base of the record. */
export type Contact = {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  jobTitle: string;
  website: string;
  linkedinUrl: string;
  city: string;
  country: string;
  timezone: string;
  leadSource: string;
  company: { id: string; name: string; domain: string | null } | null;
  owner: { id: string; name: string; email: string } | null;
  priority: Priority;
  qualification: Qualification;
  status: ContactStatus;
  score: number | null;
  customFields: Record<string, CustomFieldValue>;
  tags: TagRef[];
  lastContactedAt: string | null;
  lastRepliedAt: string | null;
  nextActionAt: string | null;
  nextActionNote: string;
  doNotContact: boolean;
  unsubscribedAt: string | null;
  bouncedAt: string | null;
  consentStatus: ConsentStatus;
  consentSource: string;
  /** When consentStatus last changed (null when it never has). */
  consentAt: string | null;
  /** lead → sales → contact. */
  lifecycleStage: LifecycleStage;
  /** When lifecycleStage last changed (null when it never has). */
  stageChangedAt: string | null;
  /** Archived people are left out of lists, pickers and audiences unless asked for. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A deal as the contact and company records list it. */
export type RelatedDeal = {
  id: string;
  name: string;
  value: number;
  currency: string;
  status: DealStatus;
  stage: { id: string; name: string; kind: StageKind };
};

/** The Prisma Task row, as GET /contacts/:id returns it (open tasks only). */
export type RelatedTask = {
  id: string;
  type: TaskType;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  dueAt: string | null;
  assigneeId: string | null;
  createdAt: string;
};

/** The Prisma Meeting row. */
export type RelatedMeeting = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string;
  status: MeetingStatus;
};

/** The Prisma Call row (the fields the record shows). */
export type RelatedCall = {
  id: string;
  direction: string;
  status: CallStatus;
  outcome: string;
  durationSec: number | null;
  startedAt: string | null;
  createdAt: string;
};

/** GET /contacts/:id — contacts.service.ts `get()` */
export type ContactDetail = Contact & {
  identifiers: { id: string; kind: IdentifierKind; value: string; isPrimary: boolean }[];
  /** Where they came from; `details` is the sender's own account of it (form, campaign, page…), as label/value lines. */
  sources: { id: string; source: string; externalId: string | null; importId: string | null; createdAt: string; details: { label: string; value: string }[] }[];
  /** Why the email/phone may not be contacted, or null. */
  suppressed: string | null;
  deals: RelatedDeal[];
  tasks: RelatedTask[];
  enrollments: {
    id: string;
    status: EnrollmentStatus;
    stopReason: string;
    campaign: { id: string; name: string; status: string };
    enrolledAt: string;
    nextRunAt: string | null;
  }[];
  conversations: { id: string; channel: Channel; subject: string; lastMessageAt: string | null; unread: boolean; status: ConversationStatus }[];
  meetings: RelatedMeeting[];
  calls: RelatedCall[];
};

/** GET /companies — companies.service.ts `list()` */
export type CompanyRow = {
  id: string;
  name: string;
  domain: string | null;
  website: string;
  industry: string;
  size: string;
  country: string;
  region: string;
  city: string;
  owner: { id: string; name: string } | null;
  tags: TagRef[];
  contactCount: number;
  dealCount: number;
  createdAt: string;
};

/** The Prisma Note row; contact notes (crm-extras `notes()`) add the author. */
export type Note = {
  id: string;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  authorId: string | null;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  author?: { id: string; name: string } | null;
};

/** The Prisma Activity row; the contact timeline (crm-extras `timeline()`) adds the actor. */
export type ActivityEntry = {
  id: string;
  type: string;
  summary: string;
  data: Record<string, unknown>;
  occurredAt: string;
  actorId: string | null;
  actor?: { id: string; name: string } | null;
  /** Who acted: user | ai_agent | workflow | integration | system (older entries: user when actorId is set). */
  actorType?: string;
  /** The agent's, workflow's or integration's name when it acted. */
  actorName?: string;
  actorRef?: string;
  onBehalfOfId?: string | null;
};

/** GET /companies/:id — companies.service.ts `get()` (the company row spread, plus relations). */
export type CompanyDetail = {
  id: string;
  name: string;
  domain: string | null;
  website: string;
  industry: string;
  size: string;
  country: string;
  region: string;
  city: string;
  phone: string;
  description: string;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  customFields: Record<string, CustomFieldValue>;
  createdAt: string;
  updatedAt: string;
  tags: TagRef[];
  /** At most 200, newest first. */
  contacts: Contact[];
  deals: RelatedDeal[];
  notes: Note[];
  /** At most 100, newest first. */
  activities: ActivityEntry[];
};

/** Defined with the settings pages; re-exported so this area imports from one place. */
export type { CustomFieldDefinition, TagRow } from "./crm-settings";

/** GET /views — the Prisma SavedView row. `userId` null = shared with the workspace. */
export type SavedView = {
  id: string;
  userId: string | null;
  entity: string;
  name: string;
  filters: Record<string, unknown>;
  sort: { field?: string; dir?: "asc" | "desc" } & Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/** GET /contacts/duplicates — contacts.service.ts `duplicates()` */
export type DuplicatePair = { id: string; reason: string; score: number; a: Contact; b: Contact };

/** POST /contacts/bulk */
export type BulkResult = { affected: number };

/** One change to a contact's marketing consent (GET /contacts/:id/consent). */
export type ConsentEntry = {
  id: string;
  status: ConsentStatus;
  source: string;
  ip: string;
  userAgent: string;
  detail: { via?: string } & Record<string, unknown>;
  actor: { id: string; name: string } | null;
  createdAt: string;
};
