import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { App } from "supertest/types.js";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { MailService } from "../src/core/mail.service.js";
import { seedPlans } from "../src/scripts/seed.js";
import { Queues } from "../src/queues/queues.js";
import { Redis } from "ioredis";
import { PlatformSettingsService } from "../src/core/platform-settings.service.js";

export type TestApp = {
  app: NestExpressApplication;
  prisma: PrismaService;
  mail: MailService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
};

/** Empties every table (but keeps the schema) so each suite starts clean. */
export async function truncateAll(prisma: PrismaService) {
  const rows = await prisma.unscoped.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (!rows.length) return;
  await prisma.unscoped.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export async function bootApp(extraModules: unknown[] = []): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, ...(extraModules as never[])] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: process.env.TEST_LOGS ? ["error", "warn"] : false, rawBody: true });
  configureApp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  await truncateAll(prisma);
  await seedPlans(prisma.unscoped);
  const redis = new Redis(process.env.REDIS_URL!);
  await redis.flushdb();
  await redis.quit();
  const queues = app.get(Queues);
  await Promise.all(queues.all().map((q) => q.obliterate({ force: true }).catch(() => undefined)));
  const server = app.getHttpServer() as App;
  return {
    app,
    prisma,
    mail: app.get(MailService),
    http: () => request(server),
    close: () => app.close(),
  };
}

/** A signed-in agent (cookie jar) for one person. */
export type Agent = ReturnType<typeof request.agent> & { userId: string; email: string };

export async function signUp(t: TestApp, email: string, name = "Test Person", password = "Correct-horse-9"): Promise<Agent> {
  const agent = request.agent(t.app.getHttpServer() as App) as Agent;
  await agent.post("/v1/auth/register").send({ name, email, password, acceptTerms: true }).expect(201);
  const mail = t.mail.outbox.filter((m) => m.to === email && m.template === "verify_email").at(-1);
  const token = mail?.text.match(/token=([A-Za-z0-9_%-]+)/)?.[1];
  if (!token) throw new Error("no verification email");
  await agent.post("/v1/auth/verify-email").send({ token: decodeURIComponent(token) }).expect(200);
  const me = await agent.get("/v1/auth/me").expect(200);
  agent.userId = me.body.data.user.id;
  agent.email = email;
  return agent;
}

export async function createWorkspace(agent: Agent, name = "Acme Outreach"): Promise<string> {
  const res = await agent.post("/v1/workspaces").send({ name, businessType: "agency", timezone: "UTC" }).expect(201);
  return res.body.data.id as string;
}

/** Signs up a second person and brings them into a workspace with a role. */
export async function addMember(t: TestApp, owner: Agent, workspaceId: string, email: string, role: string): Promise<Agent> {
  await owner.post(`/v1/workspaces/${workspaceId}/invitations`).send({ email, role }).expect(201);
  const invite = t.mail.outbox.filter((m) => m.to === email && m.template === "invitation").at(-1);
  const token = invite?.text.match(/invite\/([A-Za-z0-9_%-]+)/)?.[1];
  if (!token) throw new Error("no invitation email");
  const agent = request.agent(t.app.getHttpServer() as App) as Agent;
  await agent.post(`/v1/invitations/${token}/register`).send({ name: email.split("@")[0], password: "Correct-horse-9", acceptTerms: true }).expect(201);
  const me = await agent.get("/v1/auth/me").expect(200);
  agent.userId = me.body.data.user.id;
  agent.email = email;
  return agent;
}

/** Sets an account's plan directly (test setup only). */
export async function setPlan(t: TestApp, workspaceId: string, planKey: string, status: "active" | "trialing" | "past_due" | "canceled" = "active") {
  const ws = await t.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const plan = await t.prisma.db.plan.findUniqueOrThrow({ where: { key: planKey } });
  await t.prisma.db.subscription.update({
    where: { billingAccountId: ws.billingAccountId },
    data: { planId: plan.id, status, trialEndsAt: null, graceUntil: status === "past_due" ? new Date(Date.now() - 1000) : null },
  });
}

export const GOOGLE_TEST_CLIENT = { id: "test-google-client.apps.googleusercontent.com", secret: "test-google-secret" };

/** Turns Google sign-in on the way a platform admin does: a Google OAuth client in platform settings. */
export async function enableGoogleSignIn(t: TestApp) {
  await t.app.get(PlatformSettingsService).update({ googleClientId: GOOGLE_TEST_CLIENT.id, googleClientSecret: GOOGLE_TEST_CLIENT.secret }, null);
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
