/*
 * Shapes of the reports API (GET /workspaces/:id/analytics/…). Rates are
 * ratios (0.125 = 12.5%) and are null when there was nothing to divide by.
 * Keep these in step with apps/api/src/analytics/analytics.service.ts.
 */
import type { CampaignStatus, StageKind, WorkspaceRole } from "@growthdesk/shared";

export type ReportRange = {
  /** First and last local day (inclusive) in the workspace's time zone. */
  from: string;
  to: string;
  days: number;
  timeZone: string;
  currency: string;
  /** "own": the role lacks records.view_all, so figures cover the person's own and unassigned records. */
  scope: "all" | "own";
};

export type SeriesPoint = {
  date: string;
  sent: number;
  bounced: number;
  replies: number;
  dealsCreated: number;
  dealsWon: number;
  /** Workspace currency only, major units. */
  valueWon: number;
  tasksCompleted: number;
  meetingsBooked: number;
  callsLogged: number;
};

export type AnalyticsOverview = {
  range: ReportRange;
  outreach: {
    sent: number;
    byChannel: Record<string, number>;
    /** Messages with a delivery receipt (chat channels send them; email does not). */
    delivered: number;
    bounced: number;
    bounceRate: number | null;
    opened: number;
    openRate: number | null;
    clicked: number;
    clickRate: number | null;
    /** Conversations written to in the range… */
    contacted: number;
    /** …of which answered by a person after that. */
    replied: number;
    replyRate: number | null;
    /** Human replies received in the range. */
    replies: number;
    unsubscribes: number;
  };
  pipeline: {
    created: number;
    won: number;
    lost: number;
    winRate: number | null;
    valueWon: number;
    otherCurrencies: { currency: string; value: number; deals: number }[];
    avgDaysToClose: number | null;
  };
  activity: {
    tasksCompleted: number;
    meetingsBooked: number;
    meetingsHeld: number;
    callsLogged: number;
    callsConnected: number;
  };
  series: SeriesPoint[];
};

export type CampaignReportRow = {
  id: string;
  name: string;
  status: CampaignStatus;
  deleted: boolean;
  trackOpens: boolean;
  trackClicks: boolean;
  sent: number;
  contacted: number;
  replied: number;
  replyRate: number | null;
  bounced: number;
  bounceRate: number | null;
  opened: number;
  clicked: number;
  unsubscribed: number;
  /** Deals created in the range with this campaign as their source. */
  deals: number;
};

export type StepReportRow = {
  /** 0-based step position in the sequence. */
  position: number;
  sent: number;
  replied: number;
  replyRate: number | null;
  bounced: number;
  bounceRate: number | null;
  opened: number;
  clicked: number;
};

export type AnalyticsCampaigns = { range: ReportRange; campaigns: CampaignReportRow[]; steps: StepReportRow[] };

export type FunnelStage = { stageId: string; name: string; kind: StageKind; color: string; reached: number; conversion: number | null };

export type AnalyticsPipeline = {
  range: ReportRange;
  pipelines: { id: string; name: string; isDefault: boolean }[];
  pipelineId: string | null;
  /** Deals created in the range in this pipeline. */
  cohort: number;
  open: number;
  won: number;
  lost: number;
  stages: FunnelStage[];
};

export type TeamMemberReport = {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  sent: number;
  replies: number;
  meetingsBooked: number;
  callsLogged: number;
  callsConnected: number;
  tasksCompleted: number;
  dealsCreated: number;
  dealsWon: number;
  valueWon: number;
};

export type AnalyticsTeam = { range: ReportRange; members: TeamMemberReport[] };
