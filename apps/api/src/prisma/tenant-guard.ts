import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

/*
 * Defence in depth for tenant isolation.
 *
 * Application code is expected to scope every query by workspace; this guard
 * makes forgetting to do so a loud failure rather than a silent leak. Any
 * read, update, delete or upsert on a tenant-owned model must name a
 * workspace in its top-level `where` (directly, inside a compound unique key,
 * or in a top-level AND), and any create must carry `workspaceId`. Otherwise
 * the query throws TenantScopeError before it reaches the database.
 *
 * Code that legitimately crosses tenants — routing an inbound webhook to its
 * workspace, platform administration, schedulers that find due work — uses
 * PrismaService.unscoped and says so at the call site.
 */

export class TenantScopeError extends Error {
  constructor(model: string, operation: string) {
    super(`Tenant guard: ${model}.${operation} was called without a workspace scope`);
    this.name = "TenantScopeError";
  }
}

/** Models whose rows belong to exactly one workspace. Identity, billing-account and platform models are not listed. */
export const TENANT_MODELS = new Set<string>([
  "Company",
  "Contact",
  "ContactIdentifier",
  "ContactSource",
  "Tag",
  "ContactTag",
  "CompanyTag",
  "CustomFieldDefinition",
  "SavedView",
  "Note",
  "Activity",
  "Import",
  "DuplicateCandidate",
  "Suppression",
  "ConsentEvent",
  "MarketingList",
  "ListMembership",
  "EspConnection",
  "SendingDomain",
  "EmailDesign",
  "MarketingCampaign",
  "MarketingSend",
  "Pipeline",
  "PipelineStage",
  "Deal",
  "DealStageChange",
  "Meeting",
  "Task",
  "Mailbox",
  "MailboxDailyCount",
  "Template",
  "TemplateVersion",
  "Sequence",
  "SequenceStep",
  "Campaign",
  "CampaignMailbox",
  "Enrollment",
  "StepExecution",
  "Conversation",
  "Message",
  "MessageEvent",
  "ConversationNote",
  "ChannelIntegration",
  "Call",
  "CallScript",
  "Workflow",
  "WorkflowRun",
  "DomainEvent",
  "Notification",
  "WebhookEndpoint",
  "WebhookDelivery",
  "IdempotencyKey",
  "AiUsage",
  "AiCache",
  "WorkspaceExport",
  "LibrarySeed",
]);

const WHERE_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);

const CREATE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function namesWorkspace(value: unknown): boolean {
  if (typeof value === "string" && value.length > 0) return true;
  if (!isObj(value)) return false;
  if (typeof value.equals === "string") return true;
  if (Array.isArray(value.in) && value.in.length > 0 && value.in.every((v) => typeof v === "string")) return true;
  return false;
}

export function whereIsScoped(where: unknown): boolean {
  if (!isObj(where)) return false;
  if (namesWorkspace(where.workspaceId)) return true;
  for (const [key, value] of Object.entries(where)) {
    if (key.includes("workspaceId") && key.includes("_") && isObj(value) && namesWorkspace(value.workspaceId)) return true;
  }
  const and = where.AND;
  if (Array.isArray(and)) return and.some(whereIsScoped);
  if (isObj(and)) return whereIsScoped(and);
  return false;
}

function dataIsScoped(data: unknown): boolean {
  // An empty batch writes nothing, so it cannot cross a tenant boundary.
  if (Array.isArray(data)) return data.every(dataIsScoped);
  if (!isObj(data)) return false;
  if (typeof data.workspaceId === "string" && data.workspaceId.length > 0) return true;
  const ws = data.workspace;
  return isObj(ws) && isObj(ws.connect) && typeof ws.connect.id === "string";
}

export function assertScoped(model: string | undefined, operation: string, args: unknown): void {
  if (!model || !TENANT_MODELS.has(model)) return;
  const a = (isObj(args) ? args : {}) as Obj;
  if (WHERE_OPERATIONS.has(operation)) {
    if (!whereIsScoped(a.where)) throw new TenantScopeError(model, operation);
    if (operation === "upsert" && !dataIsScoped(a.create)) throw new TenantScopeError(model, operation);
    return;
  }
  if (CREATE_OPERATIONS.has(operation)) {
    if (!dataIsScoped(a.data)) throw new TenantScopeError(model, operation);
  }
}

export function withTenantGuard(client: PrismaClient) {
  return client.$extends(
    Prisma.defineExtension({
      name: "tenant-guard",
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            assertScoped(model, operation, args);
            return query(args);
          },
        },
      },
    }),
  );
}

export type ScopedClient = ReturnType<typeof withTenantGuard>;
