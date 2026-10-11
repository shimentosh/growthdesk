import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import type { RequestContext } from "../common/context.js";

export type AuditInput = {
  workspaceId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
};

/*
 * The audit trail for workspace security events and every platform-admin
 * action. Platform-admin actions against a customer are filed under the
 * customer's workspace (LinkDesk filed them under the admin's own, which hid
 * them from the customer's log). Never throws: a failed audit write is logged
 * and must not undo the action it describes.
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger("audit");

  constructor(private readonly prisma: PrismaService) {}

  async record(ctx: RequestContext | null, input: AuditInput, actorType?: "user" | "platform_admin" | "api_key" | "system") {
    try {
      await this.prisma.db.auditEvent.create({
        data: {
          workspaceId: input.workspaceId ?? ctx?.workspace?.id ?? null,
          actorUserId: ctx?.identity?.userId ?? null,
          actorType: actorType ?? (ctx?.apiKey ? "api_key" : ctx?.identity ? "user" : "system"),
          action: input.action,
          targetType: input.targetType ?? "",
          targetId: input.targetId ?? "",
          metadata: (input.metadata ?? {}) as never,
          ip: ctx?.ip ?? "",
        },
      });
    } catch (e) {
      this.log.error(`could not record ${input.action}`, e instanceof Error ? e.stack : String(e));
    }
  }
}
