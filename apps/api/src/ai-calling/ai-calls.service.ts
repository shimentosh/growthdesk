import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  AiCallAnalysis,
  AiCallingSettingsInput,
  aiCallBlocker,
  aiCallVariables,
  aiCallWindow,
  endReasonResult,
  isFinalCallStatus,
  isValidTimeZone,
  normalizePhone,
  readAiCallingSettings,
  type AiCallAnalysisT,
  type AiCallingSettingsT,
  type AiTestCallInput,
  type AiVoicesQuery,
  type CallOutcome,
  type CallStatus,
  type CartesiaConnectInput,
} from "@growthdesk/shared";
import type { CallAgent, ChannelIntegration, Prisma } from "../generated/prisma/client.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { EventsService } from "../core/events.service.js";
import { AuditService } from "../core/audit.service.js";
import { PlatformSettingsService } from "../core/platform-settings.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { ActivityService } from "../crm/activity.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { CallsService } from "../calls/calls.service.js";
import { advance } from "../calls/call-rules.js";
import { AiEngine } from "../ai/ai.engine.js";
import { newToken, openJson, safeEqual, sealJson } from "../common/crypto.js";
import { runAs } from "../common/actor.js";
import { ApiError, badRequest, conflict, notFound, unauthorized, unavailable } from "../common/errors.js";
import { actorId, me, ownershipScope, ws, type RequestContext } from "../common/context.js";
import type { AiCaller, AiStepCallInput, AiStepCallResult } from "./ai-caller.js";
import { agentCustomFieldKeys, agentQuestions, cartesiaConfig, webhookProblem } from "./ai-calling-rules.js";
import { analysisPrompt, heuristicAnalysis, parseAnalysis, personSpoke, toTurns } from "./call-analysis.js";
import { CartesiaError, cartesiaApi, type CartesiaCall } from "./cartesia.js";

/*
 * AI calling through Cartesia Managed Agents: the connection, keeping each
 * agent's copy on Cartesia in step with ours, placing calls (from a campaign
 * step, a person's "AI call" button, or a test call to their own phone),
 * and turning a finished call into CRM facts.
 *
 * The life of a call:
 *   1. place: every rule is checked immediately before Cartesia is asked to
 *      dial — consent recorded, not do-not-contact, not suppressed, inside the
 *      calling window in the person's own time zone, not AI-called too
 *      recently. The Call row is written first (write-ahead, its id chosen by
 *      the caller), so a retry never dials twice.
 *   2. Cartesia posts call events to /webhooks/cartesia/<key> (shared secret
 *      in X-Webhook-Secret). A completed or failed call's status, end reason,
 *      transcript and summary are stored, and a `result` job is queued. When
 *      Cartesia cannot reach us (local dev, no https), or an event is lost,
 *      the sweep fetches the call from Cartesia instead.
 *   3. result (once per call, processedAt): the end reason decides no answer /
 *      busy / voicemail; a conversation is judged from its transcript by the
 *      AI model (one AI credit) or, without one, by heuristics. Then, in one
 *      transaction: the outcome and analysis are stored; "do not call" puts
 *      the number on the do-not-contact list; a callback becomes a call task;
 *      an agreed meeting becomes a task to confirm it; the campaign
 *      enrollment stops when the person declined, opted out or booked; and
 *      the call settles (timeline + call.completed, which workflows can use).
 *
 * The Cartesia connection is a ChannelIntegration (channel "call", provider
 * "cartesia"), one per workspace: the API key and webhook secret sealed,
 * the chosen caller number and the calling settings in config. Verify and
 * disconnect go through the channels API like any other integration.
 */

type Secrets = { apiKey: string; webhookSecret: string };
type NumberRow = { id: string; number: string; label: string | null };
type Config = Partial<AiCallingSettingsT> & {
  phoneNumber?: string;
  numbers?: NumberRow[];
  webhookId?: string;
  webhookNote?: string;
};
type Conn = {
  row: ChannelIntegration;
  secrets: Secrets;
  config: Config;
  settings: AiCallingSettingsT;
};

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const HOUR_MS = 3_600_000;
/** How long after a call was placed the sweep starts asking Cartesia about it (the webhook usually comes first). */
const SWEEP_AFTER_MS = 3 * 60_000;
/** A call still not finished this long after it was placed is given up on. */
const GIVE_UP_MS = 24 * HOUR_MS;
const SWEEP_BATCH = 50;

/** Outcomes after which a campaign stops calling (and messaging) the person. */
const STOP_OUTCOMES: Partial<Record<CallOutcome, string>> = {
  meeting_booked: "Agreed a meeting on an AI call",
  not_interested: "Said they were not interested on an AI call",
  do_not_call: "Asked not to be called again",
  wrong_number: "Wrong number on an AI call",
};

const CONTACT_SELECT = {
  id: true,
  fullName: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  jobTitle: true,
  city: true,
  country: true,
  leadSource: true,
  customFields: true,
  timezone: true,
  consentStatus: true,
  doNotContact: true,
  deletedAt: true,
  archivedAt: true,
  ownerId: true,
  status: true,
  company: { select: { name: true } },
  owner: { select: { name: true } },
} satisfies Prisma.ContactSelect;
type ContactRow = Prisma.ContactGetPayload<{ select: typeof CONTACT_SELECT }>;

const nameOf = (c: { fullName?: string | null; email?: string | null; phone?: string | null } | null | undefined) => c?.fullName || c?.email || c?.phone || "";

/** Raised by dial(); the step path turns it into an AiStepCallResult, the HTTP paths into a 4xx/5xx. */
class DialRefused extends Error {
  constructor(
    readonly kind: "skipped" | "later" | "blocked" | "failed" | "unavailable",
    message: string,
    readonly at?: Date,
    readonly permanent = false,
  ) {
    super(message);
  }
}

@Injectable()
export class AiCallsService implements AiCaller {
  private readonly log = new Logger("ai-calling");

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: Queues,
    private readonly events: EventsService,
    private readonly audit: AuditService,
    private readonly platform: PlatformSettingsService,
    private readonly entitlements: EntitlementsService,
    private readonly activity: ActivityService,
    private readonly suppression: SuppressionService,
    private readonly notifications: NotificationsService,
    private readonly calls: CallsService,
    private readonly ai: AiEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ─── Connection ────────────────────────────────────────────────────────────

  webhookUrl(webhookKey: string) {
    return `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/api/webhooks/cartesia/${webhookKey}`;
  }

  /** Whether Cartesia can post to this deployment; a local fake (CARTESIA_API_URL, tests only) always can. */
  private webhookProblem(): string | null {
    if (process.env.CARTESIA_API_URL?.trim()) return null;
    return webhookProblem(this.config.PUBLIC_APP_URL);
  }

  private row(workspaceId: string) {
    return this.prisma.db.channelIntegration.findFirst({
      where: {
        workspaceId,
        channel: "call",
        provider: "cartesia",
        deletedAt: null,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  private open(row: ChannelIntegration): Conn | null {
    const secrets = openJson<Secrets>(row.secretSealed);
    if (!secrets?.apiKey) return null;
    const config = (row.config ?? {}) as Config;
    return { row, secrets, config, settings: readAiCallingSettings(config) };
  }

  /** The workspace's working connection, or why there is none (said to a person, so it names where to fix it). */
  async connection(workspaceId: string): Promise<{ conn: Conn; problem: null } | { conn: null; problem: string }> {
    const row = await this.row(workspaceId);
    if (!row)
      return {
        conn: null,
        problem: "AI calling is not connected. Connect Cartesia in Settings → Calling.",
      };
    if (row.status !== "connected")
      return {
        conn: null,
        problem: `The Cartesia connection is not working${row.lastError ? `: ${row.lastError}` : ""}. Verify it in Settings → Calling.`,
      };
    const conn = this.open(row);
    if (!conn)
      return {
        conn: null,
        problem: "The stored Cartesia API key could not be read — connect Cartesia again.",
      };
    if (!conn.settings.phoneNumberId)
      return {
        conn: null,
        problem: "Choose the phone number AI calls are placed from in Settings → Calling.",
      };
    return { conn, problem: null };
  }

  private dto(row: ChannelIntegration) {
    const config = (row.config ?? {}) as Config;
    const settings = readAiCallingSettings(config);
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      status: row.status,
      lastError: row.lastError,
      lastEventAt: row.lastEventAt,
      phoneNumberId: settings.phoneNumberId ?? null,
      phoneNumber: config.phoneNumber ?? "",
      numbers: config.numbers ?? [],
      webhook: {
        registered: Boolean(config.webhookId),
        note: config.webhookNote ?? "",
      },
      settings: {
        windowFrom: settings.windowFrom,
        windowTo: settings.windowTo,
        days: settings.days,
        minHoursBetweenCalls: settings.minHoursBetweenCalls,
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** What the AI calling screens need: the connection (never its secrets), whether calls can be placed, and why not. */
  async setup(ctx: RequestContext) {
    const w = ws(ctx);
    const [row, ent, aiProvider] = await Promise.all([this.row(w.id), this.entitlements.forAccount(w.billingAccountId), this.ai.provider("light")]);
    const state = await this.connection(w.id);
    const reason = !ent.features.calling ? `Calling is not included in the ${ent.effectivePlan.name} plan.` : state.problem;
    return {
      connection: row ? this.dto(row) : null,
      ready: !reason,
      reason,
      /** Whether finished calls are judged by an AI model (else by keyword heuristics). */
      aiAnalysis: Boolean(aiProvider) && ent.features.ai,
      webhookUrl: row ? this.webhookUrl(row.webhookKey) : null,
    };
  }

  async connect(ctx: RequestContext, input: z.infer<typeof CartesiaConnectInput>) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "calling");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Connecting Cartesia");
    const apiKey = input.apiKey.trim();
    let numbers: NumberRow[];
    try {
      numbers = (await cartesiaApi.phoneNumbers(apiKey)).map((n) => ({
        id: n.id,
        number: n.number,
        label: n.label,
      }));
    } catch (e) {
      throw badRequest(`Cartesia did not accept that API key: ${reasonOf(e)}`, {
        apiKey: "Cartesia did not accept this key",
      });
    }

    const held = await this.row(w.id);
    const before = held ? this.open(held) : null;
    const webhookKey = held?.webhookKey ?? newToken(24);
    const webhookSecret = newToken(32);
    const prior = (held?.config ?? {}) as Config;
    const keep = prior.phoneNumberId && numbers.some((n) => n.id === prior.phoneNumberId) ? prior.phoneNumberId : undefined;
    const chosen = numbers.find((n) => n.id === keep) ?? numbers[0];

    // Call events come back to us through a webhook registered on the account (one per connection).
    let webhookId: string | undefined;
    let webhookNote = "";
    // The secret changes with every connect, so the old webhook goes and a new one is registered.
    if (before?.config.webhookId) await cartesiaApi.deleteWebhook(before.secrets.apiKey, before.config.webhookId).catch(() => undefined);
    const problem = this.webhookProblem();
    if (problem) {
      webhookNote = `${problem} Call results are fetched from Cartesia every minute instead of arriving instantly.`;
    } else {
      try {
        webhookId = (
          await cartesiaApi.createWebhook(apiKey, {
            url: this.webhookUrl(webhookKey),
            secret: webhookSecret,
            display_name: `Growthdesk · ${w.name}`.slice(0, 80),
          })
        ).id;
      } catch (e) {
        webhookNote = `Cartesia did not register the webhook (${reasonOf(e)}). Call results are fetched every minute instead.`;
      }
    }

    const config: Config = {
      ...readAiCallingSettings(prior),
      phoneNumberId: chosen?.id,
      phoneNumber: chosen?.number ?? "",
      numbers,
      webhookId,
      webhookNote,
    };
    const name = input.name || "Cartesia";
    const secretSealed = sealJson({ apiKey, webhookSecret } satisfies Secrets);
    const status = chosen ? "connected" : "error";
    const lastError = chosen ? "" : "The Cartesia account has no phone number to call from. Buy or import one in Cartesia, then verify the connection.";
    let row: ChannelIntegration;
    if (held) {
      row = await this.prisma.db.channelIntegration.update({
        where: { id: held.id, workspaceId: w.id },
        data: {
          name,
          status,
          lastError,
          config: config as never,
          secretSealed,
        },
      });
    } else {
      await this.entitlements.assertCapacity(w.billingAccountId, "channelIntegrations");
      row = await this.prisma.db.channelIntegration.create({
        data: {
          workspaceId: w.id,
          channel: "call",
          provider: "cartesia",
          name,
          status,
          lastError,
          config: config as never,
          webhookKey,
          secretSealed,
          createdById: actorId(ctx),
        },
      });
    }
    // A new key may belong to another Cartesia account, and the webhook is new: every agent is pushed (and attached) again before its next call.
    await this.prisma.db.callAgent.updateMany({ where: { workspaceId: w.id }, data: { syncedAt: null } });
    const conn = this.open(row);
    if (conn) {
      const agents = await this.prisma.db.callAgent.findMany({ where: { workspaceId: w.id, archivedAt: null }, orderBy: { updatedAt: "desc" }, take: 50 });
      for (const agent of agents) await this.syncAgent(w.id, agent, conn);
    }
    await this.audit.record(ctx, {
      action: "integration.connected",
      targetType: "channel_integration",
      targetId: row.id,
      metadata: {
        provider: "cartesia",
        numbers: numbers.length,
        webhook: Boolean(webhookId),
      },
    });
    return this.dto(row);
  }

  /** The caller number and the calling window. */
  async updateSettings(ctx: RequestContext, input: Partial<AiCallingSettingsT>) {
    const w = ws(ctx);
    const row = await this.row(w.id);
    if (!row) throw notFound("The Cartesia connection");
    const config = (row.config ?? {}) as Config;
    const merged = AiCallingSettingsInput.safeParse({
      ...readAiCallingSettings(config),
      ...input,
    });
    if (!merged.success) {
      const fields = Object.fromEntries(merged.error.issues.map((i) => [i.path.join("."), i.message]));
      throw badRequest(merged.error.issues[0]?.message ?? "Invalid settings", fields);
    }
    const next: Config = { ...config, ...merged.data };
    if (input.phoneNumberId !== undefined) {
      const n = (config.numbers ?? []).find((x) => x.id === input.phoneNumberId);
      if (!n) throw badRequest("That number is not on the connected Cartesia account. Verify the connection to refresh the list.", { phoneNumberId: "Not on the account" });
      next.phoneNumber = n.number;
    }
    const fixed = row.status === "error" && next.phoneNumberId && /phone number/i.test(row.lastError);
    const updated = await this.prisma.db.channelIntegration.update({
      where: { id: row.id, workspaceId: w.id },
      data: {
        config: next as never,
        ...(fixed ? { status: "connected", lastError: "" } : {}),
      },
    });
    await this.audit.record(ctx, {
      action: "integration.updated",
      targetType: "channel_integration",
      targetId: row.id,
      metadata: { provider: "cartesia", ...merged.data },
    });
    return this.dto(updated);
  }

  async voices(ctx: RequestContext, q: z.infer<typeof AiVoicesQuery>) {
    const w = ws(ctx);
    const row = await this.row(w.id);
    const conn = row ? this.open(row) : null;
    if (!conn) throw conflict("Connect Cartesia in Settings → Calling to choose a voice.");
    try {
      return await cartesiaApi.voices(conn.secrets.apiKey, q);
    } catch (e) {
      throw unavailable(`Cartesia's voice list could not be loaded: ${reasonOf(e)}`);
    }
  }

  // ─── Agents on Cartesia ────────────────────────────────────────────────────

  /**
   * Pushes the agent's script, voice and tools to Cartesia (create, or update
   * — a new version there; calls in flight keep theirs) and turns on webhook
   * delivery for it. Records the result on the agent; returns the fresh row.
   */
  async syncAgent(workspaceId: string, agent: CallAgent, conn?: Conn | null): Promise<CallAgent> {
    const c = conn === undefined ? await this.anyConnection(workspaceId) : conn;
    if (!c) {
      return this.prisma.db.callAgent.update({
        where: { id: agent.id, workspaceId },
        data: {
          syncError: "Not saved to Cartesia yet: connect Cartesia in Settings → Calling.",
        },
      });
    }
    const body = {
      name: agent.name.slice(0, 64),
      description: `Growthdesk AI agent ${agent.id}`,
      config: cartesiaConfig(agent),
    };
    let providerAgentId = agent.integrationId === c.row.id ? agent.providerAgentId : null;
    let syncError = "";
    try {
      if (providerAgentId) {
        try {
          await cartesiaApi.updateAgent(c.secrets.apiKey, providerAgentId, body);
        } catch (e) {
          // Deleted on Cartesia's side (or another account's id): create it again.
          if (!(e instanceof CartesiaError) || e.status !== 404) throw e;
          providerAgentId = null;
        }
      }
      if (!providerAgentId) providerAgentId = (await cartesiaApi.createAgent(c.secrets.apiKey, body)).id;
      if (c.config.webhookId) {
        await cartesiaApi.attachWebhook(c.secrets.apiKey, providerAgentId, c.config.webhookId).catch((e) => {
          // Not fatal: the sweep fetches results without it.
          this.log.warn(`${workspaceId}: could not attach the webhook to agent ${providerAgentId}: ${reasonOf(e)}`);
        });
      }
    } catch (e) {
      syncError = `Cartesia did not save the agent: ${reasonOf(e)}`.slice(0, 500);
    }
    return this.prisma.db.callAgent.update({
      where: { id: agent.id, workspaceId },
      data: {
        integrationId: c.row.id,
        providerAgentId,
        syncError,
        ...(syncError ? {} : { syncedAt: new Date() }),
      },
    });
  }

  /** The connection to save agents to: connected or not, as long as its key can be read (agents can be prepared before a number is chosen). */
  private async anyConnection(workspaceId: string): Promise<Conn | null> {
    const row = await this.row(workspaceId);
    return row ? this.open(row) : null;
  }

  /** Best effort: the agent is archived on our side whatever Cartesia says. */
  async removeAgent(workspaceId: string, agent: CallAgent) {
    if (!agent.providerAgentId) return;
    const c = await this.anyConnection(workspaceId);
    if (!c || agent.integrationId !== c.row.id) return;
    await cartesiaApi.deleteAgent(c.secrets.apiKey, agent.providerAgentId).catch((e) => this.log.warn(`${workspaceId}: Cartesia deleteAgent ${agent.providerAgentId}: ${reasonOf(e)}`));
  }

  // ─── Placing calls ─────────────────────────────────────────────────────────

  /**
   * The checks and the dial, shared by every way a call starts. Throws
   * DialRefused for every expected "no"; returns the Call id once Cartesia
   * accepted it. `contact` is null only for a test call to a typed number.
   */
  private async dial(input: {
    workspaceId: string;
    agentId: string;
    contact: ContactRow | null;
    toNumber: string;
    variables: Record<string, string>;
    userId: string | null;
    campaignId?: string | null;
    enrollmentId?: string | null;
    callRowId: string;
    /** Test calls skip the consent and calling-window rules (the person vouched for the number); never the do-not-contact list. */
    test?: boolean;
  }): Promise<string> {
    const { workspaceId } = input;
    const db = this.prisma.db;
    const workspace = await db.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { billingAccountId: true, timezone: true },
    });
    const ent = await this.entitlements.forAccount(workspace.billingAccountId);
    if (ent.access !== "full") throw new DialRefused("later", ent.reason ?? "The account is restricted.", new Date(Date.now() + HOUR_MS));
    if (!ent.features.calling) throw new DialRefused("later", `Calling is not included in the ${ent.effectivePlan.name} plan. Upgrade to continue.`, new Date(Date.now() + 24 * HOUR_MS));
    if (!(await this.platform.get()).outreachEnabled) throw new DialRefused("later", "Outreach is paused on this installation.", new Date(Date.now() + 15 * 60_000));

    const state = await this.connection(workspaceId);
    if (!state.conn) throw new DialRefused("unavailable", state.problem, new Date(Date.now() + HOUR_MS));
    const conn = state.conn;

    let agent = await db.callAgent.findFirst({
      where: { id: input.agentId, workspaceId },
    });
    if (!agent) throw new DialRefused("failed", "The AI agent no longer exists.", undefined, true);
    if (agent.archivedAt) throw new DialRefused("failed", `The AI agent “${agent.name}” is archived.`, undefined, true);

    const to = normalizePhone(input.toNumber);
    if (!to) throw new DialRefused("skipped", "No phone number in international format.");
    if (input.contact) {
      const blocked = aiCallBlocker(input.contact);
      if (blocked) throw new DialRefused(input.contact.doNotContact ? "blocked" : "skipped", blocked);
    }
    // Compliance: the do-not-contact list, checked immediately before Cartesia is asked to dial.
    const suppressed = await this.suppression.check(workspaceId, { phone: to });
    if (suppressed) throw new DialRefused("blocked", suppressed);

    if (!input.test && input.contact) {
      const tz = input.contact.timezone && isValidTimeZone(input.contact.timezone) ? input.contact.timezone : workspace.timezone;
      const now = new Date();
      const window = aiCallWindow(conn.settings, tz, now);
      if (!window.open) throw new DialRefused("later", `Outside the calling hours in the person's time zone (${tz}).`, window.nextAt);
      const recent = await db.call.findFirst({
        where: {
          workspaceId,
          provider: "cartesia",
          contactId: input.contact.id,
          id: { not: input.callRowId },
          createdAt: {
            gt: new Date(now.getTime() - conn.settings.minHoursBetweenCalls * HOUR_MS),
          },
          status: { notIn: ["failed", "canceled"] },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (recent) {
        const at = new Date(recent.createdAt.getTime() + conn.settings.minHoursBetweenCalls * HOUR_MS);
        throw new DialRefused("later", `This person was AI-called less than ${conn.settings.minHoursBetweenCalls} hours ago.`, at);
      }
    }

    if (!agent.providerAgentId || agent.integrationId !== conn.row.id || !agent.syncedAt || agent.syncError) {
      agent = await this.syncAgent(workspaceId, agent, conn);
      if (agent.syncError || !agent.providerAgentId) throw new DialRefused("failed", agent.syncError || "The agent could not be saved to Cartesia.");
    }

    // Write-ahead: the row exists before Cartesia is called, under the caller's id.
    const existing = await db.call.findFirst({
      where: { id: input.callRowId, workspaceId },
    });
    if (existing?.providerCallId) return existing.id;
    if (existing && existing.status !== "failed") {
      throw new DialRefused("failed", "An earlier attempt at this call did not confirm whether Cartesia dialled; it is not dialled again.", undefined, true);
    }
    const now = new Date();
    const data = {
      workspaceId,
      contactId: input.contact?.id ?? null,
      userId: input.userId,
      integrationId: conn.row.id,
      agentId: agent.id,
      campaignId: input.campaignId ?? null,
      enrollmentId: input.enrollmentId ?? null,
      provider: "cartesia",
      direction: "outbound",
      fromNumber: conn.config.phoneNumber ?? "",
      toNumber: to,
      status: "queued" as const,
      startedAt: now,
      endedAt: null,
    };
    if (existing) await db.call.update({ where: { id: existing.id, workspaceId }, data });
    else await db.call.create({ data: { id: input.callRowId, ...data } });

    let result: { callId: string } | { error: string };
    try {
      result = await cartesiaApi.placeCall(conn.secrets.apiKey, {
        agentId: agent.providerAgentId!,
        fromNumberId: conn.settings.phoneNumberId!,
        to,
        variables: input.variables,
        maxMinutes: agent.maxCallMinutes,
      });
    } catch (e) {
      const err = e instanceof CartesiaError ? e : new CartesiaError(reasonOf(e), 0);
      if (err.status === 0) {
        // It may have reached Cartesia: the row stays queued with no provider id, and is never dialled again automatically.
        throw new DialRefused("failed", `${err.message}. Cartesia may have placed the call; it will not be placed again automatically.`, undefined, true);
      }
      await db.call.update({
        where: { id: input.callRowId, workspaceId },
        data: {
          status: "failed",
          endedAt: new Date(),
          endReason: "dial_failed",
          processedAt: new Date(),
        },
      });
      if (err.status === 401 || err.status === 403) {
        await db.channelIntegration.updateMany({
          where: { id: conn.row.id, workspaceId },
          data: { status: "error", lastError: err.message.slice(0, 500) },
        });
        throw new DialRefused("unavailable", `Cartesia refused the API key: ${err.message}`, new Date(Date.now() + HOUR_MS));
      }
      if (err.status === 429 || err.status >= 500) throw new DialRefused("later", `Cartesia is busy (${err.message}); trying again shortly.`, new Date(Date.now() + 10 * 60_000));
      throw new DialRefused("failed", `Cartesia refused the call: ${err.message}`);
    }
    if ("error" in result) {
      await db.call.update({
        where: { id: input.callRowId, workspaceId },
        data: {
          status: "failed",
          endedAt: new Date(),
          endReason: "dial_failed",
          processedAt: new Date(),
        },
      });
      const busy = /concurren/i.test(result.error);
      if (busy) throw new DialRefused("later", `Cartesia's concurrent call limit was reached; trying again shortly.`, new Date(Date.now() + 5 * 60_000));
      throw new DialRefused("failed", `Cartesia refused the call to ${to}: ${result.error}`);
    }
    const callId = result.callId;
    await db.$transaction(async (tx) => {
      await tx.call.updateMany({
        where: { id: input.callRowId, workspaceId, providerCallId: null },
        data: { providerCallId: callId },
      });
      if (input.contact) await this.calls.touchContact(tx, workspaceId, input.contact.id, now);
    });
    return input.callRowId;
  }

  /** AiCaller: the ai_call sequence step. */
  async callForStep(input: AiStepCallInput): Promise<AiStepCallResult> {
    const contact = await this.prisma.db.contact.findFirst({
      where: { id: input.contactId, workspaceId: input.workspaceId },
      select: CONTACT_SELECT,
    });
    if (!contact) return { status: "skipped", reason: "The contact no longer exists." };
    const agent = await this.prisma.db.callAgent.findFirst({
      where: { id: input.agentId, workspaceId: input.workspaceId },
    });
    try {
      const callId = await this.dial({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        contact,
        toNumber: contact.phone ?? "",
        variables: aiCallVariables(contact, agent ? agentCustomFieldKeys(agent) : []),
        userId: null,
        campaignId: input.campaignId,
        enrollmentId: input.enrollmentId,
        callRowId: input.callRowId,
      });
      return { status: "placed", callId };
    } catch (e) {
      if (!(e instanceof DialRefused)) throw e;
      switch (e.kind) {
        case "skipped":
          return { status: "skipped", reason: e.message };
        case "blocked":
          return { status: "blocked", reason: e.message };
        case "later":
        case "unavailable":
          return {
            status: "later",
            at: e.at ?? new Date(Date.now() + HOUR_MS),
            reason: e.message,
          };
        case "failed": {
          const row = await this.prisma.db.call.findFirst({
            where: { id: input.callRowId, workspaceId: input.workspaceId },
            select: { status: true, providerCallId: true },
          });
          if (row && !row.providerCallId && row.status === "queued")
            return {
              status: "uncertain",
              reason: e.message,
              callId: input.callRowId,
            };
          return {
            status: "failed",
            reason: e.message,
            permanent: e.permanent,
          };
        }
      }
    }
  }

  /** AiCaller: what became of a step's call after a crash. */
  async stepCallState(workspaceId: string, callRowId: string): Promise<"none" | "placed" | "failed" | "unknown"> {
    const row = await this.prisma.db.call.findFirst({
      where: { id: callRowId, workspaceId },
      select: { status: true, providerCallId: true },
    });
    if (!row) return "none";
    if (row.providerCallId) return "placed";
    if (row.status === "failed") return "failed";
    return "unknown";
  }

  private refusal(e: unknown): never {
    if (!(e instanceof DialRefused)) throw e;
    if (e.kind === "later" && e.at) throw conflict(`${e.message} The next possible time is ${e.at.toISOString()}.`, undefined, { nextAt: e.at.toISOString() });
    if (e.kind === "unavailable") throw conflict(e.message);
    if (e.kind === "failed") throw new ApiError(400, "bad_request", e.message);
    throw conflict(e.message);
  }

  /** A person's "AI call now" for one contact: every rule a campaign step applies. */
  async callContact(ctx: RequestContext, agentId: string, contactId: string) {
    const w = ws(ctx);
    const contact = await this.prisma.db.contact.findFirst({
      where: {
        id: contactId,
        workspaceId: w.id,
        deletedAt: null,
        ...ownershipScope(ctx),
      },
      select: CONTACT_SELECT,
    });
    if (!contact) throw notFound("That contact");
    const agent = await this.prisma.db.callAgent.findFirst({
      where: { id: agentId, workspaceId: w.id },
    });
    if (!agent) throw notFound("That AI agent");
    let id: string;
    try {
      id = await this.dial({
        workspaceId: w.id,
        agentId,
        contact,
        toNumber: contact.phone ?? "",
        variables: aiCallVariables(contact, agentCustomFieldKeys(agent)),
        userId: me(ctx).userId,
        callRowId: randomUUID(),
      });
    } catch (e) {
      this.refusal(e);
    }
    await this.audit.record(ctx, {
      action: "call.ai_placed",
      targetType: "call",
      targetId: id,
      metadata: { agentId, contactId },
    });
    return this.calls.get(ctx, id);
  }

  /** The agent rings a number the person vouched for (their own phone), with sample values for the script's variables. */
  async testCall(ctx: RequestContext, agentId: string, input: z.infer<typeof AiTestCallInput>) {
    const w = ws(ctx);
    const agent = await this.prisma.db.callAgent.findFirst({
      where: { id: agentId, workspaceId: w.id },
    });
    if (!agent) throw notFound("That AI agent");
    const sample = aiCallVariables({ firstName: "", customFields: {} }, agentCustomFieldKeys(agent));
    for (const [k, v] of Object.entries(input.variables ?? {})) if (k in sample && v.trim()) sample[k] = v.trim();
    let id: string;
    try {
      id = await this.dial({
        workspaceId: w.id,
        agentId,
        contact: null,
        toNumber: input.toNumber,
        variables: sample,
        userId: me(ctx).userId,
        callRowId: randomUUID(),
        test: true,
      });
    } catch (e) {
      this.refusal(e);
    }
    await this.audit.record(ctx, {
      action: "call.ai_test",
      targetType: "call",
      targetId: id,
      metadata: { agentId, to: normalizePhone(input.toNumber) },
    });
    return this.calls.get(ctx, id);
  }

  // ─── Results ───────────────────────────────────────────────────────────────

  /**
   * POST /webhooks/cartesia/:key. Authenticated by the shared secret in
   * X-Webhook-Secret; routed by the connection's random key. Events for calls
   * we did not place (Playground tests, another app on the account) are
   * acknowledged and ignored. Never throws for a well-formed event, so
   * Cartesia does not retry what was already stored.
   */
  async webhook(webhookKey: string, secret: string | undefined, body: unknown): Promise<{ ok: true; applied: boolean }> {
    if (!webhookKey || webhookKey.length > 100) throw notFound("That webhook");
    // Unscoped by necessity: Cartesia's request carries no session; the unguessable key in its URL names the connection (and so the workspace).
    const row = await this.prisma.unscoped.channelIntegration.findUnique({
      where: { webhookKey },
    });
    if (!row || row.provider !== "cartesia" || row.deletedAt) throw notFound("That webhook");
    const held = openJson<Secrets>(row.secretSealed)?.webhookSecret ?? "";
    if (!held || !secret || !safeEqual(secret, held)) {
      this.log.warn(`${row.workspaceId}: a Cartesia webhook failed its secret check`);
      throw unauthorized("Invalid webhook secret");
    }
    const workspaceId = row.workspaceId;
    await this.prisma.db.channelIntegration.updateMany({
      where: { id: row.id, workspaceId },
      data: { lastEventAt: new Date() },
    });

    const ev = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const type = typeof ev.type === "string" ? ev.type : "";
    const callObj = (ev.call && typeof ev.call === "object" ? ev.call : null) as CartesiaCall | null;
    const providerCallId = String(callObj?.id ?? ev.call_id ?? "");
    if (!providerCallId) return { ok: true, applied: false };
    const call = await this.prisma.db.call.findFirst({
      where: { workspaceId, provider: "cartesia", providerCallId },
    });
    if (!call) return { ok: true, applied: false };

    switch (type) {
      case "call_started":
        return {
          ok: true,
          applied: await this.markStarted(workspaceId, call.id),
        };
      case "call_completed":
      case "call_failed": {
        const c: CartesiaCall = {
          ...(callObj ?? { id: providerCallId }),
          status: callObj?.status ?? (type === "call_failed" ? "failed" : "completed"),
        };
        if (!c.end_reason && typeof ev.end_reason === "string") c.end_reason = ev.end_reason;
        return {
          ok: true,
          applied: await this.ingest(workspaceId, call.id, c),
        };
      }
      case "post_call_analysis": {
        const summary = typeof (ev.analysis as { summary?: unknown } | undefined)?.summary === "string" ? String((ev.analysis as { summary: string }).summary).slice(0, 2000) : "";
        if (!summary) return { ok: true, applied: false };
        const res = await this.prisma.db.call.updateMany({
          where: { id: call.id, workspaceId, summary: "" },
          data: { summary },
        });
        return { ok: true, applied: res.count > 0 };
      }
      default:
        return { ok: true, applied: false };
    }
  }

  private async markStarted(workspaceId: string, callId: string): Promise<boolean> {
    return this.prisma.db.$transaction(async (tx) => {
      const row = await this.calls.lock(tx, workspaceId, callId);
      const next = advance(row.status, "in_progress");
      if (!next) return false;
      await tx.call.update({
        where: { id: callId, workspaceId },
        data: { status: next },
      });
      return true;
    });
  }

  /**
   * Stores what Cartesia reports about an ended call (status, end reason,
   * transcript, summary, times) and queues the result job. A call that has
   * not ended only moves forward (in progress). Idempotent.
   */
  async ingest(workspaceId: string, callId: string, c: CartesiaCall): Promise<boolean> {
    const ended = c.status === "completed" || c.status === "failed";
    if (!ended) return c.status === "started" ? this.markStarted(workspaceId, callId) : false;
    const turns = toTurns(c.transcript);
    const base = endReasonResult(c.end_reason, c.status === "failed", personSpoke(turns));
    const startedAt = c.start_time ? new Date(c.start_time) : null;
    const endedAt = c.end_time ? new Date(c.end_time) : new Date();
    const durationSec = startedAt && !Number.isNaN(startedAt.getTime()) && !Number.isNaN(endedAt.getTime()) ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : null;
    const stored = await this.prisma.db.$transaction(async (tx) => {
      const row = await this.calls.lock(tx, workspaceId, callId);
      if (row.processedAt || (isFinalCallStatus(row.status) && row.endReason)) return false;
      await tx.call.update({
        where: { id: callId, workspaceId },
        data: {
          status: base.status,
          endReason: (c.end_reason ?? (c.status === "failed" ? "error" : "")).slice(0, 60),
          transcript: turns as never,
          summary: (c.summary ?? row.summary ?? "").slice(0, 2000),
          ...(startedAt && !Number.isNaN(startedAt.getTime()) ? { startedAt } : {}),
          endedAt,
          durationSec,
          ...(c.error_message
            ? {
                notes: row.notes || `Cartesia: ${c.error_message}`.slice(0, 1000),
              }
            : {}),
        },
      });
      return true;
    });
    if (stored) await this.queueResult(workspaceId, callId);
    return stored;
  }

  async queueResult(workspaceId: string, callId: string) {
    await this.queues.add(QUEUES.calls, "result", { workspaceId, callId }, { jobId: `ai-call-result-${callId}`, attempts: 4 });
  }

  /** The judgement on a finished call: the end reason's when it decides, else the AI model's (or heuristics'). */
  private async judge(
    call: {
      transcript: unknown;
      summary: string;
      endReason: string;
      status: CallStatus;
    },
    ctx: {
      workspaceId: string;
      billingAccountId: string;
      agent: CallAgent | null;
      timeZone: string;
      contactName: string;
    },
  ): Promise<AiCallAnalysisT | null> {
    const turns = toTurns(call.transcript);
    const base = endReasonResult(call.endReason, call.status === "failed", personSpoke(turns));
    if (base.outcome)
      return AiCallAnalysis.parse({
        outcome: base.outcome,
        summary: call.summary.slice(0, 1000),
        method: "heuristic",
      });
    if (!personSpoke(turns)) return null;
    try {
      const cfg = await this.ai.provider("light");
      if (!cfg) return heuristicAnalysis(turns, call.summary);
      const res = await this.ai.run({
        workspaceId: ctx.workspaceId,
        billingAccountId: ctx.billingAccountId,
        userId: null,
        feature: "call_analysis",
        tier: "light",
        request: analysisPrompt({
          turns,
          questions: ctx.agent ? agentQuestions(ctx.agent) : [],
          goal: ctx.agent?.goal ?? "book_meeting",
          now: new Date(),
          timeZone: ctx.timeZone,
          contactName: ctx.contactName,
        }),
        parse: parseAnalysis,
        cacheTtlMs: 30 * 24 * HOUR_MS,
      });
      return res.output;
    } catch (e) {
      // No AI in the plan, credits used up, provider down: the words still say enough to act on.
      this.log.warn(`${ctx.workspaceId}: call analysis fell back to heuristics: ${reasonOf(e)}`);
      return heuristicAnalysis(turns, call.summary);
    }
  }

  /**
   * Applies a finished AI call's result, once (processedAt). See the life of
   * a call at the top of this file. Returns false when there was nothing to do.
   */
  async finish(workspaceId: string, callId: string): Promise<boolean> {
    const db = this.prisma.db;
    const call = await db.call.findFirst({
      where: { id: callId, workspaceId, provider: "cartesia" },
    });
    if (!call || call.processedAt || !isFinalCallStatus(call.status)) return false;
    const [workspace, contact, agent, campaign] = await Promise.all([
      db.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { billingAccountId: true, timezone: true },
      }),
      call.contactId
        ? db.contact.findFirst({
            where: { id: call.contactId, workspaceId },
            select: CONTACT_SELECT,
          })
        : Promise.resolve(null),
      call.agentId ? db.callAgent.findFirst({ where: { id: call.agentId, workspaceId } }) : Promise.resolve(null),
      call.campaignId
        ? db.campaign.findFirst({
            where: { id: call.campaignId, workspaceId },
            select: { id: true, name: true, ownerId: true, createdById: true },
          })
        : Promise.resolve(null),
    ]);
    const timeZone = contact?.timezone && isValidTimeZone(contact.timezone) ? contact.timezone : workspace.timezone;
    const analysis = await this.judge(call, {
      workspaceId,
      billingAccountId: workspace.billingAccountId,
      agent,
      timeZone,
      contactName: nameOf(contact),
    });
    const owner = contact?.ownerId ?? campaign?.ownerId ?? campaign?.createdById ?? call.userId ?? null;
    const who = nameOf(contact) || call.toNumber;
    const now = new Date();

    // Timeline entries and tasks written here are the voice agent's work, done for the contact's owner.
    const actor = {
      type: "ai_agent" as const,
      id: agent?.id ?? null,
      name: agent ? `AI agent · ${agent.name}` : "AI agent",
      ref: `call:${callId}`,
      onBehalfOf: owner ? { id: owner } : null,
    };
    const done = await runAs(actor, () =>
      db.$transaction(async (tx) => {
        const row = await this.calls.lock(tx, workspaceId, callId);
        if (row.processedAt) return null;
        if (!analysis) {
          // Never connected (an error, or canceled): no outcome to record, nothing to follow up.
          await tx.call.update({
            where: { id: callId, workspaceId },
            data: { processedAt: now },
          });
          if (row.contactId) {
            await this.activity.log(
              {
                workspaceId,
                contactId: row.contactId,
                type: "call.failed",
                summary: `AI call to ${who} did not go through${row.endReason ? ` (${row.endReason.replace(/_/g, " ")})` : ""}`,
                data: { callId },
              },
              tx,
            );
          }
          return { outcome: null as CallOutcome | null };
        }
        const callbackAt = analysis.callbackAt && analysis.callbackAt > now ? analysis.callbackAt : null;
        const updated = await tx.call.update({
          where: { id: callId, workspaceId },
          data: {
            outcome: row.outcome || analysis.outcome,
            analysis: {
              ...analysis,
              callbackAt: analysis.callbackAt?.toISOString() ?? null,
            } as never,
            summary: row.summary || analysis.summary,
            callbackAt: row.callbackAt ?? callbackAt,
            processedAt: now,
          },
        });
        // The callback task and the do-not-call opt-out, exactly as for a call a person logged; owned by the contact's owner.
        await this.calls.applyOutcome(tx, workspaceId, null, { ...updated, userId: owner }, { outcome: "", callbackAt: null }, false);
        const outcome = updated.outcome as CallOutcome;

        if (outcome === "meeting_booked" && row.contactId) {
          const task = await tx.task.create({
            data: {
              workspaceId,
              type: "meeting",
              title: `Confirm the meeting ${who} agreed to on an AI call`.slice(0, 300),
              description: [analysis.meetingTime && `Agreed time: ${analysis.meetingTime}`, analysis.summary, analysis.nextStep].filter(Boolean).join("\n\n").slice(0, 5000),
              priority: "high",
              dueAt: new Date(now.getTime() + HOUR_MS),
              assigneeId: owner,
              contactId: row.contactId,
              campaignId: row.campaignId,
              enrollmentId: row.enrollmentId,
              source: "ai_call",
            },
          });
          await this.activity.log(
            {
              workspaceId,
              contactId: row.contactId,
              type: "task.created",
              summary: `Task: ${task.title}`,
              data: { taskId: task.id, callId },
            },
            tx,
          );
        } else if (outcome === "connected" && analysis.interest === "hot" && row.contactId) {
          await tx.task.create({
            data: {
              workspaceId,
              type: "follow_up",
              title: `Follow up: ${who} sounded keen on an AI call`.slice(0, 300),
              description: [analysis.summary, analysis.nextStep].filter(Boolean).join("\n\n").slice(0, 5000),
              priority: "high",
              dueAt: new Date(now.getTime() + 4 * HOUR_MS),
              assigneeId: owner,
              contactId: row.contactId,
              campaignId: row.campaignId,
              enrollmentId: row.enrollmentId,
              source: "ai_call",
            },
          });
        }
        if (row.contactId) {
          if (outcome === "meeting_booked" || analysis.interest === "hot") {
            await tx.contact.updateMany({
              where: {
                id: row.contactId,
                workspaceId,
                status: { in: ["new", "contacted", "replied"] },
              },
              data: { status: "interested" },
            });
          } else if (outcome === "not_interested") {
            await tx.contact.updateMany({
              where: {
                id: row.contactId,
                workspaceId,
                status: { in: ["new", "contacted"] },
              },
              data: { status: "not_interested" },
            });
          }
        }
        const stop = STOP_OUTCOMES[outcome];
        if (stop && row.enrollmentId) {
          await tx.enrollment.updateMany({
            where: { id: row.enrollmentId, workspaceId, status: "active" },
            data: {
              status: "stopped",
              stopReason: stop,
              nextRunAt: null,
              lockedUntil: null,
              stepRun: { increment: 1 },
            },
          });
        }
        await this.calls.settle(tx, workspaceId, callId);
        return { outcome };
      }),
    );
    if (!done) return false;
    await this.events.kick();
    if (owner && (done.outcome === "meeting_booked" || (done.outcome === "connected" && analysis?.interest === "hot"))) {
      await this.notifications.notify(workspaceId, [owner], {
        type: "call.ai_result",
        title: done.outcome === "meeting_booked" ? `AI call: ${who} agreed to a meeting` : `AI call: ${who} sounded keen`,
        body: [analysis?.meetingTime && `Agreed time: ${analysis.meetingTime}`, analysis?.summary].filter(Boolean).join(" · ").slice(0, 500),
        link: `/w/${workspaceId}/calls?call=${callId}`,
      });
    }
    return true;
  }

  /**
   * Every minute (worker): asks Cartesia about AI calls that have been out a
   * while without a result — when the webhook cannot reach us, or an event
   * was lost — and gives up on calls that never finish. Cross-tenant by
   * design (a scheduler finding due work); each call is handled in its own
   * workspace's scope.
   */
  async sweep(now = new Date()): Promise<{ checked: number; finished: number; queued: number }> {
    const rows = await this.prisma.unscoped.call.findMany({
      where: {
        provider: "cartesia",
        processedAt: null,
        createdAt: {
          lt: new Date(now.getTime() - SWEEP_AFTER_MS),
          gt: new Date(now.getTime() - 3 * GIVE_UP_MS),
        },
      },
      orderBy: { updatedAt: "asc" },
      take: SWEEP_BATCH,
      select: {
        id: true,
        workspaceId: true,
        status: true,
        providerCallId: true,
        createdAt: true,
        integrationId: true,
      },
    });
    let finished = 0;
    let queued = 0;
    const conns = new Map<string, Conn | null>();
    for (const r of rows) {
      try {
        if (isFinalCallStatus(r.status)) {
          // Ended but the result job was lost: queue it again.
          await this.queueResult(r.workspaceId, r.id);
          queued += 1;
          continue;
        }
        const old = now.getTime() - r.createdAt.getTime() > GIVE_UP_MS;
        if (!r.providerCallId) {
          // Never confirmed by Cartesia: after a while it is recorded as failed (nothing to fetch).
          if (now.getTime() - r.createdAt.getTime() > 15 * 60_000) {
            await this.prisma.db.call.updateMany({
              where: {
                id: r.id,
                workspaceId: r.workspaceId,
                providerCallId: null,
                processedAt: null,
              },
              data: {
                status: "failed",
                endedAt: now,
                endReason: "unconfirmed",
                processedAt: now,
              },
            });
            finished += 1;
          }
          continue;
        }
        if (!conns.has(r.workspaceId)) conns.set(r.workspaceId, await this.anyConnection(r.workspaceId));
        const conn = conns.get(r.workspaceId);
        if (!conn) continue;
        const c = await cartesiaApi.getCall(conn.secrets.apiKey, r.providerCallId);
        if (c.status === "completed" || c.status === "failed") {
          if (await this.ingest(r.workspaceId, r.id, c)) finished += 1;
        } else if (old) {
          await this.ingest(r.workspaceId, r.id, {
            ...c,
            status: "failed",
            end_reason: c.end_reason ?? "error",
            error_message: "No result came back from Cartesia within a day.",
          });
          finished += 1;
        } else {
          await this.prisma.db.call.updateMany({
            where: { id: r.id, workspaceId: r.workspaceId },
            data: { updatedAt: now },
          });
          if (c.status === "started") await this.markStarted(r.workspaceId, r.id);
        }
      } catch (e) {
        this.log.warn(`${r.workspaceId}: could not sweep AI call ${r.id}: ${reasonOf(e)}`);
        await this.prisma.db.call
          .updateMany({
            where: { id: r.id, workspaceId: r.workspaceId },
            data: { updatedAt: now },
          })
          .catch(() => undefined);
      }
    }
    return { checked: rows.length, finished, queued };
  }
}
