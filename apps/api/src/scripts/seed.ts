import "reflect-metadata";
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { DEFAULT_PLANS } from "@growthdesk/shared";
import { PrismaClient } from "../generated/prisma/client.js";

/*
 * Idempotent seed: creates the starting plan catalogue only where a plan with
 * that key does not exist yet, so prices and limits edited in the platform
 * admin are never overwritten by a re-run. No demo customers, no fake data.
 */
export async function seedPlans(prisma: PrismaClient) {
  let created = 0;
  for (const p of DEFAULT_PLANS) {
    const existing = await prisma.plan.findUnique({ where: { key: p.key } });
    if (existing) continue;
    await prisma.plan.create({
      data: {
        key: p.key,
        name: p.name,
        description: p.description,
        sortOrder: p.sortOrder,
        monthlyPriceCents: p.monthlyPriceCents,
        annualPriceCents: p.annualPriceCents,
        trialDays: p.trialDays,
        limits: p.limits,
        features: p.features,
      },
    });
    created += 1;
  }
  return created;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const created = await seedPlans(prisma);
  console.log(`plans: ${created} created, ${DEFAULT_PLANS.length - created} already present`);
  await prisma.$disconnect();
}
