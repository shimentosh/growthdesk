/*
 * Shapes of the deals / pipelines / meetings / tasks responses. Dates arrive
 * as ISO strings and decimals as numbers. Keep these in step with
 * apps/api/src/pipeline/pipeline.service.ts and apps/api/src/tasks/tasks.service.ts.
 */
import type { DealStatus, ForecastCategory, MeetingStatus, Priority, StageKind, TaskStatus, TaskType } from "@growthdesk/shared";

/** A pipeline stage row (Prisma PipelineStage). `color` is a name such as "gray" or "blue". */
export type PipelineStage = {
  id: string;
  workspaceId: string;
  pipelineId: string;
  name: string;
  position: number;
  kind: StageKind;
  probability: number;
  color: string;
  /** Days without progress in this stage before a deal is stale; null = never. */
  rotDays: number | null;
  /** What to do in this stage / what gets a deal out of it ("" = none). One point per line. */
  guidance: string;
  createdAt: string;
  updatedAt: string;
};

/** GET /pipelines — `pipelines()`: unarchived, default first, stages in order. */
export type Pipeline = {
  id: string;
  workspaceId: string;
  name: string;
  isDefault: boolean;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stages: PipelineStage[];
};

/** The stage as embedded in a deal (`dealInclude.stage`). */
export type DealStageRef = Pick<PipelineStage, "id" | "name" | "kind" | "position" | "color" | "probability" | "rotDays">;

/** GET /deals items — `dealDto()`. */
export type Deal = {
  id: string;
  name: string;
  pipelineId: string;
  stage: DealStageRef;
  contact: { id: string; fullName: string; email: string | null } | null;
  company: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  sourceCampaign: { id: string; name: string } | null;
  value: number;
  currency: string;
  status: DealStatus;
  /** A calendar date stored at UTC midnight (Postgres DATE). */
  expectedCloseDate: string | null;
  wonReason: string;
  lostReason: string;
  proposalUrl: string;
  description: string;
  /** How the owner rates it for the forecast. */
  forecastCategory: ForecastCategory;
  nextStep: string;
  /** A calendar date stored at UTC midnight, like expectedCloseDate. */
  nextStepAt: string | null;
  /** Open and past its stage's rotDays without progress: since the last progress, whole days since. */
  stale: { since: string; days: number } | null;
  stageEnteredAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A row of `DealStageChange` with the stage names resolved. */
export type DealStageChange = {
  id: string;
  workspaceId: string;
  dealId: string;
  fromStageId: string | null;
  toStageId: string;
  changedById: string | null;
  changedAt: string;
  fromStage: string | null;
  toStage: string;
};

/** A note row (Prisma Note). The API returns no author name with it. */
export type Note = {
  id: string;
  workspaceId: string;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  authorId: string | null;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

/** A meeting row (Prisma Meeting) — what POST/PATCH /meetings return. */
export type Meeting = {
  id: string;
  workspaceId: string;
  contactId: string | null;
  dealId: string | null;
  ownerId: string | null;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string;
  status: MeetingStatus;
  notes: string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
};

/** GET /meetings — `meetings()`: ascending by start, at most 500. */
export type MeetingRow = Meeting & {
  contact: { id: string; fullName: string } | null;
  deal: { id: string; name: string } | null;
};

/** A task row (Prisma Task). */
export type Task = {
  id: string;
  workspaceId: string;
  type: TaskType;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  dueAt: string | null;
  remindAt: string | null;
  reminderSentAt: string | null;
  completedAt: string | null;
  completedById: string | null;
  assigneeId: string | null;
  createdById: string | null;
  contactId: string | null;
  dealId: string | null;
  conversationId: string | null;
  campaignId: string | null;
  enrollmentId: string | null;
  /** manual | sequence | automation | system */
  source: string;
  createdAt: string;
  updatedAt: string;
};

/** GET /tasks items and GET /tasks/:id — `taskInclude`. */
export type TaskRow = Task & {
  contact: { id: string; fullName: string; email: string | null; phone: string | null } | null;
  deal: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  conversation: { id: string; channel: string; subject: string } | null;
};

export type TaskView = "today" | "overdue" | "upcoming" | "completed" | "mine" | "team" | "all";

/** GET /deals/:id — `deal()`. Meetings and tasks here are bare rows (no includes). */
export type DealDetail = Deal & {
  history: DealStageChange[];
  meetings: Meeting[];
  tasks: Task[];
  notes: Note[];
};

/** GET /deals/:id/timeline — CrmExtrasService `timeline()`: newest first, at most 200. */
export type TimelineEntry = {
  id: string;
  workspaceId: string;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  actorId: string | null;
  type: string;
  summary: string;
  data: Record<string, unknown>;
  occurredAt: string;
  actor: { id: string; name: string } | null;
};
