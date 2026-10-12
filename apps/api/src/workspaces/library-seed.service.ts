import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { EMAIL_DESIGN_LIBRARY, TEMPLATE_LIBRARY } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";

const BATCH = 100;

/*
 * The built-in templates and email designs (packages/shared/src/
 * template-library.ts, email-library.ts) are copied into every workspace once.
 * LibrarySeed remembers each key a workspace has been given, so:
 *   - a team's edits to a copied item are never overwritten;
 *   - an item a team deleted or archived is never brought back;
 *   - items added to the library in a later release reach existing
 *     workspaces on the next deploy.
 * Runs when a workspace is created and whenever a worker starts (every
 * deploy). A per-workspace advisory lock keeps parallel workers from
 * copying the same item twice.
 */
@Injectable()
export class LibrarySeedService {
  private readonly log = new Logger("library-seed");

  constructor(private readonly prisma: PrismaService) {}

  /** Copies the library items this workspace has not been given yet. Returns how many were added. */
  async seedWorkspace(workspaceId: string): Promise<{ templates: number; designs: number }> {
    return this.prisma.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`library-seed:${workspaceId}`}))`;
        const given = await tx.librarySeed.findMany({ where: { workspaceId }, select: { kind: true, key: true } });
        const seen = new Set(given.map((g) => `${g.kind}:${g.key}`));
        let templates = 0;
        let designs = 0;

        for (const t of TEMPLATE_LIBRARY) {
          if (seen.has(`template:${t.key}`)) continue;
          const row = await tx.template.create({
            data: { workspaceId, channel: t.channel, name: t.name, category: t.category, subject: t.subject, body: t.body, libraryKey: t.key },
          });
          await tx.templateVersion.create({ data: { workspaceId, templateId: row.id, version: 1, subject: row.subject, body: row.body } });
          await tx.librarySeed.create({ data: { workspaceId, kind: "template", key: t.key } });
          templates++;
        }
        for (const d of EMAIL_DESIGN_LIBRARY) {
          if (seen.has(`design:${d.key}`)) continue;
          await tx.emailDesign.create({ data: { workspaceId, name: d.name, blocks: d.blocks as never, theme: d.theme as never, libraryKey: d.key } });
          await tx.librarySeed.create({ data: { workspaceId, kind: "design", key: d.key } });
          designs++;
        }
        return { templates, designs };
      },
      { timeout: 60_000 },
    );
  }

  /** Seeds every live workspace. Safe to run any number of times. */
  async seedAll(): Promise<{ workspaces: number; templates: number; designs: number }> {
    const total = { workspaces: 0, templates: 0, designs: 0 };
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.db.workspace.findMany({
        where: { deletedAt: null },
        select: { id: true },
        orderBy: { id: "asc" },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!rows.length) break;
      for (const w of rows) {
        try {
          const res = await this.seedWorkspace(w.id);
          if (res.templates || res.designs) total.workspaces++;
          total.templates += res.templates;
          total.designs += res.designs;
        } catch (e) {
          this.log.warn(`workspace ${w.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      cursor = rows[rows.length - 1]!.id;
    }
    return total;
  }
}

/** Runs the library seed when a worker starts, so each deploy brings new library items to existing workspaces. */
@Injectable()
export class LibrarySeedRunner implements OnApplicationBootstrap {
  private readonly log = new Logger("library-seed");

  constructor(
    private readonly seeds: LibrarySeedService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.RUN_WORKERS) return;
    // In the background: a large install must not hold up the worker's start.
    void this.seeds
      .seedAll()
      .then((r) => {
        if (r.templates || r.designs) this.log.log(`Added ${r.templates} templates and ${r.designs} designs to ${r.workspaces} workspaces`);
      })
      .catch((e) => this.log.error(`library seed failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}
