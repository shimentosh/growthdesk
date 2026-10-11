import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { twilioSignature } from "../src/calls/twilio.js";
import { addMember, bootApp, createWorkspace, setPlan, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Calling: Twilio connect / click-to-call / signed callbacks against a local
 * fake of Twilio's REST API (TWILIO_API_URL), manual logging and outcomes,
 * the call queue, scripts, permissions and tenant isolation.
 *
 * The fake answers the two endpoints twilio.ts uses and records every call
 * request; Twilio's callbacks are simulated by signing requests with the
 * account's auth token exactly as Twilio does.
 */

const SID = `AC${"a1".repeat(16)}`;
const TOKEN = "fake-twilio-auth-token-0001";
const SID2 = `AC${"b2".repeat(16)}`;
const TOKEN2 = "fake-twilio-auth-token-0002";
const ACCOUNTS: Record<string, string> = { [SID]: TOKEN, [SID2]: TOKEN2 };
const PUBLIC = "http://localhost:3600";
const AGENT = "+14155550199";
const REFUSED = "+14155550100";

type FakeCall = { account: string; To: string; From: string; Url: string; StatusCallback: string; events: string[] };

function fakeTwilio() {
  const calls: FakeCall[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const m = /^\/2010-04-01\/Accounts\/([^/.]+)(\.json|\/Calls\.json)$/.exec(req.url ?? "");
      const [user, pass] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":");
      if (!m || !user || ACCOUNTS[user] !== pass || user !== m[1]) return send(401, { code: 20003, message: "Authenticate", status: 401 });
      if (m[2] === ".json" && req.method === "GET") return send(200, { sid: m[1], friendly_name: "Acme Sales Line", status: "active" });
      if (m[2] === "/Calls.json" && req.method === "POST") {
        const form = new URLSearchParams(body);
        if (form.get("From") === REFUSED) return send(400, { code: 21210, message: "The source phone number provided, +14155550100, is not yet verified for your account.", status: 400 });
        calls.push({ account: m[1]!, To: form.get("To")!, From: form.get("From")!, Url: form.get("Url")!, StatusCallback: form.get("StatusCallback")!, events: form.getAll("StatusCallbackEvent") });
        n += 1;
        return send(201, { sid: `CA${String(n).padStart(32, "0")}`, status: "queued" });
      }
      send(404, { message: "Not found" });
    });
  });
  return { server, calls };
}

describe("Calling", () => {
  let t: TestApp;
  let fake: ReturnType<typeof fakeTwilio>;
  let owner: Agent;
  let rep: Agent;
  let viewer: Agent;
  let outsider: Agent;
  let w: string;
  let w2: string;
  let integrationId: string;
  let webhookKey: string;
  const ids: Record<string, string> = {};
  const base = () => `/v1/workspaces/${w}`;

  /** Posts a Twilio-style signed form callback to the API. */
  function callback(key: string, hook: "twiml" | "dial" | "status", callId: string, params: Record<string, string>, token = TOKEN, tamper = false) {
    const url = `${PUBLIC}/api/webhooks/twilio/${key}/${hook}?call=${callId}`;
    const signature = twilioSignature(token, url, params);
    return t
      .http()
      .post(`/v1/webhooks/twilio/${key}/${hook}?call=${callId}`)
      .type("form")
      .set("x-twilio-signature", tamper ? `x${signature.slice(1)}` : signature)
      .send(params);
  }

  const sidOf = async (callId: string) => (await t.prisma.db.call.findFirstOrThrow({ where: { id: callId, workspaceId: w } })).providerCallId!;
  const completedEvents = async (callId: string) => t.prisma.db.domainEvent.count({ where: { workspaceId: w, type: "call.completed", subjectId: callId } });

  beforeAll(async () => {
    fake = fakeTwilio();
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", () => r()));
    process.env.TWILIO_API_URL = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    t = await bootApp();
    owner = await signUp(t, "calls-owner@acme.test", "Olive Owner");
    w = await createWorkspace(owner, "Calls Co");
    await setPlan(t, w, "agency");
    // Reps here call and log, but do not see other people's records.
    await owner.put(`${base()}/role-permissions`).send({ role: "member", permissions: ["contacts.read", "contacts.write", "tasks.read", "tasks.write", "calls.read", "calls.make"] }).expect(200);
    rep = await addMember(t, owner, w, "calls-rep@acme.test", "member");
    viewer = await addMember(t, owner, w, "calls-viewer@acme.test", "viewer");
    outsider = await signUp(t, "calls-outsider@other.test", "Otto Outsider");
    w2 = await createWorkspace(outsider, "Other Co");
    await setPlan(t, w2, "agency");

    const mk = async (fullName: string, phone: string | null, extra: Record<string, unknown> = {}) =>
      (await owner.post(`${base()}/contacts`).send({ fullName, phone, ownerId: null, ...extra }).expect(201)).body.data.id as string;
    ids.ada = await mk("Ada Lovelace", "+1 415 555 0123");
    ids.bob = await mk("Bob Barred", "+14155550124", { doNotContact: true });
    ids.carl = await mk("Carl Listed", "+14155550125");
    ids.dee = await mk("Dee Busy", "+14155550126");
    ids.eve = await mk("Eve Manual", "+14155550127");
    ids.nophone = await mk("Nora Nophone", null);
    await owner.post(`${base()}/suppressions`).send({ kind: "phone", value: "+14155550125", reason: "do_not_contact" }).expect(201);
  });

  afterAll(async () => {
    delete process.env.TWILIO_API_URL;
    await t?.close();
    await new Promise((r) => fake.server.close(r));
  });

  it("connects Twilio only with credentials Twilio accepts, and never returns the token", async () => {
    const bad = await owner.post(`${base()}/calls/twilio`).send({ accountSid: SID, authToken: "wrong-token-123456789", callerId: "+14155550111" }).expect(400);
    expect(bad.body.error.message).toMatch(/Twilio did not accept those details: Authenticate/);
    await owner.post(`${base()}/calls/twilio`).send({ accountSid: SID, authToken: TOKEN, callerId: "not a number" }).expect(400);
    await rep.post(`${base()}/calls/twilio`).send({ accountSid: SID, authToken: TOKEN, callerId: "+14155550111" }).expect(403);

    const res = await owner.post(`${base()}/calls/twilio`).send({ accountSid: SID, authToken: TOKEN, callerId: "+1 (415) 555-0111" }).expect(201);
    const row = res.body.data;
    expect(row).toMatchObject({ channel: "call", provider: "twilio", name: "Acme Sales Line", status: "connected", details: { accountSid: SID, callerId: "+14155550111", friendlyName: "Acme Sales Line" } });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    integrationId = row.id;
    const stored = await t.prisma.db.channelIntegration.findFirstOrThrow({ where: { id: integrationId, workspaceId: w } });
    expect(stored.secretSealed).toBeTruthy();
    expect(stored.secretSealed).not.toContain(TOKEN);
    webhookKey = stored.webhookKey;

    // One Twilio account belongs to one workspace.
    await outsider.post(`/v1/workspaces/${w2}/calls/twilio`).send({ accountSid: SID, authToken: TOKEN, callerId: "+14155550111" }).expect(409);

    const setup = await rep.get(`${base()}/calls/setup`).expect(200);
    expect(setup.body.data.clickToCall).toEqual({ available: true, reason: null });
    expect(setup.body.data.twilio).toEqual([expect.objectContaining({ id: integrationId, callerId: "+14155550111", status: "connected" })]);
    const listed = await owner.get(`${base()}/channels`).expect(200);
    expect(listed.body.data.map((c: { id: string }) => c.id)).toContain(integrationId);
  });

  it("refuses click-to-call when the contact may not be called, before Twilio is asked", async () => {
    const before = fake.calls.length;
    const dial = (contactId: string) => rep.post(`${base()}/calls/dial`).send({ contactId, integrationId, agentNumber: AGENT });
    expect((await dial(ids.bob!).expect(409)).body.error.message).toMatch(/do not contact/);
    expect((await dial(ids.carl!).expect(409)).body.error.message).toMatch(/do-not-contact list/);
    expect((await dial(ids.nophone!).expect(409)).body.error.message).toMatch(/no phone number/);
    await rep.post(`${base()}/calls/dial`).send({ contactId: ids.ada, integrationId, agentNumber: "12" }).expect(400);
    expect(fake.calls.length).toBe(before);
  });

  it("dials: rings the rep, bridges to the contact on answer, and follows Twilio's signed callbacks", async () => {
    const res = await rep.post(`${base()}/calls/dial`).send({ contactId: ids.ada, integrationId, agentNumber: "+1 415 555 0199" }).expect(201);
    const call = res.body.data;
    ids.call1 = call.id;
    expect(call).toMatchObject({ provider: "twilio", status: "queued", toNumber: "+14155550123", fromNumber: "+14155550111", outcome: "", contact: { id: ids.ada } });
    const sent = fake.calls.at(-1)!;
    expect(sent).toMatchObject({ account: SID, To: AGENT, From: "+14155550111" });
    expect(sent.Url).toBe(`${PUBLIC}/api/webhooks/twilio/${webhookKey}/twiml?call=${call.id}`);
    expect(sent.StatusCallback).toBe(`${PUBLIC}/api/webhooks/twilio/${webhookKey}/status?call=${call.id}`);
    expect(sent.events).toEqual(["initiated", "ringing", "answered", "completed"]);
    const sid = (await t.prisma.db.call.findFirstOrThrow({ where: { id: call.id, workspaceId: w } })).providerCallId!;
    expect(sid).toMatch(/^CA/);

    // A second press while the phone is ringing does not ring again.
    await rep.post(`${base()}/calls/dial`).send({ contactId: ids.ada, integrationId, agentNumber: AGENT }).expect(409);

    // Unsigned or tampered callbacks are refused and change nothing.
    await t.http().post(`/v1/webhooks/twilio/${webhookKey}/status?call=${call.id}`).type("form").send({ CallSid: sid, CallStatus: "ringing" }).expect(401);
    await callback(webhookKey, "status", call.id, { CallSid: sid, CallStatus: "ringing" }, TOKEN, true).expect(401);
    await callback(webhookKey, "status", call.id, { CallSid: sid, CallStatus: "ringing" }, TOKEN2).expect(401);
    await callback("nope", "status", call.id, { CallSid: sid, CallStatus: "ringing" }).expect(404);

    await callback(webhookKey, "status", call.id, { CallSid: sid, CallStatus: "ringing" }).expect(200);
    expect((await rep.get(`${base()}/calls/${call.id}`).expect(200)).body.data.status).toBe("ringing");
    // A report about some other Twilio call, even correctly signed, is not this call's.
    await callback(webhookKey, "status", call.id, { CallSid: "CAsomeoneelse", CallStatus: "failed" }).expect(200);
    expect((await rep.get(`${base()}/calls/${call.id}`).expect(200)).body.data.status).toBe("ringing");

    const twiml = await callback(webhookKey, "twiml", call.id, { CallSid: sid, CallStatus: "in-progress" }).expect(200);
    expect(twiml.headers["content-type"]).toMatch(/text\/xml/);
    expect(twiml.text).toContain(`<Dial callerId="+14155550111" action="${PUBLIC}/api/webhooks/twilio/${webhookKey}/dial?call=${call.id}"`);
    expect(twiml.text).toContain("<Number>+14155550123</Number>");
    expect(twiml.text).not.toMatch(/<Record/);
    // A late "ringing" never moves the call backwards.
    await callback(webhookKey, "status", call.id, { CallSid: sid, CallStatus: "ringing" }).expect(200);
    expect((await rep.get(`${base()}/calls/${call.id}`).expect(200)).body.data.status).toBe("in_progress");

    const hangup = await callback(webhookKey, "dial", call.id, { CallSid: sid, DialCallSid: "CAchild", DialCallStatus: "completed", DialCallDuration: "42" }).expect(200);
    expect(hangup.text).toContain("<Response/>");
    await callback(webhookKey, "status", call.id, { CallSid: sid, CallStatus: "completed", CallDuration: "55" }).expect(200);
    const done = (await rep.get(`${base()}/calls/${call.id}`).expect(200)).body.data;
    expect(done).toMatchObject({ status: "completed", durationSec: 42, outcome: "" });
    // Ended, but nobody has said how it went yet: no call.completed.
    expect(await completedEvents(call.id)).toBe(0);
    const ada = await t.prisma.db.contact.findFirstOrThrow({ where: { id: ids.ada, workspaceId: w } });
    expect(ada.status).toBe("contacted");
    expect(ada.lastContactedAt).not.toBeNull();
  });

  it("records the outcome once: timeline, call.completed, and a callback in the caller's queue", async () => {
    const callbackAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await rep.patch(`${base()}/calls/${ids.call1}`).send({ durationSec: 99 }).expect(400);
    const res = await rep.patch(`${base()}/calls/${ids.call1}`).send({ outcome: "callback_requested", notes: "Call back Thursday", callbackAt }).expect(200);
    expect(res.body.data).toMatchObject({ outcome: "callback_requested", notes: "Call back Thursday", status: "completed", durationSec: 42 });
    expect(await completedEvents(ids.call1!)).toBe(1);
    const ev = await t.prisma.db.domainEvent.findFirstOrThrow({ where: { workspaceId: w, type: "call.completed", subjectId: ids.call1 } });
    expect(ev.payload).toMatchObject({ contactId: ids.ada, outcome: "callback_requested", status: "completed", durationSec: 42, provider: "twilio", userId: rep.userId });

    await rep.patch(`${base()}/calls/${ids.call1}`).send({ notes: "Call back Thursday afternoon" }).expect(200);
    expect(await completedEvents(ids.call1!)).toBe(1);

    const timeline = (await owner.get(`${base()}/contacts/${ids.ada}/timeline`).expect(200)).body.data as { type: string; summary: string }[];
    expect(timeline.filter((a) => a.type === "call.completed").map((a) => a.summary)).toEqual(["Called Ada Lovelace: Callback requested · 42s"]);

    const queue = (await rep.get(`${base()}/calls/queue`).query({ window: "all" }).expect(200)).body.data;
    const item = queue.items.find((i: { contact: { id: string } | null }) => i.contact?.id === ids.ada);
    expect(item).toMatchObject({ title: "Call back Ada Lovelace", blocked: null, lastCall: { id: ids.call1, outcome: "callback_requested" } });
    expect(new Date(item.dueAt).toISOString()).toBe(callbackAt);
    // Due in two days: not on today's list.
    const today = (await rep.get(`${base()}/calls/queue`).expect(200)).body.data;
    expect(today.items.some((i: { taskId: string }) => i.taskId === item.taskId)).toBe(false);
  });

  it("re-checks the do-not-contact list when the rep answers, and settles busy calls by itself", async () => {
    const res = await rep.post(`${base()}/calls/dial`).send({ contactId: ids.dee, integrationId, agentNumber: AGENT }).expect(201);
    const id = res.body.data.id as string;
    // Dee opts out while the rep's phone is ringing.
    await owner.post(`${base()}/suppressions`).send({ kind: "phone", value: "+14155550126", reason: "opted_out" }).expect(201);
    const twiml = await callback(webhookKey, "twiml", id, { CallSid: await sidOf(id), CallStatus: "in-progress" }).expect(200);
    expect(twiml.text).toContain("<Say>This call was not connected. The number is on the do-not-contact list. Goodbye.</Say><Hangup/>");
    expect(twiml.text).not.toContain("<Dial");
    expect((await rep.get(`${base()}/calls/${id}`).expect(200)).body.data.status).toBe("canceled");
    await owner.delete(`${base()}/suppressions/${(await t.prisma.db.suppression.findFirstOrThrow({ where: { workspaceId: w, value: "+14155550126" } })).id}`).expect(200);

    // The contact's line is busy: Twilio's report is the outcome, and the call is finished.
    const res2 = await rep.post(`${base()}/calls/dial`).send({ contactId: ids.dee, integrationId, agentNumber: AGENT }).expect(201);
    const id2 = res2.body.data.id as string;
    await callback(webhookKey, "twiml", id2, { CallSid: await sidOf(id2), CallStatus: "in-progress" }).expect(200);
    await callback(webhookKey, "dial", id2, { CallSid: await sidOf(id2), DialCallStatus: "busy", DialCallDuration: "0" }).expect(200);
    expect((await rep.get(`${base()}/calls/${id2}`).expect(200)).body.data).toMatchObject({ status: "busy", outcome: "busy" });
    expect(await completedEvents(id2)).toBe(1);
    // A replayed callback changes nothing and emits nothing.
    await callback(webhookKey, "dial", id2, { CallSid: await sidOf(id2), DialCallStatus: "completed", DialCallDuration: "30" }).expect(200);
    expect((await rep.get(`${base()}/calls/${id2}`).expect(200)).body.data.status).toBe("busy");
    expect(await completedEvents(id2)).toBe(1);

    // The rep never picked up: the contact was never dialled.
    const res3 = await rep.post(`${base()}/calls/dial`).send({ contactId: ids.ada, integrationId, agentNumber: AGENT }).expect(201);
    await callback(webhookKey, "status", res3.body.data.id, { CallSid: await sidOf(res3.body.data.id), CallStatus: "no-answer" }).expect(200);
    expect((await rep.get(`${base()}/calls/${res3.body.data.id}`).expect(200)).body.data.status).toBe("canceled");
  });

  it("reports Twilio refusing a call, and marks the call failed", async () => {
    const before = await t.prisma.db.channelIntegration.findFirstOrThrow({ where: { id: integrationId, workspaceId: w } });
    await t.prisma.db.channelIntegration.update({ where: { id: integrationId, workspaceId: w }, data: { config: { ...(before.config as object), callerId: REFUSED } } });
    const res = await rep.post(`${base()}/calls/dial`).send({ contactId: ids.ada, integrationId, agentNumber: AGENT }).expect(400);
    expect(res.body.error.message).toMatch(/Twilio refused the call: The source phone number provided/);
    const failed = await t.prisma.db.call.findFirstOrThrow({ where: { workspaceId: w, fromNumber: REFUSED }, orderBy: { createdAt: "desc" } });
    expect(failed.status).toBe("failed");
    await t.prisma.db.channelIntegration.update({ where: { id: integrationId, workspaceId: w }, data: { config: before.config as object } });
  });

  it("works through the queue: adds callable contacts, logs a manual call against the task, honours 'do not call'", async () => {
    const add = await rep.post(`${base()}/calls/queue`).send({ contactIds: [ids.eve, ids.bob, ids.carl, ids.nophone] }).expect(201);
    expect(add.body.data.added).toBe(1);
    expect(add.body.data.skipped.map((s: { contactId: string }) => s.contactId).sort()).toEqual([ids.bob, ids.carl, ids.nophone].sort());
    expect((await rep.post(`${base()}/calls/queue`).send({ contactIds: [ids.eve] }).expect(201)).body.data).toMatchObject({ added: 0, skipped: [{ contactId: ids.eve, reason: "Already on your call list." }] });
    const queue = (await rep.get(`${base()}/calls/queue`).expect(200)).body.data;
    const item = queue.items.find((i: { contact: { id: string } | null }) => i.contact?.id === ids.eve);
    expect(item).toMatchObject({ title: "Call Eve Manual", blocked: null, lastCall: null });

    const logged = await rep.post(`${base()}/calls`).send({ contactId: ids.eve, taskId: item.taskId, outcome: "do_not_call", notes: "Asked us to stop calling", durationSec: 30 }).expect(201);
    expect(logged.body.data).toMatchObject({ provider: "manual", status: "completed", outcome: "do_not_call", durationSec: 30, toNumber: "+14155550127", user: { id: rep.userId } });
    expect(await completedEvents(logged.body.data.id)).toBe(1);
    const task = await t.prisma.db.task.findFirstOrThrow({ where: { id: item.taskId, workspaceId: w } });
    expect(task.status).toBe("done");
    expect(await t.prisma.db.suppression.findFirst({ where: { workspaceId: w, kind: "phone", value: "+14155550127" } })).toMatchObject({ reason: "opted_out", source: "call" });
    // …so the next attempt is refused.
    expect((await rep.post(`${base()}/calls/dial`).send({ contactId: ids.eve, integrationId, agentNumber: AGENT }).expect(409)).body.error.message).toMatch(/do-not-contact list/);

    // Removing from the list cancels the task (Ada's is the callback scheduled earlier).
    const adaItem = (await rep.get(`${base()}/calls/queue`).query({ window: "all" }).expect(200)).body.data.items.find((i: { contact: { id: string } | null }) => i.contact?.id === ids.ada);
    await viewer.delete(`${base()}/calls/queue/${adaItem.taskId}`).expect(403);
    await rep.delete(`${base()}/calls/queue/${adaItem.taskId}`).expect(200);
    expect((await t.prisma.db.task.findFirstOrThrow({ where: { id: adaItem.taskId, workspaceId: w } })).status).toBe("canceled");
    await rep.delete(`${base()}/calls/queue/${adaItem.taskId}`).expect(404);

    // A no-answer logged by hand is recorded as the line status too.
    const na = await owner.post(`${base()}/calls`).send({ toNumber: "+44 20 7946 0000", outcome: "no_answer" }).expect(201);
    expect(na.body.data).toMatchObject({ status: "no_answer", toNumber: "+442079460000", contact: null });
    await owner.post(`${base()}/calls`).send({ outcome: "connected" }).expect(400);
  });

  it("filters history and keeps each rep to their own calls without records.view_all", async () => {
    const mine = (await rep.get(`${base()}/calls`).expect(200)).body.data;
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((c: { user: { id: string } | null }) => c.user?.id === rep.userId)).toBe(true);
    const ownerCall = (await owner.get(`${base()}/calls`).query({ outcome: "no_answer", provider: "manual" }).expect(200)).body.data.items[0];
    expect(ownerCall.user.id).toBe(owner.userId);
    await rep.get(`${base()}/calls/${ownerCall.id}`).expect(404);
    await rep.patch(`${base()}/calls/${ownerCall.id}`).send({ notes: "x" }).expect(404);

    const busy = (await owner.get(`${base()}/calls`).query({ status: "busy" }).expect(200)).body.data;
    expect(busy.items.map((c: { outcome: string }) => c.outcome)).toEqual(["busy"]);
    const open = (await owner.get(`${base()}/calls`).query({ outcome: "none" }).expect(200)).body.data;
    expect(open.items.every((c: { outcome: string }) => c.outcome === "")).toBe(true);
    const ada = (await owner.get(`${base()}/calls`).query({ contactId: ids.ada }).expect(200)).body.data;
    expect(ada.items.every((c: { contact: { id: string } }) => c.contact.id === ids.ada)).toBe(true);

    await viewer.get(`${base()}/calls`).expect(200);
    await viewer.post(`${base()}/calls`).send({ contactId: ids.ada, outcome: "connected" }).expect(403);
    await viewer.post(`${base()}/calls/dial`).send({ contactId: ids.ada, integrationId, agentNumber: AGENT }).expect(403);
  });

  it("manages call scripts", async () => {
    const s = (await rep.post(`/v1/workspaces/${w}/call-scripts`).send({ name: "Discovery", body: "Hi {{first_name}}, it's {{sender_name}}…" }).expect(201)).body.data;
    expect(s).toMatchObject({ name: "Discovery", workspaceId: w });
    await rep.patch(`/v1/workspaces/${w}/call-scripts/${s.id}`).send({ name: "Discovery v2" }).expect(200);
    expect((await viewer.get(`/v1/workspaces/${w}/call-scripts`).expect(200)).body.data.map((x: { name: string }) => x.name)).toEqual(["Discovery v2"]);
    await viewer.post(`/v1/workspaces/${w}/call-scripts`).send({ name: "Nope", body: "x" }).expect(403);
    await rep.post(`/v1/workspaces/${w}/call-scripts`).send({ name: "", body: "x" }).expect(400);
    // A call can name the script it used.
    await rep.post(`${base()}/calls`).send({ contactId: ids.ada, outcome: "left_voicemail", scriptId: s.id }).expect(201);
    await outsider.get(`/v1/workspaces/${w}/call-scripts`).expect(404);
    await outsider.patch(`/v1/workspaces/${w2}/call-scripts/${s.id}`).send({ name: "stolen" }).expect(404);
    await rep.delete(`/v1/workspaces/${w}/call-scripts/${s.id}`).expect(200);
    await rep.delete(`/v1/workspaces/${w}/call-scripts/${s.id}`).expect(404);
  });

  it("keeps workspaces apart, including on Twilio's callbacks", async () => {
    await outsider.get(`${base()}/calls`).expect(404);
    await outsider.get(`${base()}/calls/${ids.call1}`).expect(404);
    await outsider.get(`/v1/workspaces/${w2}/calls/${ids.call1}`).expect(404);
    await outsider.post(`/v1/workspaces/${w2}/calls`).send({ contactId: ids.ada, outcome: "connected" }).expect(404);

    // Another workspace's Twilio account, correctly signed, cannot touch this workspace's call.
    const other = await outsider.post(`/v1/workspaces/${w2}/calls/twilio`).send({ accountSid: SID2, authToken: TOKEN2, callerId: "+14155550222" }).expect(201);
    const key2 = (await t.prisma.db.channelIntegration.findFirstOrThrow({ where: { id: other.body.data.id, workspaceId: w2 } })).webhookKey;
    const res = await callback(key2, "twiml", ids.call1!, { CallSid: "CAx", CallStatus: "in-progress" }, TOKEN2).expect(200);
    expect(res.text).toContain("This call could not be found");
    await callback(key2, "status", ids.call1!, { CallSid: "CAx", CallStatus: "failed" }, TOKEN2).expect(200);
    expect((await t.prisma.db.call.findFirstOrThrow({ where: { id: ids.call1, workspaceId: w } })).status).toBe("completed");
    // Nor dial with the other workspace's integration.
    await rep.post(`${base()}/calls/dial`).send({ contactId: ids.ada, integrationId: other.body.data.id, agentNumber: AGENT }).expect(404);
  });

  it("refuses click-to-call when Twilio could not reach this deployment, and after disconnecting", async () => {
    const saved = process.env.TWILIO_API_URL;
    delete process.env.TWILIO_API_URL;
    try {
      const res = await rep.post(`${base()}/calls/dial`).send({ contactId: ids.ada, integrationId, agentNumber: AGENT }).expect(503);
      expect(res.body.error.message).toMatch(/public address Twilio can reach/);
      expect((await rep.get(`${base()}/calls/setup`).expect(200)).body.data.clickToCall.available).toBe(false);
    } finally {
      process.env.TWILIO_API_URL = saved;
    }

    await owner.delete(`${base()}/channels/${integrationId}`).expect(200);
    expect((await rep.get(`${base()}/calls/setup`).expect(200)).body.data).toMatchObject({ twilio: [], clickToCall: { available: false, reason: "Twilio is not connected in this workspace." } });
    await rep.post(`${base()}/calls/dial`).send({ contactId: ids.ada, integrationId, agentNumber: AGENT }).expect(404);
    // The credentials are gone, so callbacks to the old key can no longer be authenticated.
    await callback(webhookKey, "status", ids.call1!, { CallSid: "CA1", CallStatus: "completed" }).expect(401);
  });

  it("needs a plan with room for a calling connection", async () => {
    const free = await signUp(t, "calls-free@acme.test", "Fran Free");
    const wf = await createWorkspace(free, "Free Co");
    await setPlan(t, wf, "free");
    const res = await free.post(`/v1/workspaces/${wf}/calls/twilio`).send({ accountSid: SID, authToken: TOKEN, callerId: "+14155550111" }).expect(402);
    expect(res.body.error.details).toMatchObject({ limit: "channelIntegrations" });
    // Manual logging is part of every plan.
    const c = (await free.post(`/v1/workspaces/${wf}/contacts`).send({ fullName: "Gil", phone: "+14155550130" }).expect(201)).body.data.id;
    await free.post(`/v1/workspaces/${wf}/calls`).send({ contactId: c, outcome: "connected", durationSec: 60 }).expect(201);
  });
});
