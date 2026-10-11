import "reflect-metadata";
import "dotenv/config";
import { parseArgs } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { hashPassword } from "../common/crypto.js";

/*
 * Creates (or promotes) the platform super administrator.
 *   pnpm admin:create --email you@example.com --password '…' --name 'You' [--role owner|admin|support]
 * Re-running for an existing email resets its password and role.
 */
const { values } = parseArgs({
  // pnpm 12 forwards a literal "--" from `pnpm run x -- …`; drop it rather than failing.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { email: { type: "string" }, password: { type: "string" }, name: { type: "string" }, role: { type: "string", default: "owner" } },
});
if (!values.email || !values.password) {
  console.error("Usage: --email <address> --password <password> [--name <name>] [--role owner|admin|support]");
  process.exit(1);
}
if (values.password.length < 10) {
  console.error("Use a password of at least 10 characters.");
  process.exit(1);
}
const role = values.role as "owner" | "admin" | "support";
if (!["owner", "admin", "support"].includes(role)) {
  console.error("--role must be owner, admin or support");
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const email = values.email.trim().toLowerCase();
const passwordHash = await hashPassword(values.password);
const user = await prisma.user.upsert({
  where: { email },
  create: { email, name: values.name ?? "", passwordHash, platformRole: role, emailVerifiedAt: new Date() },
  update: { passwordHash, platformRole: role, emailVerifiedAt: new Date(), suspendedAt: null, ...(values.name ? { name: values.name } : {}) },
});
console.log(`${user.email} is now a platform ${role}. Sign in at the operator console (ADMIN_APP_URL, http://localhost:3602 in development).`);
await prisma.$disconnect();
