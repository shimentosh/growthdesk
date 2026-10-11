import { Injectable } from "@nestjs/common";
import { PlatformAudienceFilter, type PlatformAudienceFilter as Filter } from "@growthdesk/shared";
import type { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import type { RequestContext } from "../common/context.js";
import { conflict, notFound } from "../common/errors.js";
import { audienceFromWhere, storedFilter } from "./audience-sql.js";
import type { PlatformAudienceInput, PlatformAudienceUpdate } from "@growthdesk/shared";

/*
 * Saved audiences for platform marketing. A count is always computed live
 * (the people change; the filter does not), with the marketing rule applied
 * (audience-sql.ts).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SAMPLE_SIZE = 20;

/** A stored filter, normalised through the schema (unknown keys dropped, defaults filled). */
export function normaliseFilter(raw: unknown): Filter {
  const parsed = PlatformAudienceFilter.safeParse(storedFilter(raw));
  return parsed.success ? parsed.data : PlatformAudienceFilter.parse({});
}

@Injectable()
export class AudiencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private record(ctx: RequestContext, action: string, targetId: string, metadata: Record<string, unknown> = {}) {
    return this.audit.record(ctx, { workspaceId: null, action, targetType: "platform_audience", targetId, metadata }, "platform_admin");
  }

  async count(filter: Partial<Filter> | null): Promise<number> {
    const rows = await this.prisma.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n ${audienceFromWhere(filter)}`;
    return rows[0]?.n ?? 0;
  }

  /** Count and a sample of the people an (unsaved) filter reaches. */
  async preview(filter: Filter) {
    const fromWhere = audienceFromWhere(filter);
    const [count, samples] = await Promise.all([
      this.count(filter),
      this.prisma.db.$queryRaw<{ id: string; email: string; name: string; createdAt: Date; lastLoginAt: Date | null; workspaces: number; consentAt: Date | null }[]>`
        SELECT u.id, u.email, u.name, u."createdAt", u."lastLoginAt", p."consentAt",
               (SELECT count(*)::int FROM "Membership" mc WHERE mc."userId" = u.id) AS workspaces
        ${fromWhere} ORDER BY u."createdAt" DESC, u.id DESC LIMIT ${SAMPLE_SIZE}`,
    ]);
    return { count, samples };
  }

  async list() {
    const rows = await this.prisma.db.platformAudience.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { broadcasts: true } } } });
    const counts = await Promise.all(rows.map((r) => this.count(normaliseFilter(r.filter))));
    return rows.map((r, i) => ({ ...this.dto(r), count: counts[i] ?? 0, broadcasts: r._count.broadcasts }));
  }

  async find(id: string) {
    if (!UUID.test(id)) throw notFound("That audience");
    const row = await this.prisma.db.platformAudience.findUnique({ where: { id } });
    if (!row) throw notFound("That audience");
    return row;
  }

  async detail(id: string) {
    const row = await this.find(id);
    return { ...this.dto(row), count: await this.count(normaliseFilter(row.filter)) };
  }

  private dto(r: { id: string; name: string; filter: unknown; createdAt: Date; updatedAt: Date }) {
    return { id: r.id, name: r.name, filter: normaliseFilter(r.filter), createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  async create(ctx: RequestContext, input: z.infer<typeof PlatformAudienceInput>) {
    const row = await this.prisma.db.platformAudience.create({
      data: { name: input.name, filter: input.filter as never, createdById: ctx.identity?.userId ?? null },
    });
    await this.record(ctx, "platform.growth_audience_created", row.id, { name: row.name });
    return this.detail(row.id);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof PlatformAudienceUpdate>) {
    await this.find(id);
    const busy = await this.prisma.db.platformBroadcast.count({ where: { audienceId: id, status: { in: ["scheduled", "sending"] } } });
    if (busy && input.filter) throw conflict("A scheduled or sending broadcast uses this audience. Cancel it before changing who is in the audience.");
    await this.prisma.db.platformAudience.update({
      where: { id },
      data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.filter ? { filter: input.filter as never } : {}) },
    });
    await this.record(ctx, "platform.growth_audience_updated", id, { fields: Object.keys(input) });
    return this.detail(id);
  }

  async remove(ctx: RequestContext, id: string) {
    const row = await this.find(id);
    const busy = await this.prisma.db.platformBroadcast.count({ where: { audienceId: id, status: { in: ["scheduled", "sending"] } } });
    if (busy) throw conflict("A scheduled or sending broadcast uses this audience.");
    await this.prisma.db.platformAudience.delete({ where: { id } });
    await this.record(ctx, "platform.growth_audience_deleted", id, { name: row.name });
    return { ok: true };
  }
}
