import { localDaysBetween, type ResolvedRange } from "@growthdesk/shared";

/** One day's count (or sum) as SQL returns it: only days that had rows. */
export type DayRow = { day: string; n: number };

/**
 * Turns sparse per-day rows from several queries into one dense daily series:
 * every local day in the range is present, days without rows are 0, and a
 * row outside the range (which the SQL bounds should never produce) is dropped
 * rather than appended.
 */
export function denseSeries<K extends string>(range: Pick<ResolvedRange, "from" | "to">, sources: Record<K, DayRow[]>): ({ date: string } & Record<K, number>)[] {
  const keys = Object.keys(sources) as K[];
  const out = localDaysBetween(range.from, range.to).map((date) => ({ date, ...Object.fromEntries(keys.map((k) => [k, 0])) }) as { date: string } & Record<K, number>);
  const index = new Map(out.map((p, i) => [p.date, i]));
  for (const k of keys) {
    for (const row of sources[k]) {
      const i = index.get(row.day);
      if (i === undefined) continue;
      const point = out[i] as Record<string, number | string>;
      point[k] = (point[k] as number) + Number(row.n);
    }
  }
  return out;
}

/** Sum of a series key (a KPI total that must agree with its chart). */
export const total = (rows: DayRow[]): number => rows.reduce((a, r) => a + Number(r.n), 0);

/** Rounds a ratio for the wire (4 decimals is 0.01% precision). Null stays null: "no denominator" is not 0%. */
export const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);
