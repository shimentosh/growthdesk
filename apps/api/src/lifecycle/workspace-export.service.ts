import { Inject, Injectable, Logger } from "@nestjs/common";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Response } from "express";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AuditService } from "../core/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { QUEUES, Queues } from "../queues/queues.js";
import { actorId, ws, type RequestContext } from "../common/context.js";
import { conflict, notFound } from "../common/errors.js";
import type { WorkspaceExport } from "../generated/prisma/client.js";

const DAY = 86_400_000;
const PAGE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where one workspace's export files live: DATA_EXPORT_DIR/<workspaceId>/. */
export const exportDirFor = (config: Pick<AppConfig, "DATA_EXPORT_DIR">, workspaceId: string) => path.resolve(config.DATA_EXPORT_DIR, workspaceId);

/**
 * What a full export contains: every customer record table, by its Prisma
 * delegate. Left out on purpose: mailboxes, channel connections, sending
 * domains, the email service and webhooks (they hold sealed credentials and
 * are configuration, not records), and internal bookkeeping (events, AI
 * cache, idempotency keys). Messages are metadata only; their bodies stay in
 * the app (a single contact's export, below, includes them).
 */
const SECTIONS: { key: string; delegate: string; omit?: Record<string, true>; keys?: string[] }[] = [
  { key: "companies", delegate: "company" },
  { key: "contacts", delegate: "contact" },
  { key: "contactIdentifiers", delegate: "contactIdentifier" },
  { key: "contactSources", delegate: "contactSource" },
  { key: "tags", delegate: "tag" },
  { key: "contactTags", delegate: "contactTag", keys: ["contactId", "tagId"] },
  { key: "companyTags", delegate: "companyTag", keys: ["companyId", "tagId"] },
  { key: "customFields", delegate: "customFieldDefinition" },
  { key: "notes", delegate: "note" },
  { key: "activities", delegate: "activity" },
  { key: "consentEvents", delegate: "consentEvent" },
  { key: "suppressions", delegate: "suppression" },
  { key: "pipelines", delegate: "pipeline" },
  { key: "pipelineStages", delegate: "pipelineStage" },
  { key: "deals", delegate: "deal" },
  { key: "dealStageChanges", delegate: "dealStageChange" },
  { key: "meetings", delegate: "meeting" },
  { key: "tasks", delegate: "task" },
  { key: "calls", delegate: "call" },
  { key: "callScripts", delegate: "callScript" },
  { key: "conversations", delegate: "conversation" },
  { key: "messages", delegate: "message", omit: { bodyText: true, bodyHtml: true, references: true } },
  { key: "templates", delegate: "template" },
  { key: "templateVersions", delegate: "templateVersion" },
  { key: "sequences", delegate: "sequence" },
  { key: "sequenceSteps", delegate: "sequenceStep" },
  { key: "campaigns", delegate: "campaign" },
  { key: "enrollments", delegate: "enrollment" },
  { key: "marketingLists", delegate: "marketingList" },
  { key: "listMemberships", delegate: "listMembership" },
  { key: "emailDesigns", delegate: "emailDesign" },
  { key: "marketingCampaigns", delegate: "marketingCampaign" },
  { key: "workflows", delegate: "workflow" },
  { key: "imports", delegate: "import", omit: { rows: true } },
];

type Delegate = { findMany(args: unknown): Promise<Record<string, unknown>[]> };

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function exportDto(e: WorkspaceExport, now = Date.now()) {
  const expired = e.status === "expired" || (e.status === "ready" && Boolean(e.expiresAt && e.expiresAt.getTime() <= now));
  return {
    id: e.id,
    status: expired ? "expired" : e.status,
    fileName: e.fileName,
    sizeBytes: e.sizeBytes,
    counts: e.counts,
    error: e.error,
    requestedById: e.requestedById,
    createdAt: e.createdAt,
    finishedAt: e.finishedAt,
    expiresAt: e.expiresAt,
  };
}

/*
 * Full workspace data export (docs/PRIVACY_OPS.md "Data exports").
 *
 * POST queues a `lifecycle/export` job; the worker streams every section as
 * one gzipped JSON document into DATA_EXPORT_DIR/<workspaceId>/<exportId>.json.gz
 * (no S3 needed), then notifies the requester (bell and email) with a link to
 * Settings → Data & privacy. The file is served only by the authenticated,
 * permission-checked download route, and only until `expiresAt`
 * (DATA_EXPORT_DAYS); the daily `export-cleanup` job deletes it after that.
 */
@Injectable()
export class WorkspaceExportService {
  private readonly log = new Logger("workspace-export");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly queues: Queues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private fileFor(workspaceId: string, exportId: string) {
    return path.join(exportDirFor(this.config, workspaceId), `${exportId}.json.gz`);
  }

  async request(ctx: RequestContext) {
    const w = ws(ctx);
    const running = await this.prisma.db.workspaceExport.findFirst({ where: { workspaceId: w.id, status: { in: ["pending", "processing"] } } });
    if (running) throw conflict("An export is already being prepared. You'll be notified when it's ready.");
    const row = await this.prisma.db.workspaceExport.create({ data: { workspaceId: w.id, requestedById: actorId(ctx) } });
    await this.queues.add(QUEUES.lifecycle, "export", { workspaceId: w.id, exportId: row.id }, { jobId: `export-${row.id}`, attempts: 3 });
    await this.audit.record(ctx, { action: "workspace.export_requested", targetType: "workspace_export", targetId: row.id });
    return exportDto(row);
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.db.workspaceExport.findMany({ where: { workspaceId: ws(ctx).id }, orderBy: { createdAt: "desc" }, take: 10 });
    return { items: rows.map((r) => exportDto(r)), retentionDays: this.config.DATA_EXPORT_DAYS };
  }

  /** Streams a ready, unexpired export file. */
  async download(ctx: RequestContext, id: string, res: Response) {
    const w = ws(ctx);
    if (!UUID.test(id)) throw notFound("That export");
    const row = await this.prisma.db.workspaceExport.findFirst({ where: { id, workspaceId: w.id } });
    if (!row || row.status !== "ready" || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) throw notFound("That export (it may have expired)");
    const file = this.fileFor(w.id, row.id);
    const info = await stat(file).catch(() => null);
    if (!info) throw notFound("That export file (it may have expired)");
    await this.audit.record(ctx, { action: "workspace.export_downloaded", targetType: "workspace_export", targetId: row.id });
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Length", String(info.size));
    res.setHeader("Content-Disposition", `attachment; filename="${row.fileName}"`);
    res.setHeader("Cache-Control", "no-store");
    await pipeline(createReadStream(file), res);
  }

  // ─── Worker side ───────────────────────────────────────────────────────────

  /** Builds one export. Re-running a job after a crash starts the file again from scratch. */
  async build(workspaceId: string, exportId: string): Promise<{ status: string }> {
    const claimed = await this.prisma.db.workspaceExport.updateMany({
      where: { id: exportId, workspaceId, status: { in: ["pending", "processing"] } },
      data: { status: "processing" },
    });
    if (!claimed.count) return { status: "skipped" };
    const workspace = await this.prisma.db.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace || workspace.deletedAt) {
      await this.prisma.db.workspaceExport.updateMany({ where: { id: exportId, workspaceId }, data: { status: "failed", error: "The workspace was deleted." } });
      return { status: "failed" };
    }

    const dir = exportDirFor(this.config, workspaceId);
    await mkdir(dir, { recursive: true });
    const final = this.fileFor(workspaceId, exportId);
    const partial = `${final}.part`;
    const gz = createGzip();
    const written = pipeline(gz, createWriteStream(partial));
    const write = async (s: string) => {
      if (!gz.write(s)) await once(gz, "drain");
    };
    const counts: Record<string, number> = {};
    try {
      const members = await this.prisma.db.membership.findMany({
        where: { workspaceId },
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: "asc" },
      });
      await write(
        `{"format":"growthdesk-workspace-export","version":1,"exportedAt":${json(new Date())},"workspace":${json({
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          businessType: workspace.businessType,
          timezone: workspace.timezone,
          currency: workspace.currency,
          legalName: workspace.legalName,
          postalAddress: workspace.postalAddress,
          settings: workspace.settings,
          createdAt: workspace.createdAt,
        })},"members":${json(members.map((m) => ({ userId: m.userId, email: m.user.email, name: m.user.name, role: m.role, joinedAt: m.createdAt })))},"sections":{`,
      );
      counts.members = members.length;
      const db = this.prisma.db as unknown as Record<string, Delegate>;
      for (const [i, section] of SECTIONS.entries()) {
        await write(`${i ? "," : ""}${json(section.key)}:[`);
        let cursor: string | null = null;
        let n = 0;
        for (;;) {
          // Tables with an id page by cursor; the two join tables without one page by offset over their key.
          const page = await db[section.delegate]!.findMany({
            where: { workspaceId },
            orderBy: (section.keys ?? ["id"]).map((k) => ({ [k]: "asc" })),
            take: PAGE,
            ...(section.keys ? { skip: n } : cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            ...(section.omit ? { omit: section.omit } : {}),
          });
          for (const r of page) await write(`${n++ ? "," : ""}${json(r)}`);
          if (page.length < PAGE) break;
          cursor = String(page[page.length - 1]!.id);
        }
        await write("]");
        counts[section.key] = n;
      }
      await write("}}");
      gz.end();
      await written;
      await rename(partial, final);
    } catch (e) {
      gz.destroy();
      await written.catch(() => undefined);
      await rm(partial, { force: true });
      throw e;
    }

    const size = (await stat(final)).size;
    const expiresAt = new Date(Date.now() + this.config.DATA_EXPORT_DAYS * DAY);
    const fileName = `${workspace.slug}-export-${new Date().toISOString().slice(0, 10)}.json.gz`;
    const row = await this.prisma.db.workspaceExport.update({
      where: { id: exportId, workspaceId },
      data: { status: "ready", fileName, sizeBytes: size, counts, expiresAt, finishedAt: new Date(), error: "" },
    });
    if (row.requestedById) {
      await this.notifications.notify(workspaceId, [row.requestedById], {
        type: "export.ready",
        title: "Your workspace export is ready",
        body: `Download it from Settings → Data & privacy before ${expiresAt.toISOString().slice(0, 10)}, when it is deleted.`,
        link: `/w/${workspaceId}/settings/data`,
        email: true,
      });
    }
    return { status: "ready" };
  }

  async markFailed(workspaceId: string, exportId: string, message: string) {
    await this.prisma.db.workspaceExport.updateMany({ where: { id: exportId, workspaceId }, data: { status: "failed", error: message.slice(0, 500), finishedAt: new Date() } });
  }

  /** Deletes export files past their download window. */
  async cleanupExpired(now = new Date()): Promise<number> {
    // Unscoped by necessity: a daily sweep across every workspace; each file is removed by its own row's workspace id.
    const rows = await this.prisma.unscoped.workspaceExport.findMany({ where: { status: "ready", expiresAt: { lte: now } }, select: { id: true, workspaceId: true }, take: 500 });
    for (const r of rows) {
      await rm(this.fileFor(r.workspaceId, r.id), { force: true });
      await this.prisma.db.workspaceExport.update({ where: { id: r.id, workspaceId: r.workspaceId }, data: { status: "expired" } });
    }
    if (rows.length) this.log.log(`deleted ${rows.length} expired export file(s)`);
    return rows.length;
  }
}
