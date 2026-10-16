import { describe, expect, it } from "vitest";
import {
  computeScore,
  engagementPoints,
  fitMatches,
  LeadScoringSettings,
  RECOMMENDED_SCORING_RULES,
  scoreBand,
  ScoringRuleInput,
  signalKey,
  type ScoringFacts,
  type ScoringRuleLike,
} from "../src/scoring.js";
import { attachmentKind, cleanFileName, isBlockedFileName, looksExecutable, sniffContentType } from "../src/attachments.js";

const facts: ScoringFacts = {
  jobTitle: "Co-Founder & CEO",
  company: "Acme",
  email: "ana@acme.example",
  phone: "",
  leadSource: "Referral",
  country: "BD",
  city: "",
  website: "",
  linkedinUrl: "",
  lifecycleStage: "lead",
  status: "new",
  qualification: "unqualified",
  priority: "medium",
  tags: ["SaaS", "Enterprise"],
  custom: { employees: 120, plan: "pro" },
};

let n = 0;
const rule = (r: Partial<ScoringRuleLike>): ScoringRuleLike => ({ id: `r${++n}`, name: "Rule", category: "fit", field: "", op: "is", value: "", event: "", points: 10, maxPoints: null, decayDays: null, active: true, ...r });

describe("lead scoring: fit rules", () => {
  it("compares text ignoring case, any of comma-separated values", () => {
    expect(fitMatches(rule({ field: "jobTitle", op: "contains", value: "founder, ceo" }), facts)).toBe(true);
    expect(fitMatches(rule({ field: "jobTitle", op: "contains", value: "director, vp" }), facts)).toBe(false);
    expect(fitMatches(rule({ field: "leadSource", op: "is", value: "referral" }), facts)).toBe(true);
    expect(fitMatches(rule({ field: "leadSource", op: "is", value: "refer" }), facts)).toBe(false);
    expect(fitMatches(rule({ field: "country", op: "is_not", value: "US, GB" }), facts)).toBe(true);
    expect(fitMatches(rule({ field: "country", op: "is_not", value: "bd" }), facts)).toBe(false);
  });

  it("checks presence, numbers, list fields and custom fields", () => {
    expect(fitMatches(rule({ field: "phone", op: "exists" }), facts)).toBe(false);
    expect(fitMatches(rule({ field: "company", op: "exists" }), facts)).toBe(true);
    expect(fitMatches(rule({ field: "custom.employees", op: "gt", value: "100" }), facts)).toBe(true);
    expect(fitMatches(rule({ field: "custom.employees", op: "lt", value: "100" }), facts)).toBe(false);
    expect(fitMatches(rule({ field: "custom.missing", op: "lt", value: "100" }), facts)).toBe(false);
    expect(fitMatches(rule({ field: "custom.plan", op: "gt", value: "abc" }), facts)).toBe(false);
    expect(fitMatches(rule({ field: "tags", op: "is", value: "enterprise" }), facts)).toBe(true);
    expect(fitMatches(rule({ field: "tags", op: "contains", value: "saa" }), facts)).toBe(true);
    expect(fitMatches(rule({ field: "tags", op: "is_not", value: "saas" }), facts)).toBe(false);
  });
});

describe("lead scoring: engagement and totals", () => {
  it("caps repeats at maxPoints, both ways", () => {
    expect(engagementPoints({ points: 3, maxPoints: 9 }, 2)).toBe(6);
    expect(engagementPoints({ points: 3, maxPoints: 9 }, 5)).toBe(9);
    expect(engagementPoints({ points: 20, maxPoints: null }, 2)).toBe(40);
    expect(engagementPoints({ points: -10, maxPoints: 15 }, 3)).toBe(-15);
    expect(engagementPoints({ points: 5, maxPoints: null }, 0)).toBe(0);
  });

  it("adds fit and engagement, clamps to 0–100, and lists what scored", () => {
    const rules = [
      rule({ name: "Title", field: "jobTitle", op: "contains", value: "ceo", points: 15 }),
      rule({ name: "Phone", field: "phone", op: "exists", points: 5 }),
      rule({ name: "Opens", category: "engagement", event: "email.opened", points: 3, maxPoints: 9, decayDays: 30 }),
      rule({ name: "Off", field: "company", op: "exists", points: 50, active: false }),
    ];
    const r = computeScore(rules, facts, { [signalKey(rules[2]!)]: 4 });
    expect(r).toMatchObject({ fit: 15, engagement: 9, total: 24 });
    expect(r.breakdown.map((b) => [b.name, b.points])).toEqual([
      ["Title", 15],
      ["Opens", 9],
    ]);

    const big = [rule({ field: "company", op: "exists", points: 80 }), rule({ category: "engagement", event: "meeting.booked", points: 25 })];
    expect(computeScore(big, facts, { "meeting.booked|": 2 }).total).toBe(100);
    const negative = [rule({ category: "engagement", event: "contact.unsubscribed", points: -30 }), rule({ field: "company", op: "exists", points: 10 })];
    expect(computeScore(negative, facts, { "contact.unsubscribed|": 1 })).toMatchObject({ fit: 10, engagement: -30, total: 0 });
  });

  it("counts the same event over different windows separately", () => {
    const a = rule({ category: "engagement", event: "email.opened", decayDays: 7 });
    const b = rule({ category: "engagement", event: "email.opened", decayDays: 30 });
    expect(signalKey(a)).not.toBe(signalKey(b));
  });

  it("bands scores by the thresholds", () => {
    expect(scoreBand(70, { hot: 70, warm: 40 })).toBe("hot");
    expect(scoreBand(40, { hot: 70, warm: 40 })).toBe("warm");
    expect(scoreBand(39, { hot: 70, warm: 40 })).toBe("cold");
    expect(scoreBand(null, { hot: 70, warm: 40 })).toBeNull();
  });
});

describe("lead scoring: inputs", () => {
  it("validates rules by category", () => {
    expect(ScoringRuleInput.safeParse({ name: "x", category: "fit", field: "jobTitle", op: "contains", value: "ceo", points: 5 }).success).toBe(true);
    expect(ScoringRuleInput.safeParse({ name: "x", category: "fit", field: "nope", op: "is", value: "a", points: 5 }).success).toBe(false);
    expect(ScoringRuleInput.safeParse({ name: "x", category: "fit", field: "custom.size", op: "gt", value: "ten", points: 5 }).success).toBe(false);
    expect(ScoringRuleInput.safeParse({ name: "x", category: "fit", field: "phone", op: "exists", points: 5 }).success).toBe(true);
    expect(ScoringRuleInput.safeParse({ name: "x", category: "engagement", event: "call.outcome:connected", points: 10 }).success).toBe(true);
    expect(ScoringRuleInput.safeParse({ name: "x", category: "engagement", event: "call.outcome:maybe", points: 10 }).success).toBe(false);
    expect(ScoringRuleInput.safeParse({ name: "x", category: "engagement", event: "email.opened", points: 0 }).success).toBe(false);
  });

  it("ships recommended rules that all validate", () => {
    for (const r of RECOMMENDED_SCORING_RULES) expect(ScoringRuleInput.safeParse(r).success, r.name).toBe(true);
    expect(RECOMMENDED_SCORING_RULES.some((r) => r.points < 0)).toBe(true);
  });

  it("refuses warm at or above hot", () => {
    expect(LeadScoringSettings.safeParse({ enabled: true, hot: 60, warm: 60 }).success).toBe(false);
    expect(LeadScoringSettings.parse({ enabled: true })).toEqual({ enabled: true, hot: 70, warm: 40 });
  });
});

describe("attachments: file rules", () => {
  const bytes = (s: string | number[]) => (typeof s === "string" ? new TextEncoder().encode(s) : new Uint8Array(s));

  it("decides the type from the bytes, then plain-text extensions", () => {
    expect(sniffContentType(bytes("%PDF-1.7\n..."), "quote.pdf")).toBe("application/pdf");
    expect(sniffContentType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "x.txt")).toBe("image/png");
    expect(sniffContentType(bytes([0x50, 0x4b, 0x03, 0x04, 0]), "deck.pptx")).toContain("presentationml");
    expect(sniffContentType(bytes([0x50, 0x4b, 0x03, 0x04, 0]), "stuff.zip")).toBe("application/zip");
    expect(sniffContentType(bytes("name,email\na,b"), "list.csv")).toBe("text/csv");
    expect(sniffContentType(bytes("<html><script>alert(1)</script>"), "page.html")).toBe("application/octet-stream");
    expect(sniffContentType(bytes("<svg/>"), "logo.svg")).toBe("application/octet-stream");
  });

  it("spots programs by extension and by bytes", () => {
    expect(isBlockedFileName("setup.EXE")).toBe(true);
    expect(isBlockedFileName("run.sh")).toBe(true);
    expect(isBlockedFileName("report.pdf")).toBe(false);
    expect(looksExecutable(bytes("MZ\x90\x00"))).toBe(true);
    expect(looksExecutable(bytes([0x7f, 0x45, 0x4c, 0x46]))).toBe(true);
    expect(looksExecutable(bytes("#!/bin/sh\nrm -rf /"))).toBe(true);
    expect(looksExecutable(bytes("%PDF-1.4"))).toBe(false);
  });

  it("cleans names and picks icons", () => {
    expect(cleanFileName("../../etc/pass\u0000wd")).toBe("passwd");
    expect(cleanFileName('C:\\Users\\me\\"Q3".pdf')).toBe("Q3.pdf");
    expect(cleanFileName("   ")).toBe("file");
    expect(attachmentKind("application/pdf")).toBe("pdf");
    expect(attachmentKind("application/octet-stream", "sheet.xlsx")).toBe("spreadsheet");
    expect(attachmentKind("image/png")).toBe("image");
  });
});
