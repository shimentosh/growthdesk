import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EmailBlocks, EmailTheme, starterBlocks, type EmailBlock, type EmailDesignInput } from "@growthdesk/shared";
import type { z } from "zod";
import type { EmailDesign } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { notFound } from "../common/errors.js";
import { actorId, ws, type RequestContext } from "../common/context.js";

export const readBlocks = (raw: unknown): EmailBlock[] => {
  const parsed = EmailBlocks.safeParse(raw);
  return parsed.success ? parsed.data : [];
};

/** A stored theme, or {} when it no longer validates (an invalid value renders with the defaults). */
export const readTheme = (raw: unknown): EmailTheme => {
  const parsed = EmailTheme.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
};

const shortId = () => randomUUID().slice(0, 8);

const dto = (d: EmailDesign) => ({ id: d.id, name: d.name, blocks: readBlocks(d.blocks), theme: readTheme(d.theme), fromLibrary: Boolean(d.libraryKey), archivedAt: d.archivedAt, createdAt: d.createdAt, updatedAt: d.updatedAt });

/** Reusable email designs. A campaign copies a design's blocks, so editing a design never changes a sent email. */
@Injectable()
export class DesignsService {
  constructor(private readonly prisma: PrismaService) {}

  private async find(ctx: RequestContext, id: string) {
    const d = await this.prisma.db.emailDesign.findFirst({ where: { id, workspaceId: ws(ctx).id } });
    if (!d) throw notFound("That design");
    return d;
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.db.emailDesign.findMany({ where: { workspaceId: ws(ctx).id, archivedAt: null }, orderBy: { updatedAt: "desc" } });
    return rows.map(dto);
  }

  async get(ctx: RequestContext, id: string) {
    return dto(await this.find(ctx, id));
  }

  /** `libraryKey`: the template library entry it was copied from (design-library). */
  async create(ctx: RequestContext, input: z.infer<typeof EmailDesignInput>, libraryKey?: string) {
    const row = await this.prisma.db.emailDesign.create({
      data: {
        workspaceId: ws(ctx).id,
        name: input.name,
        blocks: (input.blocks ?? starterBlocks(shortId)) as never,
        theme: (input.theme ?? {}) as never,
        createdById: actorId(ctx),
        ...(libraryKey ? { libraryKey } : {}),
      },
    });
    return dto(row);
  }

  async update(ctx: RequestContext, id: string, input: Partial<z.infer<typeof EmailDesignInput>>) {
    await this.find(ctx, id);
    const row = await this.prisma.db.emailDesign.update({
      where: { id, workspaceId: ws(ctx).id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.blocks !== undefined ? { blocks: input.blocks as never } : {}),
        ...(input.theme !== undefined ? { theme: input.theme as never } : {}),
      },
    });
    return dto(row);
  }

  async duplicate(ctx: RequestContext, id: string) {
    const d = await this.find(ctx, id);
    const row = await this.prisma.db.emailDesign.create({ data: { workspaceId: d.workspaceId, name: `${d.name} (copy)`.slice(0, 120), blocks: d.blocks as never, theme: d.theme as never, createdById: actorId(ctx) } });
    return dto(row);
  }

  async archive(ctx: RequestContext, id: string) {
    await this.find(ctx, id);
    await this.prisma.db.emailDesign.update({ where: { id, workspaceId: ws(ctx).id }, data: { archivedAt: new Date() } });
    return { archived: true };
  }
}
