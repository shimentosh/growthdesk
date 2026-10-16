import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AI_AGENT_TEMPLATES, agentFromTemplate } from "@growthdesk/shared";
import { AiCallsService } from "../src/ai-calling/ai-calls.service.js";
import { EngineService } from "../src/campaigns/engine.service.js";
import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * AI calling against a local fake of Cartesia's API (CARTESIA_API_URL):
 * connecting, agents saved to Cartesia, the consent / hours / do-not-contact
 * rules every call goes through, the campaign step, Cartesia's webhook, the
 * result applied to the CRM, the sweep that fetches missed results,
 * permissions and tenant isolation. No AI model is configured here, so
 * conversations are judged by the keyword heuristics.
 */

const KEY = "sk_car_fake_key_0001";
const REFUSED = "+14155550666";

type FakeCall = { agent_id: string; from_number_id: string; to: string; variables: Record<string, string>; maxMinutes: number };

function fakeCartesia() {
  const agents = new Map<string, { name: string; config: Record<string, unknown>; webhookId?: string }>();
  const webhooks = new Map<string, { url: string; secret: string }>();
  const placed: FakeCall[] = [];
  const callState = new Map<string, Record<string, unknown>>();
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${KEY}` || req.headers["cartesia-version"] !== "2026-08-14") return send(401, { message: "Invalid API key" });
      const url = new URL(req.url ?? "/", "http://fake");
      const json = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const path = url.pathname;
      if (req.method === "GET" && path === "/agents/phone-numbers") {
        return send(200, { data: [{ id: "ap_main", number: "+14155550000", label: "Main line", agent: null, provider: { type: "cartesia" } }], has_more: false });
      }
      if (req.method === "GET" && path === "/voices") return send(200, { data: [{ id: "voice_ava", name: "Ava", description: "Warm", language: "en", gender: "feminine" }], has_more: false });
      if (req.method === "POST" && path === "/agents/webhooks") {
        const id = `agent_webhook_${++n}`;
        webhooks.set(id, { url: String(json.url), secret: String(json.secret) });
        return send(200, { id, url: json.url, secret: json.secret, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }
      if (req.method === "POST" && path === "/v1/agents") {
        const config = json.config as Record<string, unknown>;
        if ((config.audio as { output: { voice_id: string } }).output.voice_id === "voice_missing") return send(400, { message: "Voice voice_missing not found" });
        const id = `agent_${++n}`;
        agents.set(id, { name: String(json.name), config });
        return send(201, { id });
      }
      let m = /^\/v1\/agents\/([^/]+)$/.exec(path);
      if (m && req.method === "PATCH") {
        const a = agents.get(m[1]!);
        if (!a) return send(404, { message: "Agent not found" });
        Object.assign(a, { name: json.name, config: json.config });
        return send(200, { id: m[1] });
      }
      if (m && req.method === "DELETE") {
        agents.delete(m[1]!);
        return send(200, {});
      }
      m = /^\/agents\/([^/]+)$/.exec(path);
      if (m && req.method === "PATCH" && m[1] !== "calls") {
        const a = agents.get(m[1]!);
        if (!a) return send(404, { message: "Agent not found" });
        a.webhookId = String(json.webhook_id);
        return send(200, {});
      }
      if (req.method === "POST" && path === "/agents/calls") {
        const one = (json.outbound_calls as { to_number: string; dynamic_variables: Record<string, string> }[])[0]!;
        if (one.to_number === REFUSED) return send(200, { calls: [{ number: one.to_number, error: { message: "Number cannot be dialled" } }] });
        placed.push({ agent_id: String(json.agent_id), from_number_id: String(json.from_number_id), to: one.to_number, variables: one.dynamic_variables, maxMinutes: Number(json.max_call_duration_minutes) });
        const id = `ac_${++n}`;
        callState.set(id, { id, agent_id: json.agent_id, status: "created" });
        return send(200, { calls: [{ number: one.to_number, agent_call_id: id }] });
      }
      m = /^\/agents\/calls\/([^/]+)$/.exec(path);
      if (m && req.method === "GET") {
        const c = callState.get(m[1]!);
        return c ? send(200, c) : send(404, { message: "Call not found" });
      }
      if (req.method === "DELETE") return send(200, {});
      send(404, { message: `No route ${req.method} ${path}` });
    });
  });
  return { server, agents, webhooks, placed, callState };
}

/** A time zone where it is now (or not) between 09:00 and 20:00 on a weekday-agnostic window. */
function zoneWhere(open: boolean): string {
  const zones = ["Pacific/Honolulu", "America/Los_Angeles", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Dhaka", "Asia/Tokyo", "Pacific/Auckland", "Pacific/Kiritimati"];
  for (const tz of zones) {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    const inside = hour >= 9 && hour < 19;
    if (inside === open && (open || hour < 7 || hour >= 22)) return tz;
  }
  throw new Error("no suitable time zone");
}

describe("AI calling", () => {
  let t: TestApp;
  let fake: ReturnType<typeof fakeCartesia>;
  let owner: Agent;
  let rep: Agent;
  let viewer: Agent;
  let outsider: Agent;
  let w: string;
  let w2: string;
  let connectionId: string;
  let webhookKey: string;
  let agentId: string;
  const ids: Record<string, string> = {};
  const base = () => `/v1/workspaces/${w}`;
  const calls = () => t.app.get(AiCallsService);
  const secret = () => [...fake.webhooks.values()].at(-1)!.secret;
  const event = (key: string, payload: Record<string, unknown>, s = secret()) => t.http().post(`/v1/webhooks/cartesia/${key}`).set("x-webhook-secret", s).send(payload);

  beforeAll(async () => {
    fake = fakeCartesia();
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", () => r()));
    process.env.CARTESIA_API_URL = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    t = await bootApp();
    owner = await signUp(t, "ai-owner@acme.test", "Olive Owner");
    w = await createWorkspace(owner, "AI Calls Co");
    await setPlan(t, w, "agency");
    rep = await addMember(t, owner, w, "ai-rep@acme.test", "member");
    viewer = await addMember(t, owner, w, "ai-viewer@acme.test", "viewer");
    outsider = await signUp(t, "ai-outsider@other.test", "Otto Outsider");
    w2 = await createWorkspace(outsider, "Other Co");
    await setPlan(t, w2, "agency");

    const open = zoneWhere(true);
    const mk = async (fullName: string, phone: string | null, extra: Record<string, unknown> = {}) =>
      (await owner.post(`${base()}/contacts`).send({ fullName, firstName: fullName.split(" ")[0], phone, timezone: open, ownerId: owner.userId, ...extra }).expect(201)).body.data.id as string;
    ids.ada = await mk("Ada Lovelace", "+14155550101", { consentStatus: "granted", consentSource: "Demo request form" });
    ids.bea = await mk("Bea Noconsent", "+14155550102");
    ids.cal = await mk("Cal Night", "+14155550103", { consentStatus: "granted", consentSource: "Form", timezone: zoneWhere(false) });
    ids.dan = await mk("Dan Listed", "+14155550104", { consentStatus: "granted", consentSource: "Form" });
    ids.eve = await mk("Eve Optout", "+14155550105", { consentStatus: "granted", consentSource: "Form" });
    ids.fay = await mk("Fay Refused", REFUSED, { consentStatus: "granted", consentSource: "Form" });
    ids.gus = await mk("Gus Campaign", "+14155550107", { consentStatus: "granted", consentSource: "Form" });
    await owner.post(`${base()}/suppressions`).send({ kind: "phone", value: "+14155550104", reason: "do_not_contact" }).expect(201);
  });

  afterAll(async () => {
    delete process.env.CARTESIA_API_URL;
    await t?.close();
    await new Promise((r) => fake.server.close(r));
  });

  it("connects Cartesia only with a key it accepts, registers the webhook, and never returns the key", async () => {
    const before = await owner.get(`${base()}/ai-calling/setup`).expect(200);
    expect(before.body.data).toMatchObject({ connection: null, ready: false });
    expect(before.body.data.reason).toMatch(/not connected/);

    await rep.post(`${base()}/ai-calling/cartesia`).send({ apiKey: KEY }).expect(403);
    const bad = await owner.post(`${base()}/ai-calling/cartesia`).send({ apiKey: "sk_car_wrong_key" }).expect(400);
    expect(bad.body.error.message).toMatch(/Cartesia did not accept that API key: Invalid API key/);

    const res = await owner.post(`${base()}/ai-calling/cartesia`).send({ apiKey: KEY }).expect(201);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(res.body.data).toMatchObject({ provider: "cartesia", status: "connected", phoneNumberId: "ap_main", phoneNumber: "+14155550000", webhook: { registered: true } });
    connectionId = res.body.data.id;
    const stored = await t.prisma.db.channelIntegration.findFirstOrThrow({ where: { id: connectionId, workspaceId: w } });
    expect(stored.secretSealed).not.toContain(KEY);
    webhookKey = stored.webhookKey;
    expect([...fake.webhooks.values()].at(-1)!.url).toBe(`http://localhost:3600/api/webhooks/cartesia/${webhookKey}`);

    const setup = await rep.get(`${base()}/ai-calling/setup`).expect(200);
    expect(setup.body.data).toMatchObject({ ready: true, reason: null, aiAnalysis: false });
    const voices = await rep.get(`${base()}/ai-calling/voices`).expect(200);
    expect(voices.body.data).toEqual([expect.objectContaining({ id: "voice_ava", name: "Ava" })]);
    // The verify path of the channels API knows Cartesia too.
    const verified = await owner.post(`${base()}/channels/${connectionId}/verify`).expect(200);
    expect(verified.body.data).toMatchObject({ provider: "cartesia", status: "connected" });
  });

  it("keeps the calling window inside 08:00–21:00 and the number on the account", async () => {
    const r = await owner.patch(`${base()}/ai-calling/settings`).send({ windowFrom: "07:00" }).expect(400);
    expect(r.body.error.fields.windowFrom).toMatch(/08:00/);
    await owner.patch(`${base()}/ai-calling/settings`).send({ phoneNumberId: "ap_other" }).expect(400);
    await rep.patch(`${base()}/ai-calling/settings`).send({ windowFrom: "10:00" }).expect(403);
    const ok = await owner.patch(`${base()}/ai-calling/settings`).send({ windowFrom: "09:00", windowTo: "19:00", days: [0, 1, 2, 3, 4, 5, 6] }).expect(200);
    expect(ok.body.data.settings).toMatchObject({ windowFrom: "09:00", windowTo: "19:00", days: [0, 1, 2, 3, 4, 5, 6], minHoursBetweenCalls: 20 });
    expect(ok.body.data.phoneNumberId).toBe("ap_main");
  });

  it("creates an agent from a template and saves it to Cartesia", async () => {
    const tpl = AI_AGENT_TEMPLATES.find((x) => x.key === "speed-to-lead")!;
    const input = { ...agentFromTemplate(tpl, { businessName: "Acme", voiceId: "voice_ava", voiceName: "Ava", personaName: "Ava" }), about: "Acme builds CRMs for agencies." };

    await rep.post(`${base()}/call-agents`).send(input).expect(403);
    const noAi = await owner.post(`${base()}/call-agents`).send({ ...input, disclosure: "This is Ava from Acme." }).expect(400);
    expect(noAi.body.error.fields.disclosure).toMatch(/AI/);
    const badVar = await owner.post(`${base()}/call-agents`).send({ ...input, greeting: "Hi {{nickname}}" }).expect(400);
    expect(badVar.body.error.fields.greeting).toMatch(/not a variable/);

    const res = await owner.post(`${base()}/call-agents`).send(input).expect(201);
    const a = res.body.data;
    agentId = a.id;
    expect(a).toMatchObject({ name: tpl.name, templateKey: "speed-to-lead", sync: { saved: true, error: "" }, usage: { campaigns: [], sequences: [] } });
    expect(a.preview.initialMessage).toBe("Hi {{first_name}}, thanks for getting in touch with Acme just now. I'm Ava, an AI assistant calling for Acme, and this call may be recorded.");
    const row = await t.prisma.db.callAgent.findFirstOrThrow({ where: { id: agentId, workspaceId: w } });
    const onCartesia = fake.agents.get(row.providerAgentId!)!;
    expect(onCartesia.config.initial_message).toBe(a.preview.initialMessage);
    expect(String(onCartesia.config.instructions)).toContain("Acme builds CRMs for agencies.");
    expect(onCartesia.webhookId).toBeTruthy();

    // An edit is pushed as an update, not a new agent.
    const edited = await owner.patch(`${base()}/call-agents/${agentId}`).send({ maxCallMinutes: 3, transferNumber: "+1 415 555 0199" }).expect(200);
    expect(edited.body.data).toMatchObject({ maxCallMinutes: 3, transferNumber: "+14155550199", sync: { saved: true } });
    expect(fake.agents.size).toBe(1);
    expect((onCartesia.config.system_tools as { transfer_to_number: { transfers: unknown[] } }).transfer_to_number.transfers).toHaveLength(1);

    // A voice Cartesia does not know: saved here, flagged, not pushed.
    const broken = await owner.post(`${base()}/call-agents`).send({ ...input, name: "Broken", voiceId: "voice_missing" }).expect(201);
    expect(broken.body.data.sync).toMatchObject({ saved: false, error: expect.stringMatching(/Voice voice_missing not found/) });
    await owner.delete(`${base()}/call-agents/${broken.body.data.id}`).expect(200);

    const list = await viewer.get(`${base()}/call-agents`).expect(200);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([agentId]);
    await outsider.get(`/v1/workspaces/${w2}/call-agents/${agentId}`).expect(404);
  });

  it("calls a contact only with consent, a number, inside their hours and off the do-not-contact list", async () => {
    const call = (contactId: string, who = owner) => who.post(`${base()}/call-agents/${agentId}/call`).send({ contactId });
    expect((await call(ids.bea!).expect(409)).body.error.message).toMatch(/consent/);
    const night = await call(ids.cal!).expect(409);
    expect(night.body.error.message).toMatch(/Outside the calling hours/);
    expect(night.body.error.details.nextAt).toBeTruthy();
    expect((await call(ids.dan!).expect(409)).body.error.message).toMatch(/do-not-contact/);
    await viewer.post(`${base()}/call-agents/${agentId}/call`).send({ contactId: ids.ada }).expect(403);
    const refused = await call(ids.fay!).expect(400);
    expect(refused.body.error.message).toMatch(/Number cannot be dialled/);
    expect(fake.placed).toHaveLength(0);

    const res = await call(ids.ada!).expect(201);
    expect(res.body.data).toMatchObject({ provider: "cartesia", status: "queued", agent: { id: agentId }, contact: { id: ids.ada }, toNumber: "+14155550101", fromNumber: "+14155550000" });
    expect(fake.placed[0]).toMatchObject({ from_number_id: "ap_main", to: "+14155550101", maxMinutes: 3, variables: { first_name: "Ada", full_name: "Ada Lovelace", company: "your company", owner_name: "Olive Owner" } });
    ids.adaCall = res.body.data.id;
    const contact = await t.prisma.db.contact.findFirstOrThrow({ where: { id: ids.ada, workspaceId: w } });
    expect(contact.status).toBe("contacted");

    // Not twice within the minimum gap.
    expect((await call(ids.ada!).expect(409)).body.error.message).toMatch(/less than 20 hours ago/);
  });

  it("a test call rings a number the person vouches for", async () => {
    await owner.post(`${base()}/call-agents/${agentId}/test-call`).send({ toNumber: "+14155550198" }).expect(400);
    const res = await owner.post(`${base()}/call-agents/${agentId}/test-call`).send({ toNumber: "+14155550198", consent: true, variables: { first_name: "Olive", company: "Acme" } }).expect(201);
    expect(res.body.data).toMatchObject({ provider: "cartesia", contact: null, user: { id: owner.userId } });
    expect(fake.placed.at(-1)!.variables).toMatchObject({ first_name: "Olive", company: "Acme" });
  });

  it("takes Cartesia's webhook: secret checked, progress, then the result applied once", async () => {
    const sid = (await t.prisma.db.call.findFirstOrThrow({ where: { id: ids.adaCall, workspaceId: w } })).providerCallId!;
    await event(webhookKey, { type: "call_started", call_id: sid }, "wrong-secret").expect(401);
    await event("nope", { type: "call_started", call_id: sid }).expect(404);
    await event(webhookKey, { type: "call_started", call_id: sid, call: { id: sid, status: "started" } }).expect(200);
    expect((await t.prisma.db.call.findFirstOrThrow({ where: { id: ids.adaCall, workspaceId: w } })).status).toBe("in_progress");

    const completed = {
      type: "call_completed",
      call_id: sid,
      call: {
        id: sid,
        status: "completed",
        start_time: "2026-10-14T15:00:00Z",
        end_time: "2026-10-14T15:02:05Z",
        end_reason: "client_hangup",
        transcript: [
          { role: "assistant", text: "Hi Ada, I'm Ava, an AI assistant calling for Acme.", start_timestamp: 0.4, end_timestamp: 3 },
          { role: "user", text: "Not a good time. Can you call me back tomorrow?", start_timestamp: 3.5, end_timestamp: 6 },
        ],
      },
    };
    const r = await event(webhookKey, completed).expect(200);
    expect(r.body.data).toEqual({ ok: true, applied: true });
    // A retry of the same event changes nothing.
    expect((await event(webhookKey, completed).expect(200)).body.data.applied).toBe(false);
    await event(webhookKey, { type: "post_call_analysis", call_id: sid, analysis: { summary: "Ada asked to be called back tomorrow." } }).expect(200);

    expect(await calls().finish(w, ids.adaCall!)).toBe(true);
    expect(await calls().finish(w, ids.adaCall!)).toBe(false);
    const got = await owner.get(`${base()}/calls/${ids.adaCall}`).expect(200);
    expect(got.body.data).toMatchObject({
      status: "completed",
      outcome: "callback_requested",
      durationSec: 125,
      endReason: "client_hangup",
      summary: "Ada asked to be called back tomorrow.",
      analysis: { outcome: "callback_requested", method: "heuristic" },
    });
    expect(got.body.data.transcript).toHaveLength(2);
    const listed = await owner.get(`${base()}/calls`).query({ provider: "cartesia", agentId }).expect(200);
    expect(listed.body.data.items.find((c: { id: string }) => c.id === ids.adaCall).transcript).toEqual([]);
    expect(await t.prisma.db.domainEvent.count({ where: { workspaceId: w, type: "call.completed", subjectId: ids.adaCall } })).toBe(1);
    const activity = await t.prisma.db.activity.findFirst({ where: { workspaceId: w, contactId: ids.ada, type: "call.completed" } });
    expect(activity?.summary).toMatch(/^AI agent called Ada Lovelace: Callback requested/);
  });

  it("runs as a campaign step: consented people are called, the rest skip, an opt-out stops the enrollment", async () => {
    const created = await owner
      .post(`${base()}/campaigns`)
      .send({
        name: "AI follow-up",
        audience: { type: "contacts", contactIds: [ids.gus, ids.bea, ids.eve] },
        schedule: { timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "23:59" },
        settings: { gapSeconds: 0 },
        steps: [
          { type: "ai_call", config: { agentId } },
          { type: "wait", config: { delayMinutes: 1440 } },
          { type: "call_task", config: { taskTitle: "Call {{full_name}} yourself" } },
        ],
      })
      .expect(201);
    const campaignId = created.body.data.id as string;
    const ready = await owner.get(`${base()}/campaigns/${campaignId}/readiness`).expect(200);
    expect(JSON.stringify(ready.body.data)).toMatch(/2 of 3 people have recorded consent/);
    await owner.post(`${base()}/campaigns/${campaignId}/launch`).expect(200);

    // In use by a live campaign: cannot be archived.
    expect((await owner.delete(`${base()}/call-agents/${agentId}`).expect(409)).body.error.message).toMatch(/AI follow-up/);

    const engine = t.app.get(EngineService);
    await t.prisma.db.enrollment.updateMany({ where: { workspaceId: w, campaignId }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    const enrollments = await t.prisma.db.enrollment.findMany({ where: { workspaceId: w, campaignId } });
    const out: Record<string, string> = {};
    for (const e of enrollments) out[e.contactId] = (await engine.runStep(w, e.id, e.stepRun)).outcome;
    expect(out[ids.gus!]).toBe("advanced");
    expect(out[ids.eve!]).toBe("advanced");
    expect(out[ids.bea!]).toBe("advanced"); // skipped (no consent), moved on to the wait
    const skipped = await t.prisma.db.stepExecution.findFirstOrThrow({ where: { workspaceId: w, campaignId, enrollment: { contactId: ids.bea } } });
    expect(skipped).toMatchObject({ status: "skipped", stepType: "ai_call" });
    expect(skipped.error).toMatch(/consent/);

    const eveCall = await t.prisma.db.call.findFirstOrThrow({ where: { workspaceId: w, contactId: ids.eve, provider: "cartesia" } });
    expect(eveCall).toMatchObject({ campaignId, agentId, status: "queued" });
    await event(webhookKey, {
      type: "call_completed",
      call: { id: eveCall.providerCallId, status: "completed", end_reason: "client_hangup", transcript: [{ role: "user", text: "Please stop calling me." }] },
    }).expect(200);
    await calls().finish(w, eveCall.id);
    const eveEnrollment = await t.prisma.db.enrollment.findFirstOrThrow({ where: { workspaceId: w, campaignId, contactId: ids.eve } });
    expect(eveEnrollment).toMatchObject({ status: "stopped", stopReason: "Asked not to be called again" });
    expect(await t.prisma.db.suppression.count({ where: { workspaceId: w, kind: "phone", value: "+14155550105" } })).toBe(1);

    // No answer, found by the sweep (no webhook): the outcome comes from the end reason; the sequence goes on.
    const gusCall = await t.prisma.db.call.findFirstOrThrow({ where: { workspaceId: w, contactId: ids.gus, provider: "cartesia" } });
    fake.callState.set(gusCall.providerCallId!, { id: gusCall.providerCallId, status: "completed", end_reason: "dial_no_answer", transcript: [] });
    await t.prisma.db.call.updateMany({ where: { id: gusCall.id, workspaceId: w }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    const swept = await calls().sweep();
    expect(swept.finished).toBeGreaterThanOrEqual(1);
    await calls().finish(w, gusCall.id);
    const gus = await t.prisma.db.call.findFirstOrThrow({ where: { id: gusCall.id, workspaceId: w } });
    expect(gus).toMatchObject({ status: "no_answer", outcome: "no_answer", endReason: "dial_no_answer" });
    expect((await t.prisma.db.enrollment.findFirstOrThrow({ where: { workspaceId: w, campaignId, contactId: ids.gus } })).status).toBe("active");
  });

  it("refuses an AI call step without a usable agent", async () => {
    const r = await owner.post(`${base()}/sequences`).send({ name: "No agent", steps: [{ type: "ai_call", config: {} }] }).expect(400);
    expect(r.body.error.message).toMatch(/choose the AI agent/);
  });
});
