/*
 * Response shapes for the AI assistant (apps/api/src/ai/ai.service.ts); keep
 * them in step.
 */

/** GET /ai/status — whether AI controls should show, and why not. */
export type AiStatus = {
  available: boolean;
  reason: string | null;
  configured: boolean;
  provider: "anthropic" | "openai" | null;
  model: string | null;
  planIncludesAi: boolean;
  plan: string;
  permitted: boolean;
  credits: { used: number; limit: number };
  autoClassify: boolean;
};

export type AiReplyDraft = { body: string; cached: boolean; model: string };

export type AiMessageDraft = { subject: string; body: string; cached: boolean; model: string };

export type AiWritten = {
  subject: string;
  body: string;
  unknownVariables: string[];
  droppedVariables: string[];
  cached: boolean;
  model: string;
};

export type AiSummary = { summary: string; nextSteps: string[] };

export type AiSummaryResult = { summary: AiSummary | null; cached: boolean; model: string | null };
