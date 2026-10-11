import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Query as Q, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import {
  BulkContactAction,
  CompanyInput,
  ContactFilter,
  ContactInput,
  CustomFieldInput,
  ImportStartInput,
  ListQuery,
  MergeContactsInput,
  NoteInput,
  SavedViewInput,
  SuppressionInput,
  TagInput,
  text,
  patchOf,
} from "@growthdesk/shared";
import { ApiKeyScope, Body, Ctx, Permission, Query, Raw, parseWith } from "../common/decorators.js";
import { ws, type RequestContext } from "../common/context.js";
import { badRequest } from "../common/errors.js";
import { ContactsService } from "./contacts.service.js";
import { CompaniesService } from "./companies.service.js";
import { CrmExtrasService } from "./crm-extras.service.js";
import { ImportsService } from "./imports.service.js";
import { SuppressionService } from "./suppression.service.js";
import { ConsentService } from "./consent.service.js";

const ContactListQuery = ListQuery.extend({ filter: z.string().max(5000).optional(), viewId: z.string().uuid().optional() });
const SearchQuery = ListQuery.extend({ q: text(200).optional() });
const ImportPreviewInput = z.object({ csv: z.string().min(1).max(15_000_000) });
const NoteTarget = z.object({ body: z.string().trim().min(1).max(10000), pinned: z.boolean().optional() });

@ApiTags("crm")
@Controller("workspaces/:workspaceId")
export class CrmController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly companies: CompaniesService,
    private readonly extras: CrmExtrasService,
    private readonly imports: ImportsService,
    private readonly suppression: SuppressionService,
    private readonly consent: ConsentService,
  ) {}

  private async filterFrom(ctx: RequestContext, raw?: string, viewId?: string) {
    let base: unknown = {};
    if (viewId) base = (await this.extras.getView(ctx, viewId)).filters;
    let extra: unknown = {};
    if (raw) {
      try {
        extra = JSON.parse(raw);
      } catch {
        throw badRequest("filter must be JSON");
      }
    }
    return parseWith(ContactFilter, { ...(base as object), ...(extra as object) });
  }

  // ─── Contacts ──────────────────────────────────────────────────────────────

  @ApiKeyScope("contacts:read")
  @Permission("contacts.read")
  @Get("contacts")
  async listContacts(@Ctx() ctx: RequestContext, @Query(ContactListQuery) q: z.infer<typeof ContactListQuery>) {
    const filter = await this.filterFrom(ctx, q.filter, q.viewId);
    return this.contacts.list(ctx, filter, q.page, q.pageSize, q.sort, q.dir);
  }

  @ApiKeyScope("contacts:write")
  @Permission("contacts.write")
  @Post("contacts")
  createContact(@Ctx() ctx: RequestContext, @Body(ContactInput) body: z.infer<typeof ContactInput>) {
    return this.contacts.create(ctx, body);
  }

  @Permission("contacts.export")
  @Raw()
  @Get("contacts/export")
  async exportContacts(@Ctx() ctx: RequestContext, @Q("filter") filter: string | undefined, @Q("viewId") viewId: string | undefined, @Res() res: Response) {
    const csv = await this.imports.exportCsv(ctx, await this.filterFrom(ctx, filter, viewId));
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader("cache-control", "no-store");
    res.send(csv);
  }

  @Permission("contacts.read")
  @Get("contacts/duplicates")
  duplicates(@Ctx() ctx: RequestContext) {
    return this.contacts.duplicates(ctx);
  }

  @Permission("contacts.delete")
  @HttpCode(200)
  @Post("contacts/duplicates/:id/dismiss")
  async dismissDuplicate(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.contacts.dismissDuplicate(ctx, id);
    return { dismissed: true };
  }

  @Permission("contacts.delete")
  @HttpCode(200)
  @Post("contacts/merge")
  merge(@Ctx() ctx: RequestContext, @Body(MergeContactsInput) body: z.infer<typeof MergeContactsInput>) {
    return this.contacts.merge(ctx, body.primaryId, body.duplicateIds);
  }

  @Permission("contacts.write")
  @HttpCode(200)
  @Post("contacts/bulk")
  bulk(@Ctx() ctx: RequestContext, @Body(BulkContactAction) body: z.infer<typeof BulkContactAction>) {
    if (body.action === "delete" && !ws(ctx).permissions.includes("contacts.delete")) throw badRequest("Your role cannot delete contacts");
    if (body.action === "enroll") throw badRequest("Use POST /campaigns/:id/enroll to enroll contacts");
    return this.contacts.bulk(ctx, body);
  }

  @ApiKeyScope("contacts:read")
  @Permission("contacts.read")
  @Get("contacts/:id")
  getContact(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.contacts.get(ctx, id);
  }

  @ApiKeyScope("contacts:write")
  @Permission("contacts.write")
  @Patch("contacts/:id")
  updateContact(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(ContactInput) body: z.infer<typeof ContactInput>) {
    return this.contacts.update(ctx, id, body);
  }

  @Permission("contacts.delete")
  @Delete("contacts/:id")
  deleteContact(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.contacts.remove(ctx, [id]);
  }

  /** Every change to the contact's marketing consent, newest first — the proof behind consentStatus. */
  @Permission("contacts.read")
  @Get("contacts/:id/consent")
  async contactConsent(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.contacts.get(ctx, id); // 404 unless this caller may see the contact
    return this.consent.history(ws(ctx).id, id);
  }

  @Permission("contacts.read")
  @Get("contacts/:id/timeline")
  contactTimeline(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.extras.timeline(ctx, { contactId: id });
  }

  @Permission("contacts.read")
  @Get("contacts/:id/notes")
  contactNotes(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.extras.notes(ctx, { contactId: id });
  }

  @ApiKeyScope("contacts:write")
  @Permission("contacts.write")
  @Post("contacts/:id/notes")
  addContactNote(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(NoteTarget) body: z.infer<typeof NoteTarget>) {
    return this.extras.addNote(ctx, { contactId: id }, body.body, body.pinned);
  }

  // ─── Companies ─────────────────────────────────────────────────────────────

  @ApiKeyScope("contacts:read")
  @Permission("contacts.read")
  @Get("companies")
  listCompanies(@Ctx() ctx: RequestContext, @Query(SearchQuery) q: z.infer<typeof SearchQuery>) {
    return this.companies.list(ctx, q.q, q.page, q.pageSize, q.sort, q.dir);
  }

  @ApiKeyScope("contacts:write")
  @Permission("contacts.write")
  @Post("companies")
  createCompany(@Ctx() ctx: RequestContext, @Body(CompanyInput) body: z.infer<typeof CompanyInput>) {
    return this.companies.create(ctx, body);
  }

  @ApiKeyScope("contacts:read")
  @Permission("contacts.read")
  @Get("companies/:id")
  getCompany(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.companies.get(ctx, id);
  }

  @ApiKeyScope("contacts:write")
  @Permission("contacts.write")
  @Patch("companies/:id")
  updateCompany(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(CompanyInput)) body: Partial<z.infer<typeof CompanyInput>>) {
    return this.companies.update(ctx, id, body);
  }

  @Permission("contacts.delete")
  @Delete("companies/:id")
  async deleteCompany(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.companies.remove(ctx, id);
    return { deleted: true };
  }

  @ApiKeyScope("contacts:write")
  @Permission("contacts.write")
  @Post("companies/:id/notes")
  addCompanyNote(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(NoteTarget) body: z.infer<typeof NoteTarget>) {
    return this.extras.addNote(ctx, { companyId: id }, body.body, body.pinned);
  }

  // ─── Notes ─────────────────────────────────────────────────────────────────

  @Permission("contacts.write", "deals.write")
  @Patch("notes/:id")
  async updateNote(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(NoteInput)) body: Partial<z.infer<typeof NoteInput>>) {
    await this.extras.updateNote(ctx, id, body);
    return { updated: true };
  }

  @Permission("contacts.write", "deals.write")
  @Delete("notes/:id")
  async deleteNote(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.extras.deleteNote(ctx, id);
    return { deleted: true };
  }

  // ─── Tags, fields, views ──────────────────────────────────────────────────

  @ApiKeyScope("contacts:read")
  @Permission("contacts.read")
  @Get("tags")
  tags(@Ctx() ctx: RequestContext) {
    return this.extras.tags(ctx);
  }

  @Permission("contacts.write")
  @Post("tags")
  createTag(@Ctx() ctx: RequestContext, @Body(TagInput) body: z.infer<typeof TagInput>) {
    return this.extras.createTag(ctx, body.name, body.color);
  }

  @Permission("contacts.write")
  @Patch("tags/:id")
  async updateTag(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(TagInput)) body: Partial<z.infer<typeof TagInput>>) {
    await this.extras.updateTag(ctx, id, body.name, body.color);
    return { updated: true };
  }

  @Permission("contacts.delete")
  @Delete("tags/:id")
  async deleteTag(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.extras.deleteTag(ctx, id);
    return { deleted: true };
  }

  @Permission("contacts.read")
  @Get("custom-fields")
  fields(@Ctx() ctx: RequestContext, @Q("entity") entity?: string) {
    return this.extras.fields(ctx, entity);
  }

  @Permission("settings.manage")
  @Post("custom-fields")
  createField(@Ctx() ctx: RequestContext, @Body(CustomFieldInput) body: z.infer<typeof CustomFieldInput>) {
    return this.extras.createField(ctx, body);
  }

  @Permission("settings.manage")
  @Patch("custom-fields/:id")
  async updateField(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(patchOf(CustomFieldInput.pick({ label: true, options: true }))) body: { label?: string; options?: string[] }) {
    await this.extras.updateField(ctx, id, body);
    return { updated: true };
  }

  @Permission("settings.manage")
  @Delete("custom-fields/:id")
  async deleteField(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.extras.deleteField(ctx, id);
    return { deleted: true };
  }

  @Permission("contacts.read", "deals.read", "tasks.read")
  @Get("views")
  views(@Ctx() ctx: RequestContext, @Q("entity") entity = "contact") {
    return this.extras.views(ctx, entity);
  }

  @Permission("contacts.read", "deals.read", "tasks.read")
  @Post("views")
  createView(@Ctx() ctx: RequestContext, @Body(SavedViewInput) body: z.infer<typeof SavedViewInput>) {
    return this.extras.createView(ctx, body);
  }

  @Permission("contacts.read", "deals.read", "tasks.read")
  @Delete("views/:id")
  async deleteView(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.extras.deleteView(ctx, id);
    return { deleted: true };
  }

  // ─── Suppressions ─────────────────────────────────────────────────────────

  @Permission("contacts.read")
  @Get("suppressions")
  suppressions(@Ctx() ctx: RequestContext, @Query(SearchQuery) q: z.infer<typeof SearchQuery>) {
    return this.suppression.list(ws(ctx).id, q.q, q.page, q.pageSize);
  }

  @Permission("contacts.write")
  @Post("suppressions")
  addSuppression(@Ctx() ctx: RequestContext, @Body(SuppressionInput) body: z.infer<typeof SuppressionInput>) {
    return this.suppression.add(ws(ctx).id, body.kind, body.value, body.reason, "manual", ctx.identity?.userId ?? null, undefined, body.scope);
  }

  @Permission("contacts.delete")
  @Delete("suppressions/:id")
  async removeSuppression(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    await this.suppression.remove(ws(ctx).id, id);
    return { deleted: true };
  }

  // ─── Imports ───────────────────────────────────────────────────────────────

  @Permission("contacts.import")
  @HttpCode(200)
  @Post("imports/preview")
  preview(@Body(ImportPreviewInput) body: z.infer<typeof ImportPreviewInput>) {
    return this.imports.preview(body.csv);
  }

  @Permission("contacts.import")
  @Post("imports")
  startImport(@Ctx() ctx: RequestContext, @Body(ImportStartInput) body: z.infer<typeof ImportStartInput>) {
    return this.imports.start(ctx, body);
  }

  @Permission("contacts.import")
  @Get("imports")
  listImports(@Ctx() ctx: RequestContext) {
    return this.imports.list(ctx);
  }

  @Permission("contacts.import")
  @Get("imports/:id")
  getImport(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.imports.get(ctx, id);
  }

  @Permission("contacts.import")
  @HttpCode(200)
  @Post("imports/:id/retry")
  retryImport(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.imports.retry(ctx, id);
  }
}
