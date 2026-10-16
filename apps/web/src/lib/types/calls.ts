import type { AiCallAnalysisT, CallOutcome, CallStatus, Priority, TranscriptTurn } from "@growthdesk/shared";

/*
 * Response shapes of the calling API (apps/api/src/calls). Each type names the
 * service method that produces it.
 */

/** A call — calls.service.ts `callDto()` */
export type CallRow = {
  id: string;
  provider: "manual" | "twilio" | "cartesia" | string;
  direction: string;
  status: CallStatus;
  outcome: CallOutcome | "";
  notes: string;
  durationSec: number | null;
  fromNumber: string;
  toNumber: string;
  startedAt: string | null;
  endedAt: string | null;
  callbackAt: string | null;
  scriptId: string | null;
  taskId: string | null;
  integrationId: string | null;
  contact: { id: string; fullName: string; email: string | null; phone: string | null } | null;
  deal: { id: string; name: string } | null;
  user: { id: string; name: string } | null;
  /** AI calls (provider "cartesia"): the agent that spoke. */
  agent: { id: string; name: string } | null;
  campaignId: string | null;
  /** The provider's (or the model's) short summary of an AI call. */
  summary: string;
  /** Cartesia's end reason (client_hangup, dial_no_answer, voicemail_detected…), "" for other calls. */
  endReason: string;
  /** AI calls, once judged — packages/shared/src/ai-calling.ts AiCallAnalysis (callbackAt as an ISO string). */
  analysis: AiCallAnalysisRow | null;
  /** What was said. Only GET /calls/:id fills it; lists send []. */
  transcript: TranscriptTurn[];
  /** When an AI call's result was applied; null while it is still being judged. */
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiCallAnalysisRow = Omit<AiCallAnalysisT, "callbackAt"> & { callbackAt: string | null };

/** GET /calls/setup — twilio-calls.service.ts `setup()` */
export type CallSetup = {
  twilio: { id: string; name: string; status: string; lastError: string; callerId: string }[];
  /** Whether "Call" can ring the rep through Twilio here; `reason` says why not. */
  clickToCall: { available: boolean; reason: string | null };
};

/** One entry of GET /calls/queue — calls.service.ts `queue()` */
export type CallQueueItem = {
  taskId: string;
  title: string;
  description: string;
  priority: Priority;
  dueAt: string | null;
  source: string;
  createdAt: string;
  assignee: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  contact: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    jobTitle: string;
    timezone: string;
    company: { id: string; name: string } | null;
  } | null;
  /** Why this contact cannot be called now (do not contact, no number, on the do-not-contact list), or null. */
  blocked: string | null;
  lastCall: { id: string; status: CallStatus; outcome: string; createdAt: string } | null;
};

/** POST /calls/queue */
export type CallQueueAddResult = { added: number; skipped: { contactId: string; reason: string }[] };

/** The CallScript row. */
export type CallScript = { id: string; name: string; body: string; createdById: string | null; createdAt: string; updatedAt: string };

/** Who is being called, as much as the call screen needs. */
export type CallTarget = {
  id: string;
  fullName: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email: string | null;
  phone: string | null;
  jobTitle?: string | null;
  company?: { name?: string | null; domain?: string | null } | null;
  customFields?: unknown;
};
