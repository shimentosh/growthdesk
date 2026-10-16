import { DiscordApi } from "../src/discord/discord-api.js";
import { bootApp, createWorkspace, signUp, type Agent, type TestApp } from "./helpers.js";

/*
 * Bring your own bot: a workspace saves its own Discord application, the bot
 * token is checked against the client id, the secrets are sealed and never
 * returned, and connecting uses that application. Discord's API is stubbed.
 */
describe("Discord: the workspace's own bot", () => {
  let t: TestApp;
  let owner: Agent;
  let w: string;
  const api = (path: string) => `/v1/workspaces/${w}${path}`;
  const CLIENT_ID = "123456789012345678";
  const GOOD_TOKEN = "good-bot-token";

  beforeAll(async () => {
    t = await bootApp();
    owner = await signUp(t, "discord-own@acme.test");
    w = await createWorkspace(owner, "Discord Co");
    t.app.get(DiscordApi).fetchImpl = async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      if (url.endsWith("/applications/@me")) {
        return auth === `Bot ${GOOD_TOKEN}`
          ? new Response(JSON.stringify({ id: CLIENT_ID, name: "Acme alerts" }), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ message: "401: Unauthorized", code: 0 }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    };
  });
  afterAll(async () => t.close());

  it("has no bot until one is saved", async () => {
    const o = (await owner.get(api("/discord")).expect(200)).body.data;
    expect(o).toMatchObject({ configured: false, appSource: null, ownApp: null });
    await owner.post(api("/discord/connect")).send({}).expect(503);
  });

  it("refuses a token Discord does not accept, or one from another application", async () => {
    const bad = await owner.put(api("/discord/app")).send({ clientId: CLIENT_ID, clientSecret: "s3cret", botToken: "nope" }).expect(400);
    expect(bad.body.error.fields.botToken).toBeTruthy();
    const other = await owner.put(api("/discord/app")).send({ clientId: "999999999999999999", clientSecret: "s3cret", botToken: GOOD_TOKEN }).expect(400);
    expect(other.body.error.fields.botToken).toBeTruthy();
  });

  it("saves the application sealed, and connects through it", async () => {
    const saved = (await owner.put(api("/discord/app")).send({ clientId: CLIENT_ID, clientSecret: "s3cret", botToken: GOOD_TOKEN }).expect(200)).body.data;
    expect(saved).toMatchObject({ configured: true, appSource: "workspace", ownApp: { clientId: CLIENT_ID, clientSecretSet: true, botTokenSet: true } });
    expect(JSON.stringify(saved)).not.toContain("s3cret");

    const row = await t.prisma.db.discordSettings.findUniqueOrThrow({ where: { workspaceId: w } });
    expect(row.appClientSecretSealed).not.toContain("s3cret");
    expect(row.appBotTokenSealed).not.toContain(GOOD_TOKEN);

    // Same application: the secrets may be left out and are kept.
    await owner.put(api("/discord/app")).send({ clientId: CLIENT_ID }).expect(200);

    const start = (await owner.post(api("/discord/connect")).send({ manageChannels: false }).expect(200)).body.data;
    expect(new URL(start.url).searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  it("removes the application", async () => {
    const o = (await owner.delete(api("/discord/app")).expect(200)).body.data;
    expect(o).toMatchObject({ appSource: null, ownApp: null });
  });
});
