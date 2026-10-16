import type { AiAgentGoal, AiAgentLanguage } from "@growthdesk/shared";

/*
 * Response shapes of the AI calling API (apps/api/src/ai-calling). Each type
 * names the service method that produces it. Inputs are the shared zod
 * schemas (AiAgentInput, CartesiaConnectInput, AiCallingSettingsPatch,
 * AiTestCallInput, AiCallContactInput) in packages/shared/src/ai-calling.ts.
 *
 *   GET    /ai-calling/setup            AiCallingSetup
 *   POST   /ai-calling/cartesia         {apiKey, name?} → AiCallingConnection
 *   PATCH  /ai-calling/settings         {phoneNumberId?, windowFrom?, windowTo?, days?, minHoursBetweenCalls?} → AiCallingConnection
 *   GET    /ai-calling/voices?q=&language=&gender=   AiVoice[]
 *   POST   /channels/:id/verify, DELETE /channels/:id  (verify / disconnect the connection)
 *   GET    /call-agents?archived=exclude|only|all   AiAgent[]
 *   POST   /call-agents                 AiAgentInput → AiAgentDetail
 *   GET    /call-agents/:id             AiAgentDetail
 *   PATCH  /call-agents/:id             Partial<AiAgentInput> → AiAgentDetail
 *   POST   /call-agents/:id/sync        → AiAgentDetail (push to Cartesia again)
 *   POST   /call-agents/:id/duplicate   → AiAgentDetail
 *   DELETE /call-agents/:id             → AiAgentDetail (archived; 409 while a live campaign uses it)
 *   POST   /call-agents/:id/restore     → AiAgentDetail
 *   POST   /call-agents/:id/test-call   {toNumber, variables?, consent: true} → CallRow
 *   POST   /call-agents/:id/call        {contactId} → CallRow (409 with the reason when the rules say no)
 */

/** ai-calls.service.ts `dto()` */
export type AiCallingConnection = {
  id: string;
  provider: "cartesia";
  name: string;
  status: "connected" | "error" | "disconnected";
  lastError: string;
  lastEventAt: string | null;
  phoneNumberId: string | null;
  phoneNumber: string;
  numbers: { id: string; number: string; label: string | null }[];
  /** Whether Cartesia posts call events to us; `note` says why not (results are then fetched every minute). */
  webhook: { registered: boolean; note: string };
  settings: { windowFrom: string; windowTo: string; days: number[]; minHoursBetweenCalls: number };
  createdAt: string;
  updatedAt: string;
};

/** GET /ai-calling/setup — ai-calls.service.ts `setup()` */
export type AiCallingSetup = {
  connection: AiCallingConnection | null;
  /** Whether AI calls can be placed now; `reason` says why not (plan, not connected, no number). */
  ready: boolean;
  reason: string | null;
  /** Whether finished calls are judged by an AI model (else by keyword heuristics). */
  aiAnalysis: boolean;
  webhookUrl: string | null;
};

/** GET /ai-calling/voices — cartesia.ts `voices()` */
export type AiVoice = { id: string; name: string; description: string; language: string; gender: string | null };

export type AiAgentStats = { calls: number; connected: number; meetings: number; lastCallAt: string | null };

/** ai-agents.service.ts `dto()` (+ stats in the list) */
export type AiAgent = {
  id: string;
  name: string;
  templateKey: string;
  goal: AiAgentGoal;
  language: AiAgentLanguage;
  voiceId: string;
  voiceName: string;
  personaName: string;
  businessName: string;
  greeting: string;
  disclosure: string;
  about: string;
  goalDetails: string;
  questions: string[];
  objections: { objection: string; response: string }[];
  voicemailMessage: string;
  extraInstructions: string;
  transferNumber: string;
  maxCallMinutes: number;
  /** Whether the latest version is saved on Cartesia; `error` says why not. */
  sync: { saved: boolean; syncedAt: string | null; error: string };
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: AiAgentStats;
};

/** GET /call-agents/:id — ai-agents.service.ts `get()` */
export type AiAgentDetail = AiAgent & {
  /** The exact prompt and opening line the voice model runs on ({{variables}} filled per call). */
  preview: { instructions: string; initialMessage: string };
  usage: { campaigns: { id: string; name: string; status: string }[]; sequences: { id: string; name: string }[] };
};
