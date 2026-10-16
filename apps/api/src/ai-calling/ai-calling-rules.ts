import { agentCustomKeys, composeInitialMessage, composeInstructions, normalizePhone, toProviderText, type AgentScript, type AiAgentObjection } from "@growthdesk/shared";
import type { z } from "zod";
import type { CallAgent } from "../generated/prisma/client.js";
import type { CartesiaAgentConfig } from "./cartesia.js";

/*
 * Pure rules of AI calling kept free of the database (ai-calling-rules.spec.ts):
 * an agent row as the script the prompt is built from, and as the config
 * Cartesia stores; and whether Cartesia can reach our webhook.
 */

type Objection = z.infer<typeof AiAgentObjection>;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const objections = (v: unknown): Objection[] =>
  Array.isArray(v)
    ? v
        .filter((o): o is Objection => Boolean(o) && typeof o === "object" && typeof (o as Objection).objection === "string" && typeof (o as Objection).response === "string")
        .map((o) => ({ objection: o.objection, response: o.response }))
    : [];

/** The stored agent as the script composeInstructions reads. */
export function scriptOf(a: CallAgent): AgentScript {
  return {
    goal: (a.goal as AgentScript["goal"]) ?? "book_meeting",
    personaName: a.personaName,
    businessName: a.businessName,
    greeting: a.greeting,
    disclosure: a.disclosure,
    about: a.about,
    goalDetails: a.goalDetails,
    questions: strings(a.questions),
    objections: objections(a.objections),
    voicemailMessage: a.voicemailMessage,
    extraInstructions: a.extraInstructions,
    transferNumber: a.transferNumber,
    maxCallMinutes: a.maxCallMinutes,
  };
}

export const agentQuestions = (a: CallAgent) => strings(a.questions);
export const agentObjections = (a: CallAgent) => objections(a.objections);

/** Every piece of an agent's text that may hold {{variables}}. */
export function agentTexts(a: AgentScript): string[] {
  return [a.greeting, a.disclosure, a.about, a.goalDetails, a.voicemailMessage, a.extraInstructions, ...a.questions, ...a.objections.flatMap((o) => [o.objection, o.response])];
}

/** The custom fields a stored agent's script reads (sent with every call). */
export const agentCustomFieldKeys = (a: CallAgent) => agentCustomKeys(agentTexts(scriptOf(a)));

/** The prompt and opening line, with {{agent_name}} / {{business_name}} filled and other tokens as provider variables. */
export function providerTexts(a: CallAgent): {
  instructions: string;
  initialMessage: string;
} {
  const script = scriptOf(a);
  const statics = { agent_name: a.personaName, business_name: a.businessName };
  return {
    instructions: toProviderText(composeInstructions(script), statics),
    initialMessage: toProviderText(composeInitialMessage(script), statics),
  };
}

/** The managed-agent config Cartesia stores for this agent. */
export function cartesiaConfig(a: CallAgent): CartesiaAgentConfig {
  const { instructions, initialMessage } = providerTexts(a);
  const transfer = normalizePhone(a.transferNumber);
  // Sample values for Cartesia's Playground (never used on real calls).
  const placeholders: Record<string, string> = {
    first_name: "Jordan",
    last_name: "Lee",
    full_name: "Jordan Lee",
    company: "Acme Inc",
    job_title: "Head of Operations",
    city: "Austin",
    country: "United States",
    owner_name: "Sam",
    lead_source: "Website",
  };
  for (const key of agentCustomFieldKeys(a)) placeholders[`custom__${key.toLowerCase()}`] = "";
  return {
    instructions,
    initial_message: initialMessage,
    language: { primary: a.language || "en" },
    audio: { output: { voice_id: a.voiceId } },
    dynamic_variable_placeholders: placeholders,
    system_tools: {
      end_call: { description: null, pre_tool_speech: "force" },
      transfer_to_number: transfer
        ? {
            description: null,
            pre_tool_speech: "auto",
            transfers: [
              {
                destination: { type: "phone", phone_number: transfer },
                condition: "The person asks to speak to a human now, or needs details you cannot give and agrees to be transferred.",
              },
            ],
          }
        : null,
    },
  };
}

/**
 * Why Cartesia cannot deliver call events to this deployment, or null. Its
 * webhooks need a public https URL; without one, results are fetched by the
 * sweep instead (a minute or two later).
 */
export function webhookProblem(publicAppUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(publicAppUrl);
  } catch {
    return "PUBLIC_APP_URL is not a valid URL.";
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host === "[::1]" || /^127\./.test(host) || host === "0.0.0.0";
  if (local) return `PUBLIC_APP_URL (${publicAppUrl}) is only reachable from this machine.`;
  if (url.protocol !== "https:") return `Cartesia only posts to https addresses; PUBLIC_APP_URL is ${publicAppUrl}.`;
  return null;
}
