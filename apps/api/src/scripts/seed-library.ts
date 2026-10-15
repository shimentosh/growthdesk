import "reflect-metadata";
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import { LibrarySeedService } from "../workspaces/library-seed.service.js";

/*
 * Copies new built-in templates and email designs into every workspace. The
 * worker does this on start too; this is for a deploy step that wants it done
 * (and reported) before traffic moves over. Idempotent.
 */
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const seeds = new LibrarySeedService({ db: prisma, unscoped: prisma } as unknown as PrismaService);
const added = await seeds.ensureBuiltInDesigns();
if (added) console.log(`Template library: added ${added} built-in designs.`);
const res = await seeds.seedAll();
console.log(`Library: added ${res.templates} templates and ${res.designs} designs to ${res.workspaces} workspaces.`);
await prisma.$disconnect();
