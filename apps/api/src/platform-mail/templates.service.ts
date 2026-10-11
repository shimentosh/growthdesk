import { Injectable } from "@nestjs/common";
import {
  EmailBlocks,
  PLATFORM_TEMPLATE_KEYS,
  PLATFORM_TEMPLATES,
  platformTemplateVariables,
  type PlatformEmailTemplateDraft,
  type PlatformTemplateKey,
} from "@growthdesk/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { BrandingService } from "../core/branding.service.js";
import { AuditService } from "../core/audit.service.js";
import { me, type RequestContext } from "../common/context.js";
import { badRequest, conflict, notFound, tooMany } from "../common/errors.js";
import { PLATFORM_TEMPLATE_DEFAULTS, type PlatformTemplateContent } from "./catalog.js";
import { type Brand, renderPlatformTemplate, sampleVars, templateProblems } from "./render.js";
import { PlatformMailService } from "./platform-mail.service.js";

/*
 * System email templates: the code default (catalog.ts) unless an admin has
 * published a version, in which case the active PlatformEmailTemplateVersion.
 * Publishing creates version N+1 and activates it; reset clears the active
 * version (history is kept); activate rolls back to any earlier version.
 * Every change is audited as a platform_admin action.
 */

export const TEST_SENDS_PER_HOUR = 10;

type VersionRow = { id: string; version: number; subject: string; preheader: string; blocks: unknown; note: string; createdById: string | null; createdAt: Date };

@Injectable()
export class PlatformTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branding: BrandingService,
    private readonly audit: AuditService,
    private readonly mail: PlatformMailService,
  ) {}

  async brand(): Promise<Brand> {
    const b = await this.branding.get();
    return { productName: b.productName, supportEmail: b.supportEmail, primaryColor: b.primaryColor };
  }

  private assertKey(key: string): PlatformTemplateKey {
    if (!(PLATFORM_TEMPLATE_KEYS as readonly string[]).includes(key)) throw notFound("That email template");
    return key as PlatformTemplateKey;
  }

  private content(v: VersionRow): PlatformTemplateContent {
    const blocks = EmailBlocks.safeParse(v.blocks);
    return { subject: v.subject, preheader: v.preheader, blocks: blocks.success ? blocks.data : [] };
  }

  /** What `key` sends right now: the active version, or the code default. */
  async active(key: PlatformTemplateKey): Promise<{ content: PlatformTemplateContent; versionId: string | null }> {
    const t = await this.prisma.db.platformEmailTemplate.findUnique({ where: { key } });
    if (t?.activeVersionId) {
      const v = await this.prisma.db.platformEmailTemplateVersion.findUnique({ where: { id: t.activeVersionId } });
      if (v) {
        const content = this.content(v);
        if (content.blocks.length) return { content, versionId: v.id };
      }
    }
    return { content: PLATFORM_TEMPLATE_DEFAULTS[key], versionId: null };
  }

  /** Renders `key` for sending, with the brand's common variables. */
  async compose(key: PlatformTemplateKey, vars: Record<string, string | null | undefined>) {
    const [{ content, versionId }, brand] = await Promise.all([this.active(key), this.brand()]);
    return { ...renderPlatformTemplate(content, vars, brand), templateVersionId: versionId };
  }

  // ─── Admin ───────────────────────────────────────────────────────────────

  async list() {
    const rows = await this.prisma.db.platformEmailTemplate.findMany({ include: { versions: { select: { id: true, version: true, createdAt: true } } } });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return PLATFORM_TEMPLATE_KEYS.map((key) => {
      const row = byKey.get(key);
      const active = row?.activeVersionId ? row.versions.find((v) => v.id === row.activeVersionId) : undefined;
      return {
        key,
        label: PLATFORM_TEMPLATES[key].label,
        category: PLATFORM_TEMPLATES[key].category,
        customised: Boolean(active),
        activeVersion: active ? { id: active.id, version: active.version, createdAt: active.createdAt } : null,
        versionCount: row?.versions.length ?? 0,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async detail(rawKey: string) {
    const key = this.assertKey(rawKey);
    const row = await this.prisma.db.platformEmailTemplate.findUnique({ where: { key }, include: { versions: { orderBy: { version: "desc" } } } });
    const authorIds = [...new Set((row?.versions ?? []).map((v) => v.createdById).filter((v): v is string => Boolean(v)))];
    const authors = authorIds.length ? await this.prisma.db.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, email: true } }) : [];
    const authorById = new Map(authors.map((a) => [a.id, a]));
    const active = await this.active(key);
    return {
      key,
      label: PLATFORM_TEMPLATES[key].label,
      category: PLATFORM_TEMPLATES[key].category,
      variables: platformTemplateVariables(key),
      required: PLATFORM_TEMPLATES[key].required,
      default: PLATFORM_TEMPLATE_DEFAULTS[key],
      customised: Boolean(active.versionId),
      activeVersionId: active.versionId,
      /** What is sent today (the active version or the default). */
      current: active.content,
      versions: (row?.versions ?? []).map((v) => ({
        id: v.id,
        version: v.version,
        subject: v.subject,
        preheader: v.preheader,
        blocks: this.content(v).blocks,
        note: v.note,
        active: v.id === active.versionId,
        createdAt: v.createdAt,
        createdBy: v.createdById ? (authorById.get(v.createdById) ?? null) : null,
      })),
    };
  }

  private validate(key: PlatformTemplateKey, draft: PlatformEmailTemplateDraft) {
    const problems = templateProblems(key, draft);
    if (problems.length) throw badRequest(problems[0]!, { _: problems.join(" ") });
  }

  async preview(rawKey: string, draft: PlatformEmailTemplateDraft & { vars?: Record<string, string> }) {
    const key = this.assertKey(rawKey);
    const brand = await this.brand();
    const rendered = renderPlatformTemplate(draft, { ...sampleVars(key, brand), ...(draft.vars ?? {}) }, brand);
    return { ...rendered, problems: templateProblems(key, draft) };
  }

  async publish(ctx: RequestContext, rawKey: string, input: PlatformEmailTemplateDraft & { note: string }) {
    const key = this.assertKey(rawKey);
    this.validate(key, input);
    const userId = me(ctx).userId;
    let created: { id: string; version: number };
    try {
      created = await this.prisma.db.$transaction(async (tx) => {
        await tx.platformEmailTemplate.upsert({ where: { key }, create: { key, updatedById: userId }, update: { updatedById: userId } });
        const last = await tx.platformEmailTemplateVersion.findFirst({ where: { templateKey: key }, orderBy: { version: "desc" }, select: { version: true } });
        const v = await tx.platformEmailTemplateVersion.create({
          data: { templateKey: key, version: (last?.version ?? 0) + 1, subject: input.subject, preheader: input.preheader, blocks: input.blocks as never, note: input.note, createdById: userId },
        });
        await tx.platformEmailTemplate.update({ where: { key }, data: { activeVersionId: v.id, updatedById: userId } });
        return { id: v.id, version: v.version };
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw conflict("Someone else published this template at the same moment. Reload and try again.");
      throw e;
    }
    await this.record(ctx, "platform.email_template_published", key, { version: created.version, versionId: created.id, note: input.note || undefined });
    return this.detail(key);
  }

  async reset(ctx: RequestContext, rawKey: string) {
    const key = this.assertKey(rawKey);
    const row = await this.prisma.db.platformEmailTemplate.findUnique({ where: { key } });
    if (row?.activeVersionId) {
      await this.prisma.db.platformEmailTemplate.update({ where: { key }, data: { activeVersionId: null, updatedById: me(ctx).userId } });
      await this.record(ctx, "platform.email_template_reset", key, { previousVersionId: row.activeVersionId });
    }
    return this.detail(key);
  }

  async activate(ctx: RequestContext, rawKey: string, versionId: string) {
    const key = this.assertKey(rawKey);
    const v = await this.prisma.db.platformEmailTemplateVersion.findFirst({ where: { id: versionId, templateKey: key } }).catch(() => null);
    if (!v) throw notFound("That template version");
    const problems = templateProblems(key, this.content(v));
    if (problems.length) throw badRequest(`Version ${v.version} can no longer be used: ${problems[0]}`);
    await this.prisma.db.platformEmailTemplate.update({ where: { key }, data: { activeVersionId: v.id, updatedById: me(ctx).userId } });
    await this.record(ctx, "platform.email_template_activated", key, { version: v.version, versionId: v.id });
    return this.detail(key);
  }

  /** Sends the draft (or what is live) to the signed-in admin, with sample values. 10 per hour per person. */
  async test(ctx: RequestContext, rawKey: string, input: { draft?: PlatformEmailTemplateDraft; vars?: Record<string, string> }) {
    const key = this.assertKey(rawKey);
    const who = me(ctx);
    await this.assertTestAllowance(who.userId);
    let content: PlatformTemplateContent;
    let versionId: string | null = null;
    if (input.draft) {
      this.validate(key, input.draft);
      content = input.draft;
    } else {
      ({ content, versionId } = await this.active(key));
    }
    const brand = await this.brand();
    const rendered = renderPlatformTemplate(content, { ...sampleVars(key, brand), name: who.name, ...(input.vars ?? {}) }, brand);
    const result = await this.mail.sendNow({
      to: who.email,
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
      template: `test:${key}`,
      userId: who.userId,
      templateVersionId: versionId,
    });
    return { ...result, to: who.email };
  }

  /** Test sends (template and settings) share one allowance: 10 per hour per person. */
  async assertTestAllowance(userId: string) {
    const used = await this.prisma.db.emailLog.count({ where: { userId, template: { startsWith: "test:" }, createdAt: { gte: new Date(Date.now() - 3600_000) } } });
    if (used >= TEST_SENDS_PER_HOUR) throw tooMany(`You can send ${TEST_SENDS_PER_HOUR} test emails an hour. Try again later.`);
  }

  private record(ctx: RequestContext, action: string, key: string, metadata: Record<string, unknown>) {
    return this.audit.record(ctx, { workspaceId: null, action, targetType: "platform_email_template", targetId: key, metadata }, "platform_admin");
  }
}
