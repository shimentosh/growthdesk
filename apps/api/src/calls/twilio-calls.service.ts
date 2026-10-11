import { Inject, Injectable, Logger } from "@nestjs/common";
import { isFinalCallStatus, normalizePhone, type ClickToCallInputT, type TwilioConnectInput } from "@growthdesk/shared";
import type { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { EventsService } from "../core/events.service.js";
import { AuditService } from "../core/audit.service.js";
import { EntitlementsService } from "../billing/entitlements.service.js";
import { SuppressionService } from "../crm/suppression.service.js";
import { ChannelsService } from "../channels/channels.service.js";
import type { ChannelIntegration } from "../generated/prisma/client.js";
import { newToken, openJson, sealJson } from "../common/crypto.js";
import { ApiError, badRequest, conflict, notFound, unauthorized, unavailable } from "../common/errors.js";
import { holds, me, ws, type RequestContext } from "../common/context.js";
import { TWILIO_STATUS, TwilioError, twilioApi, twilioSignatureOk } from "./twilio.js";
import { advance, dialResult, dialTwiml, EMPTY_TWIML, isUuid, outcomeFromStatus, parentEnded, refusalTwiml, webhookReachability } from "./call-rules.js";
import { CallsService } from "./calls.service.js";

/*
 * Click-to-call over Twilio (see twilio.ts for the flow and the compliance
 * notes this file follows). The Twilio account is a ChannelIntegration
 * (channel "call", provider "twilio"): the auth token is sealed in
 * secretSealed, the account SID / caller ID / account name sit in config, and
 * verify / disconnect go through the channels API like any other integration.
 *
 * Twilio reaches us at three per-integration URLs, all through the web app's
 * /api proxy and each carrying the call's id:
 *   ${PUBLIC_APP_URL}/api/webhooks/twilio/<webhookKey>/twiml?call=<id>   our TwiML when the rep answers
 *   ${PUBLIC_APP_URL}/api/webhooks/twilio/<webhookKey>/dial?call=<id>    the contact's leg ended (<Dial action>)
 *   ${PUBLIC_APP_URL}/api/webhooks/twilio/<webhookKey>/status?call=<id>  the rep's leg moved (StatusCallback)
 * Every request is checked against X-Twilio-Signature (HMAC-SHA1 with the
 * account's auth token over that exact URL and the POST parameters) before
 * anything is read or written.
 */

type TwilioSecrets = { authToken: string };
type TwilioConfig = { accountSid?: string; callerId?: string; friendlyName?: string };
type Hook = "twiml" | "dial" | "status";
type Params = Record<string, unknown>;

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";
const str = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "");

@Injectable()
export class TwilioCallsService {
  private readonly log = new Logger("calls");

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly suppression: SuppressionService,
    private readonly channels: ChannelsService,
    private readonly calls: CallsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  hookUrl(webhookKey: string, hook: Hook, callId: string) {
    return `${this.config.PUBLIC_APP_URL.replace(/\/+$/, "")}/api/webhooks/twilio/${webhookKey}/${hook}?call=${encodeURIComponent(callId)}`;
  }

  /** Why click-to-call cannot work on this deployment at all, or null. */
  private reachability() {
    return webhookReachability(this.config.PUBLIC_APP_URL, Boolean(process.env.TWILIO_API_URL?.trim()));
  }

  /** What the calling screens need to decide between "Call" and "Log a call": connected Twilio accounts and whether dialling can work here. */
  async setup(ctx: RequestContext) {
    const w = ws(ctx);
    const rows = await this.prisma.db.channelIntegration.findMany({
      where: { workspaceId: w.id, channel: "call", provider: "twilio", deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    const twilio = rows.map((r) => ({ id: r.id, name: r.name, status: r.status, lastError: r.lastError, callerId: ((r.config ?? {}) as TwilioConfig).callerId ?? "" }));
    const reach = this.reachability();
    const connected = twilio.filter((t) => t.status === "connected");
    const reason = reach ?? (connected.length ? null : twilio.length ? "The Twilio connection is not working — verify it in Settings → Calling." : "Twilio is not connected in this workspace.");
    return { twilio, clickToCall: { available: !reason, reason } };
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  async connect(ctx: RequestContext, input: z.infer<typeof TwilioConnectInput>) {
    const w = ws(ctx);
    await this.entitlements.assertFeature(w.billingAccountId, "calling");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Connecting Twilio");
    const callerId = normalizePhone(input.callerId);
    if (!callerId) throw badRequest("Enter the caller ID in international format, e.g. +14155550100", { callerId: "Use international format, e.g. +14155550100" });
    const accountSid = input.accountSid.trim();
    let acct: { friendlyName: string; status: string };
    try {
      acct = await twilioApi.account(accountSid, input.authToken.trim());
    } catch (e) {
      throw badRequest(`Twilio did not accept those details: ${reasonOf(e)}`);
    }
    if (acct.status && acct.status !== "active") throw badRequest(`That Twilio account is ${acct.status}; only active accounts can place calls.`);

    // Unscoped by necessity: (provider, externalId) is unique across all workspaces, so one Twilio account belongs to one workspace.
    const held = await this.prisma.unscoped.channelIntegration.findUnique({ where: { provider_externalId: { provider: "twilio", externalId: accountSid } } });
    if (held && held.workspaceId !== w.id) throw conflict("This Twilio account is already connected to another workspace. Disconnect it there first.");
    const config: TwilioConfig = { accountSid, callerId, friendlyName: acct.friendlyName };
    const name = input.name || acct.friendlyName || "Twilio";
    const secretSealed = sealJson({ authToken: input.authToken.trim() } satisfies TwilioSecrets);
    let row: ChannelIntegration;
    if (held) {
      // Reconnecting the same account: new token / caller ID, same webhook key (calls in flight keep working).
      row = await this.prisma.db.channelIntegration.update({ where: { id: held.id, workspaceId: w.id }, data: { name, status: "connected", lastError: "", config, secretSealed } });
    } else {
      await this.entitlements.assertCapacity(w.billingAccountId, "channelIntegrations");
      try {
        row = await this.prisma.db.channelIntegration.create({
          data: {
            workspaceId: w.id,
            channel: "call",
            provider: "twilio",
            name,
            status: "connected",
            config,
            externalId: accountSid,
            webhookKey: newToken(24),
            secretSealed,
            createdById: ctx.identity?.userId ?? null,
          },
        });
      } catch (e) {
        if (isUnique(e)) throw conflict("This Twilio account is already connected to a workspace.");
        throw e;
      }
    }
    await this.audit.record(ctx, { action: "integration.connected", targetType: "channel_integration", targetId: row.id, metadata: { provider: "twilio", accountSid, callerId } });
    return this.channels.dto(row, holds(ctx, "integrations.manage"));
  }

  // ─── Click-to-call ─────────────────────────────────────────────────────────

  /**
   * Twilio rings the rep's own phone; when they answer, our TwiML dials the
   * contact. One contact, one press of a button — never a list.
   */
  async dial(ctx: RequestContext, input: ClickToCallInputT) {
    const w = ws(ctx);
    const user = me(ctx).userId;
    await this.entitlements.assertFeature(w.billingAccountId, "calling");
    await this.entitlements.assertFullAccess(w.billingAccountId, "Calling");
    const reach = this.reachability();
    if (reach) throw unavailable(reach);

    const integration = await this.prisma.db.channelIntegration.findFirst({
      where: { id: input.integrationId, workspaceId: w.id, channel: "call", provider: "twilio", deletedAt: null },
    });
    if (!integration) throw notFound("That Twilio connection");
    if (integration.status !== "connected") throw conflict(`The Twilio connection "${integration.name}" is not working${integration.lastError ? `: ${integration.lastError}` : ""}. Verify it in Settings → Calling.`);
    const secrets = openJson<TwilioSecrets>(integration.secretSealed);
    const config = (integration.config ?? {}) as TwilioConfig;
    if (!secrets?.authToken || !config.callerId) throw conflict("The stored Twilio credentials could not be read — connect Twilio again.");
    const accountSid = config.accountSid ?? integration.externalId ?? "";

    const agent = normalizePhone(input.agentNumber);
    if (!agent) throw badRequest("Enter your phone number in international format, e.g. +14155550100", { agentNumber: "Use international format, e.g. +14155550100" });
    const contact = await this.calls.assertRefs(ctx, input);
    if (!contact) throw notFound("That contact");
    const to = normalizePhone(contact.phone);
    const who = contact.fullName || contact.email || "This contact";
    if (!to) throw conflict(`${who} has no phone number that can be dialled. Add one in international format.`);
    if (to === agent) throw badRequest("Your phone and the contact's number are the same.", { agentNumber: "This is the contact's number" });

    // A double press must not ring twice.
    const ringing = await this.prisma.db.call.findFirst({
      where: { workspaceId: w.id, userId: user, provider: "twilio", status: { in: ["queued", "ringing"] }, createdAt: { gt: new Date(Date.now() - 60_000) } },
      select: { id: true },
    });
    if (ringing) throw conflict("Your phone is already being rung for another call. Answer it, or wait a minute and try again.", undefined, { callId: ringing.id });

    // Compliance: the do-not-contact flag and list, checked immediately before Twilio is asked to dial.
    if (contact.doNotContact) throw conflict(`${who} is marked do not contact.`);
    const blocked = await this.suppression.check(w.id, { phone: to });
    if (blocked) throw conflict(blocked);

    const now = new Date();
    const call = await this.prisma.db.call.create({
      data: {
        workspaceId: w.id,
        contactId: contact.id,
        dealId: input.dealId ?? null,
        taskId: input.taskId ?? null,
        scriptId: input.scriptId ?? null,
        userId: user,
        integrationId: integration.id,
        provider: "twilio",
        direction: "outbound",
        fromNumber: config.callerId,
        toNumber: to,
        status: "queued",
        startedAt: now,
      },
    });

    let sid: string;
    try {
      const r = await twilioApi.createCall(accountSid, secrets.authToken, {
        to: agent,
        from: config.callerId,
        twimlUrl: this.hookUrl(integration.webhookKey, "twiml", call.id),
        statusUrl: this.hookUrl(integration.webhookKey, "status", call.id),
      });
      sid = r.sid;
    } catch (e) {
      const err = e instanceof TwilioError ? e : new TwilioError(reasonOf(e), 0);
      if (err.status === 0) {
        // Twilio may have accepted it before the line dropped: the call stays queued, and its callbacks (if any) will move it on.
        throw unavailable(`${err.message}. If your phone rings, the call is going ahead; otherwise try again.`);
      }
      await this.prisma.db.call.update({ where: { id: call.id, workspaceId: w.id }, data: { status: "failed", endedAt: new Date() } });
      if (err.status === 401) {
        await this.prisma.db.channelIntegration.updateMany({ where: { id: integration.id, workspaceId: w.id }, data: { status: "error", lastError: err.message.slice(0, 500) } });
      }
      throw new ApiError(err.status === 401 ? 409 : 400, err.status === 401 ? "conflict" : "bad_request", `Twilio refused the call: ${err.message}`);
    }

    await this.prisma.db.$transaction(async (tx) => {
      if (sid) await tx.call.updateMany({ where: { id: call.id, workspaceId: w.id, providerCallId: null }, data: { providerCallId: sid } });
      await this.calls.touchContact(tx, w.id, contact.id, now);
    });
    return this.calls.get(ctx, call.id);
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────

  /** Finds the integration by its URL key and checks Twilio's signature; then the call, re-scoped to that workspace. */
  private async authenticate(webhookKey: string, hook: Hook, callId: string, params: Params, signature: string | undefined) {
    if (!webhookKey || webhookKey.length > 100) throw notFound("That webhook");
    // Unscoped by necessity: Twilio's callback carries no session; the unguessable key in its URL names the integration (and so the workspace).
    const integration = await this.prisma.unscoped.channelIntegration.findUnique({ where: { webhookKey } });
    if (!integration || integration.provider !== "twilio") throw notFound("That webhook");
    const token = openJson<TwilioSecrets>(integration.secretSealed)?.authToken ?? "";
    if (!twilioSignatureOk(token, this.hookUrl(webhookKey, hook, callId), params, signature)) {
      this.log.warn(`${integration.workspaceId}: a Twilio ${hook} callback failed its signature`);
      throw unauthorized("Invalid signature");
    }
    const workspaceId = integration.workspaceId;
    const call = isUuid(callId) ? await this.prisma.db.call.findFirst({ where: { id: callId, workspaceId, integrationId: integration.id } }) : null;
    // A callback for a different Twilio call than the one we stored is not this call's.
    const sid = str(params.CallSid);
    const ours = call && (!call.providerCallId || !sid || call.providerCallId === sid) ? call : null;
    await this.prisma.db.channelIntegration.updateMany({ where: { id: integration.id, workspaceId }, data: { lastEventAt: new Date() } });
    return { integration, workspaceId, call: ours };
  }

  /** The rep answered: re-check the do-not-contact rules, then bridge to the contact. Returns TwiML. */
  async twiml(webhookKey: string, callId: string, params: Params, signature: string | undefined): Promise<string> {
    const { integration, workspaceId, call } = await this.authenticate(webhookKey, "twiml", callId, params, signature);
    if (!call) return refusalTwiml("This call could not be found. Goodbye.");
    if (isFinalCallStatus(call.status)) return refusalTwiml("This call has already ended. Goodbye.");

    // Compliance: checked again now, immediately before <Dial> reaches the contact — an opt-out may have landed while the rep's phone rang.
    let refusal: string | null = null;
    if (call.contactId) {
      const contact = await this.prisma.db.contact.findFirst({ where: { id: call.contactId, workspaceId }, select: { deletedAt: true, doNotContact: true } });
      if (!contact || contact.deletedAt) refusal = "The contact no longer exists.";
      else if (contact.doNotContact) refusal = "The contact is marked do not contact.";
    }
    if (!refusal && (await this.suppression.check(workspaceId, { phone: call.toNumber }))) refusal = "The number is on the do-not-contact list.";
    const callerId = ((integration.config ?? {}) as TwilioConfig).callerId ?? call.fromNumber;

    const sid = str(params.CallSid);
    const live = await this.prisma.db.$transaction(async (tx) => {
      const row = await this.calls.lock(tx, workspaceId, call.id);
      if (isFinalCallStatus(row.status)) return false;
      const status = refusal ? "canceled" : (advance(row.status, "in_progress") ?? row.status);
      await tx.call.update({
        where: { id: call.id, workspaceId },
        data: { status, ...(refusal ? { endedAt: new Date() } : {}), ...(!row.providerCallId && sid ? { providerCallId: sid } : {}) },
      });
      return true;
    });
    if (!live) return refusalTwiml("This call has already ended. Goodbye.");
    if (refusal) return refusalTwiml(`This call was not connected. ${refusal} Goodbye.`);
    return dialTwiml({ callerId, to: call.toNumber, actionUrl: this.hookUrl(webhookKey, "dial", call.id) });
  }

  /** The contact's leg ended: its status and talk time are the call's result. Returns TwiML (hang up). */
  async dialEnded(webhookKey: string, callId: string, params: Params, signature: string | undefined): Promise<string> {
    const { workspaceId, call } = await this.authenticate(webhookKey, "dial", callId, params, signature);
    if (!call) return EMPTY_TWIML;
    const status = dialResult(str(params.DialCallStatus));
    const talked = Number.parseInt(str(params.DialCallDuration), 10);
    const settled = await this.prisma.db.$transaction(async (tx) => {
      const row = await this.calls.lock(tx, workspaceId, call.id);
      if (isFinalCallStatus(row.status)) return false;
      await tx.call.update({
        where: { id: call.id, workspaceId },
        data: {
          status,
          endedAt: new Date(),
          durationSec: Number.isFinite(talked) && talked >= 0 ? talked : null,
          // Busy and no-answer are facts Twilio established; any other outcome is the rep's to record.
          outcome: row.outcome || outcomeFromStatus(status) || "",
        },
      });
      return this.calls.settle(tx, workspaceId, call.id);
    });
    if (settled) await this.events.kick();
    return EMPTY_TWIML;
  }

  /** The rep's leg moved (ringing, answered, ended). Only the end matters when no <Dial> result came first. */
  async statusChanged(webhookKey: string, callId: string, params: Params, signature: string | undefined) {
    const { workspaceId, call } = await this.authenticate(webhookKey, "status", callId, params, signature);
    if (!call) return { applied: false };
    const reported = TWILIO_STATUS[str(params.CallStatus)];
    if (!reported) return { applied: false };
    const sid = str(params.CallSid);
    const result = await this.prisma.db.$transaction(async (tx) => {
      const row = await this.calls.lock(tx, workspaceId, call.id);
      if (isFinalCallStatus(row.status)) return { applied: false, settled: false };
      const next = isFinalCallStatus(reported) ? parentEnded(row.status, reported) : advance(row.status, reported);
      if (!next) return { applied: false, settled: false };
      await tx.call.update({
        where: { id: call.id, workspaceId },
        data: { status: next, ...(isFinalCallStatus(next) ? { endedAt: new Date() } : {}), ...(!row.providerCallId && sid ? { providerCallId: sid } : {}) },
      });
      return { applied: true, settled: await this.calls.settle(tx, workspaceId, call.id) };
    });
    if (result.settled) await this.events.kick();
    return { applied: result.applied };
  }
}
