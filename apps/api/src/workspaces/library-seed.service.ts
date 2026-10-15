import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { TEMPLATE_LIBRARY } from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { ensureBuiltInDesigns, seedableBuiltInDesigns, type SeedableDesign } from "../design-library/builtins.js";

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
 *
 * Designs come from the admin-managed library (PlatformEmailDesign), but only
 * the built-in keys and only while published: an admin's edit to a built-in
 * reaches new workspaces; entries admins add are offered in the gallery
 * instead of being copied everywhere (design-library/builtins.ts).
 */
@Injectable()
export class LibrarySeedService {
  private readonly log = new Logger("library-seed");

  constructor(private readonly prisma: PrismaService) {}

  /** Copies the library items this workspace has not been given yet. Returns how many were added. */
  async seedWorkspace(workspaceId: string, builtInDesigns?: SeedableDesign[]): Promise<{ templates: number; designs: number }> {
    const library = builtInDesigns ?? (await seedableBuiltInDesigns(this.prisma.db));
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
        for (const d of library) {
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
    const designs = await seedableBuiltInDesigns(this.prisma.db);
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
          const res = await this.seedWorkspace(w.id, designs);
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

  /** Puts any built-in design missing from the admin-managed library into it (see design-library/builtins.ts). */
  ensureBuiltInDesigns(): Promise<number> {
    return ensureBuiltInDesigns(this.prisma.db);
  }
}

/**
 * On every start (API and worker): the built-in designs into the platform
 * library. On a worker start: the library seed, so each deploy brings new
 * library items to existing workspaces.
 */
@Injectable()
export class LibrarySeedRunner implements OnApplicationBootstrap {
  private readonly log = new Logger("library-seed");

  constructor(
    private readonly seeds: LibrarySeedService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap() {
    // Awaited: one small insert, and the gallery and the seed below read its rows. A failure must not stop the start.
    try {
      const added = await this.seeds.ensureBuiltInDesigns();
      if (added) this.log.log(`Added ${added} built-in designs to the template library`);
    } catch (e) {
      this.log.error(`design library bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
