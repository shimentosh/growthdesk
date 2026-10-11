import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { App } from "supertest/types.js";
import { configureApp } from "./app.setup.js";

@Module({})
class EmptyModule {}

async function docsAnswers(nodeEnv: string) {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  const app = await NestFactory.create<NestExpressApplication>(EmptyModule, { logger: false });
  try {
    configureApp(app);
    await app.init();
    const server = app.getHttpServer() as App;
    const [ui, json] = await Promise.all([request(server).get("/v1/docs/"), request(server).get("/v1/docs.json")]);
    return { ui: ui.status, json: json.status };
  } finally {
    await app.close();
    process.env.NODE_ENV = before;
  }
}

describe("API docs", () => {
  it("serves the Swagger UI outside production", async () => {
    expect(await docsAnswers("development")).toEqual({ ui: 200, json: 200 });
  });

  it("serves only the OpenAPI JSON in production, not the UI", async () => {
    expect(await docsAnswers("production")).toEqual({ ui: 404, json: 200 });
  });
});
