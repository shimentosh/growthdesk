import { Controller, Delete, Get, Param, Patch, Post, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { z } from "zod";
import { AttachmentListQuery, AttachmentRenameInput, AttachmentUploadInput } from "@growthdesk/shared";
import { Body, Ctx, Permission, Query, Raw } from "../common/decorators.js";
import type { RequestContext } from "../common/context.js";
import { AttachmentsService } from "./attachments.service.js";

/*
 * Files on contacts, companies, deals and quotes. The route lets in anyone
 * who can read (or write) one of those; the service then checks the
 * permission for that record's kind (contacts.* for contacts and companies,
 * deals.*, quotes.*) and that the caller can see the record itself.
 */
const READ = ["contacts.read", "deals.read", "quotes.read"];
const WRITE = ["contacts.write", "deals.write", "quotes.write"];

@ApiTags("attachments")
@Controller("workspaces/:workspaceId/attachments")
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** A record's files, newest first (never the bytes), and the workspace's storage use. */
  @Permission(...READ)
  @Get()
  list(@Ctx() ctx: RequestContext, @Query(AttachmentListQuery) q: z.infer<typeof AttachmentListQuery>) {
    return this.attachments.list(ctx, q.entityType, q.entityId);
  }

  /** One file, base64 in JSON (up to 10 MB). Its type comes from its bytes; programs and scripts are refused. */
  @Permission(...WRITE)
  @Post()
  upload(@Ctx() ctx: RequestContext, @Body(AttachmentUploadInput) body: z.infer<typeof AttachmentUploadInput>) {
    return this.attachments.upload(ctx, body);
  }

  /** The file itself, always as a download. */
  @Permission(...READ)
  @Raw()
  @Get(":id/download")
  download(@Ctx() ctx: RequestContext, @Param("id") id: string, @Res() res: Response) {
    return this.attachments.download(ctx, id, res);
  }

  @Permission(...WRITE)
  @Patch(":id")
  rename(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body(AttachmentRenameInput) body: z.infer<typeof AttachmentRenameInput>) {
    return this.attachments.rename(ctx, id, body.fileName);
  }

  @Permission(...WRITE)
  @Delete(":id")
  remove(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.attachments.remove(ctx, id);
  }
}
