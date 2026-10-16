/*
 * Workflow conditions: pure functions over a snapshot of the run's subject,
 * so they can be evaluated (and tested) without a database.
 *
 * Paths a condition may read:
 *   contact.status | contact.qualification | contact.priority | contact.leadSource
 *   contact.tags | contact.country | contact.custom.<key>
 *   deal.value | deal.stage | deal.status
 *   event.<payload key>
 *
 * All conditions must hold (AND). A path whose subject is missing reads as
 * undefined: `exists` is false, `is` is false, `is_not` is true.
 */

export const CONDITION_PATH =
  /^(contact\.(status|qualification|priority|leadSource|tags|country|ordersCount|paidOrdersCount|totalSpent|custom\.[A-Za-z0-9_]{1,60})|deal\.(value|stage|status)|event\.[A-Za-z0-9_]{1,60})$/;

export type ConditionOp = "is" | "is_not" | "contains" | "gt" | "lt" | "exists";
export type Condition = { field: string; op: ConditionOp; value: string };

export type SubjectSnapshot = {
  contact: {
    status: string;
    qualification: string;
    priority: string;
    leadSource: string;
    tags: string[];
    country: string;
    /** Orders from a connected client portal (src/commerce): placed and not cancelled, paid, and what the paid ones came to. */
    ordersCount: number;
    paidOrdersCount: number;
    totalSpent: number;
    custom: Record<string, unknown>;
  } | null;
  deal: { value: number; stage: string; status: string } | null;
  event: Record<string, unknown>;
};

export function resolvePath(s: SubjectSnapshot, path: string): unknown {
  const [root, key, ...rest] = path.split(".");
  if (root === "event") return key ? s.event[key] : undefined;
  if (root === "contact") {
    if (!s.contact || !key) return undefined;
    if (key === "custom") return s.contact.custom[rest.join(".")];
    return (s.contact as Record<string, unknown>)[key];
  }
  if (root === "deal") {
    if (!s.deal || !key) return undefined;
    return (s.deal as Record<string, unknown>)[key];
  }
  return undefined;
}

const norm = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim().toLowerCase();
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export function testCondition(c: Condition, s: SubjectSnapshot): boolean {
  const actual = resolvePath(s, c.field);
  const expected = norm(c.value);
  switch (c.op) {
    case "exists":
      if (Array.isArray(actual)) return actual.length > 0;
      return actual !== undefined && actual !== null && norm(actual) !== "";
    case "is":
      if (Array.isArray(actual)) return actual.some((a) => norm(a) === expected);
      return actual !== undefined && actual !== null && norm(actual) === expected;
    case "is_not":
      if (Array.isArray(actual)) return !actual.some((a) => norm(a) === expected);
      return norm(actual) !== expected;
    case "contains":
      if (Array.isArray(actual)) return actual.some((a) => norm(a).includes(expected));
      return norm(actual).includes(expected);
    case "gt":
    case "lt": {
      const a = num(actual);
      const b = num(c.value);
      if (a === null || b === null) return false;
      return c.op === "gt" ? a > b : a < b;
    }
  }
}

export function evaluateConditions(conditions: Condition[], s: SubjectSnapshot): { met: boolean; failed: Condition | null } {
  for (const c of conditions) {
    if (!testCondition(c, s)) return { met: false, failed: c };
  }
  return { met: true, failed: null };
}
