/*
 * Small helpers the deals, meetings and tasks pages share.
 */
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/format";
import type { Deal, DealStageRef, PipelineStage } from "@/lib/types/pipeline";

/**
 * Deal values summed per currency ("$12,000 · €3,000"). Deals in different
 * currencies are never added together — there is no exchange rate to use.
 */
export function totalsByCurrency(deals: Pick<Deal, "value" | "currency">[], emptyCurrency: string): string {
  if (!deals.length) return formatCurrency(0, emptyCurrency);
  const sums = new Map<string, number>();
  for (const d of deals) sums.set(d.currency, (sums.get(d.currency) ?? 0) + d.value);
  return [...sums.entries()].map(([code, sum]) => formatCurrency(sum, code)).join(" · ");
}

/**
 * Expected close dates are calendar dates stored at UTC midnight, so they are
 * read in UTC — in the workspace zone a date west of Greenwich would show the
 * day before.
 */
export const formatCalendarDate = (value: string | null | undefined) => formatDate(value, { timeZone: "UTC" });

/** "2026-10-09T00:00:00.000Z" → "2026-10-09" for an <input type="date">. */
export const calendarDateInput = (value: string | null | undefined) => (value ? value.slice(0, 10) : "");

/** The stage ref a deal embeds, from a full stage row. */
export const stageRef = (s: PipelineStage): DealStageRef => ({
  id: s.id,
  name: s.name,
  kind: s.kind,
  position: s.position,
  color: s.color,
  probability: s.probability,
});

/** The per-field messages from a failed mutation (empty when it is not an ApiError). */
export const fieldErrors = (error: unknown): Record<string, string> => (error instanceof ApiError ? error.fields : {});

/** The message to show above a form when no single field is to blame. */
export function formLevelError(error: unknown, known: readonly string[]): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : "Something went wrong";
  if (error.isPlanLimit) return null; // the upgrade dialog tells this story
  const fields = Object.keys(error.fields);
  if (fields.length && fields.every((f) => known.includes(f))) return null;
  return error.message;
}

/** Parses an amount typed into a number box; "" → undefined. */
export function parseAmount(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A key that changes each time a dialog opens, so `<Form key={k} />` starts
 * blank on every opening while the dialog itself stays mounted (Radix then
 * returns focus to the trigger on close).
 */
export function useOpenKey(open: boolean): number {
  const [prev, setPrev] = useState(open);
  const [key, setKey] = useState(0);
  if (open !== prev) {
    setPrev(open);
    if (open) setKey(key + 1);
  }
  return key;
}
