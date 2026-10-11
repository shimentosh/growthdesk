import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { ADMIN_DATABASE_URL, TEST_DATABASE_NAME, TEST_DATABASE_URL } from "./env.js";

/** Creates the test database if needed and applies every migration to it. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DATABASE_NAME]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
  } finally {
    await admin.end();
  }
  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: ["ignore", "ignore", "inherit"],
  });
}
