/*
 * Contract between the campaign engine and AI calling. Implemented by
 * AiCallsService; provided under AI_CALLER by AiCallingModule, so the engine
 * (campaigns) does not import the calling module's internals.
 */
export const AI_CALLER = Symbol("AI_CALLER");

export type AiStepCallInput = {
  workspaceId: string;
  agentId: string;
  contactId: string;
  campaignId: string;
  enrollmentId: string;
  /** Who the call's follow-ups (callback, meeting) are assigned to when the contact has no owner. */
  fallbackOwnerId: string | null;
  /** Write-ahead id of the Call row, as messageRowId is for a message: a retried id never dials twice. */
  callRowId: string;
};

export type AiStepCallResult =
  | { status: "placed"; callId: string }
  /** The contact cannot be AI-called (no consent, no number): the step is skipped and the sequence goes on. */
  | { status: "skipped"; reason: string }
  /** Not now (outside their calling hours, called too recently, AI calling not connected): try again at `at`. */
  | { status: "later"; at: Date; reason: string }
  /** On the do-not-contact list: the enrollment stops, as for a blocked message. */
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string; permanent: boolean }
  /** Cartesia may have dialled (the request was sent and no answer came back): never dialled again automatically. */
  | { status: "uncertain"; reason: string; callId: string };

export type AiCaller = {
  callForStep(input: AiStepCallInput): Promise<AiStepCallResult>;
  /** What became of a call the engine started under `callRowId` (a step left "running" by a crash). */
  stepCallState(workspaceId: string, callRowId: string): Promise<"none" | "placed" | "failed" | "unknown">;
};
