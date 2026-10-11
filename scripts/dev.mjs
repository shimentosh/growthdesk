#!/usr/bin/env node
/*
 * Local development: Docker services, migrations, then the shared package
 * (watch), API (3601), worker, web app (3600) and the operator console
 * (admin, 3602) with prefixed logs.
 * Ctrl+C stops everything this script started (and nothing else).
 */
import { execSync, spawn } from "node:child_process";

execSync("docker compose up -d --wait", { stdio: "inherit" });
execSync("pnpm --filter @growthdesk/shared run build", { stdio: "inherit" });
execSync("pnpm --filter @growthdesk/api exec prisma migrate deploy", { stdio: "inherit" });

const procs = [
  ["shared", "pnpm", ["--filter", "@growthdesk/shared", "run", "dev"], "\x1b[90m"],
  ["api", "pnpm", ["--filter", "@growthdesk/api", "run", "dev"], "\x1b[36m"],
  ["worker", "pnpm", ["--filter", "@growthdesk/api", "run", "dev:worker"], "\x1b[35m"],
  ["web", "pnpm", ["--filter", "@growthdesk/web", "run", "dev"], "\x1b[32m"],
  ["admin", "pnpm", ["--filter", "@growthdesk/admin", "run", "dev"], "\x1b[33m"],
];

const children = procs.map(([name, cmd, args, color]) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "1" } });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => process.stdout.write(`${prefix}exited (${code})\n`));
  return child;
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 3000);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
