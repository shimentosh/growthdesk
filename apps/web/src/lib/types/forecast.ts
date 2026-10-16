/*
 * Shapes of the forecast and targets responses. Keep these in step with
 * apps/api/src/forecast/forecast.service.ts; the figures themselves are
 * summarizeForecast() in packages/shared/src/forecast.ts.
 */
import type { DealStatus, ForecastCategory, ForecastFigures, ForecastOtherCurrency, PeriodType, StageKind, TargetMetric } from "@growthdesk/shared";

export type ForecastPeriodDto = { type: PeriodType; label: string; from: string; to: string; timeZone: string };

export type ForecastOwnerRow = ForecastFigures & { ownerId: string | null; owner: { id: string; name: string } | null; deactivated: boolean };

export type TeamRef = { id: string; name: string; color: string };

/** A team's roll-up: its members' figures (a deactivated member's open pipeline left out) against the team's target. */
export type ForecastTeamRow = ForecastFigures & { team: TeamRef; memberIds: string[] };

/** A deal in the period: won inside it, or open and expected to close inside it. */
export type ForecastDeal = {
  id: string;
  name: string;
  owner: { id: string; name: string } | null;
  contact: { id: string; fullName: string } | null;
  company: { id: string; name: string } | null;
  stage: { id: string; name: string; probability: number; color: string; kind: StageKind };
  value: number;
  currency: string;
  status: DealStatus;
  forecastCategory: ForecastCategory;
  /** A calendar date at UTC midnight. */
  expectedCloseDate: string | null;
  closedAt: string | null;
  /** value × stage probability for an open, counted deal in the workspace currency; else null. */
  weighted: number | null;
};

/** GET /forecast */
export type ForecastResponse = {
  period: ForecastPeriodDto;
  currency: string;
  /** "own": the person sees their own (and unowned, and their team's) deals only, and no team target. */
  scope: "all" | "own";
  ownerId: string | null;
  /** The team the forecast is narrowed to (?teamId), measured against its target. */
  team: TeamRef | null;
  total: ForecastFigures;
  owners: ForecastOwnerRow[];
  /** Every team's roll-up, in the whole-workspace view only. */
  teams: ForecastTeamRow[];
  otherCurrencies: ForecastOtherCurrency[];
  ignoredTargets: number;
  deals: ForecastDeal[];
};

/** GET /targets items and PUT /targets */
export type SalesTarget = {
  id: string;
  /** A rep's target; with teamId a team's; with neither the workspace's. */
  userId: string | null;
  teamId: string | null;
  periodType: PeriodType;
  periodStart: string;
  metric: TargetMetric;
  target: number;
  currency: string;
  updatedAt: string;
  user?: { id: string; name: string } | null;
  team?: TeamRef | null;
};

export type TargetsResponse = { period: ForecastPeriodDto; currency: string; items: SalesTarget[]; teams: TeamRef[] };
