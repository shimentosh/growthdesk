#!/usr/bin/env node
/*
 * One-time local setup: env files, dependencies, Docker services, database
 * migrations, plan catalogue. Safe to re-run.
 *   pnpm bootstrap
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const run = (cmd, cwd = ".") => {
  console.log(`\n› ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
};

const apiEnv = "apps/api/.env";
if (!existsSync(apiEnv)) {
  const example = readFileSync("apps/api/.env.example", "utf8");
  writeFileSync(apiEnv, example.replace(/^ENCRYPTION_KEY=$/m, `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`).replace(/^ALLOW_PRIVATE_MAIL_HOSTS=false$/m, "ALLOW_PRIVATE_MAIL_HOSTS=true"));
  console.log(`created ${apiEnv} (with a fresh ENCRYPTION_KEY)`);
}
if (!existsSync("apps/web/.env.local") && existsSync("apps/web/.env.example")) {
  copyFileSync("apps/web/.env.example", "apps/web/.env.local");
  console.log("created apps/web/.env.local");
}

run("pnpm install");
run("docker compose up -d --wait");
run("pnpm --filter @growthdesk/shared run build");
run("pnpm --filter @growthdesk/api exec prisma migrate deploy");
run("pnpm --filter @growthdesk/api exec prisma generate");
run("pnpm --filter @growthdesk/api run build");
run("node --enable-source-maps dist/scripts/seed.js", "apps/api");

console.log(`
Growthdesk is set up.

  pnpm dev                    start API (3601), worker and web app (http://localhost:3600)
  pnpm admin:create --email you@example.com --password '…' --name 'You'
                              create your platform super-admin account
  Mailpit (platform emails):  http://localhost:8066
`);
