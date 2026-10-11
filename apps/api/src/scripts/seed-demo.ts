import "dotenv/config";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { normalizeCompanyName } from "@growthdesk/shared";
import { seal } from "../common/crypto.js";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";

/*
 * Development only: fills one workspace with realistic demo data — teammates,
 * companies, contacts, deals, campaigns with sent mail and replies, an inbox
 * across channels, calls, meetings, tasks, workflows and notifications — so
 * every screen has something to show.
 *
 *   pnpm db:seed:demo -- --workspace <id or slug> [--keep-plan]
 *
 * Every address uses the reserved .example TLD and demo mailboxes point at the
 * local Mailpit with reply tracking off, so nothing can leave the machine.
 * The workspace is moved to the Agency plan (all features) unless --keep-plan.
 * Refuses to run twice on the same workspace.
 */

const { values } = parseArgs({ options: { workspace: { type: "string" }, "keep-plan": { type: "boolean", default: false } } });
if (process.env.NODE_ENV === "production") throw new Error("seed-demo is for development databases only.");
if (!values.workspace) throw new Error("Usage: pnpm db:seed:demo -- --workspace <id or slug>");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

// ─── Helpers ─────────────────────────────────────────────────────────────────

let seed = 20261010;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const chance = (p: number) => rand() < p;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const pickSome = <T>(xs: readonly T[], n: number): T[] => [...xs].sort(() => rand() - 0.5).slice(0, n);

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A moment `days` ago (fractional allowed), nudged into working hours. */
const ago = (days: number, hour = int(9, 17)) => {
  const d = new Date(NOW - days * DAY);
  if (days >= 1) d.setHours(hour, int(0, 59), int(0, 59), 0);
  return d;
};
const ahead = (days: number, hour = int(9, 17)) => {
  const d = new Date(NOW + days * DAY);
  d.setHours(hour, pick([0, 15, 30, 45]), 0, 0);
  return d;
};
const clampPast = (d: Date) => new Date(Math.min(d.getTime(), NOW - 5 * MIN));

/** UUIDv7 stamped with the record's own creation time, so id order matches time order. */
function uuid7(at: Date | number = NOW): string {
  const b = randomBytes(16);
  const t = BigInt(typeof at === "number" ? at : at.getTime());
  for (let i = 0; i < 6; i++) b[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const msgId = (domain: string) => `<${randomBytes(10).toString("hex")}@${domain}>`;

// ─── Workspace ───────────────────────────────────────────────────────────────

const ws = await prisma.workspace.findFirst({
  where: { OR: [{ slug: values.workspace }, ...(/^[0-9a-f-]{36}$/i.test(values.workspace) ? [{ id: values.workspace }] : [])] },
  include: { memberships: { where: { role: "owner" }, include: { user: true } } },
});
if (!ws) throw new Error(`No workspace with id or slug "${values.workspace}".`);
const W = ws.id;
const owner = ws.memberships[0]?.user;
if (!owner) throw new Error("That workspace has no owner.");

if (await prisma.contactSource.findFirst({ where: { workspaceId: W, source: "demo" } })) {
  console.log(`"${ws.name}" already has demo data — nothing to do.`);
  await prisma.$disconnect();
  process.exit(0);
}

if (!values["keep-plan"]) {
  const agency = await prisma.plan.findUnique({ where: { key: "agency" } });
  if (agency) {
    await prisma.subscription.upsert({
      where: { billingAccountId: ws.billingAccountId },
      update: { planId: agency.id, status: "active", trialEndsAt: null, currentPeriodStart: new Date(NOW), currentPeriodEnd: new Date(NOW + 30 * DAY) },
      create: { billingAccountId: ws.billingAccountId, planId: agency.id, status: "active", provider: "manual", currentPeriodStart: new Date(NOW), currentPeriodEnd: new Date(NOW + 30 * DAY) },
    });
  }
}

// ─── Teammates ───────────────────────────────────────────────────────────────

const teammates = [
  { name: "Maya Chen", email: "maya.chen@team.example", role: "admin" as const },
  { name: "Rafael Ortiz", email: "rafael.ortiz@team.example", role: "manager" as const },
  { name: "Priya Nair", email: "priya.nair@team.example", role: "member" as const },
];
const team = [owner];
for (const t of teammates) {
  const user = await prisma.user.upsert({
    where: { email: t.email },
    update: {},
    create: { email: t.email, name: t.name, emailVerifiedAt: ago(60), timezone: ws.timezone, lastLoginAt: ago(int(0, 3)) },
  });
  await prisma.membership.upsert({
    where: { workspaceId_userId: { workspaceId: W, userId: user.id } },
    update: {},
    create: { workspaceId: W, userId: user.id, role: t.role, lastSeenAt: ago(int(0, 2)) },
  });
  team.push(user);
}
const [me, maya, rafael, priya] = team as [typeof owner, typeof owner, typeof owner, typeof owner];
const reps = [me, maya, rafael, priya];

// ─── Tags, custom fields, call scripts ───────────────────────────────────────

const tagDefs = [
  ["Hot lead", "red"],
  ["Decision maker", "purple"],
  ["Webinar attendee", "blue"],
  ["Partner", "green"],
  ["Enterprise", "orange"],
  ["Follow up Q4", "yellow"],
] as const;
const tags: Record<string, string> = {};
for (const [name, color] of tagDefs) {
  const t = await prisma.tag.upsert({ where: { workspaceId_name: { workspaceId: W, name } }, update: {}, create: { workspaceId: W, name, color } });
  tags[name] = t.id;
}

await prisma.customFieldDefinition.createMany({
  skipDuplicates: true,
  data: [
    { workspaceId: W, entity: "contact", key: "budget", label: "Budget (USD)", type: "number", position: 0 },
    { workspaceId: W, entity: "contact", key: "renewal_date", label: "Contract renewal", type: "date", position: 1 },
    { workspaceId: W, entity: "company", key: "tech_stack", label: "Tech stack", type: "text", position: 0 },
    { workspaceId: W, entity: "company", key: "careers_page", label: "Careers page", type: "url", position: 1 },
  ],
});

await prisma.callScript.createMany({
  data: [
    {
      workspaceId: W,
      name: "Discovery call",
      createdById: me.id,
      body: "Opener: Hi {{firstName}}, this is {{senderName}} from {{workspaceName}} — did I catch you at an OK time?\n\nPurpose: We help teams like {{company}} run outbound without the spreadsheet chaos. I'd love to learn how you handle it today.\n\nQuestions:\n1. How do you find and qualify new leads right now?\n2. Who follows up, and how do you know nothing slips?\n3. What would make this quarter a win for your team?\n\nNext step: Offer a 30-minute walkthrough this week.",
    },
    {
      workspaceId: W,
      name: "Follow-up after no reply",
      createdById: maya.id,
      body: "Hi {{firstName}}, {{senderName}} here. I sent a couple of notes about {{company}}'s outreach — wanted to check whether it's on your radar this quarter, or if someone else owns it.\n\nIf not interested: thank them, ask if a check-in next quarter is OK, log the outcome.",
    },
  ],
});

// ─── Companies ───────────────────────────────────────────────────────────────

const companyDefs = [
  ["Northwind Analytics", "northwind-analytics.example", "SaaS", "51-200", "United States", "Austin", "America/Chicago", "Product analytics for mid-market e-commerce teams."],
  ["Brightpath Logistics", "brightpath.example", "Logistics", "201-500", "United States", "Chicago", "America/Chicago", "Last-mile delivery for regional retailers."],
  ["Lumen Health Partners", "lumenhealth.example", "Healthcare", "501-1000", "United Kingdom", "London", "Europe/London", "Network of private outpatient clinics."],
  ["Copperleaf Studio", "copperleaf.example", "Agency", "11-50", "Canada", "Toronto", "America/Toronto", "Brand and growth marketing agency."],
  ["Harborview Realty", "harborview.example", "Real estate", "51-200", "Australia", "Sydney", "Australia/Sydney", "Commercial property brokerage."],
  ["Vertex Fintech", "vertexfin.example", "Fintech", "201-500", "Singapore", "Singapore", "Asia/Singapore", "Cross-border payments for SMEs."],
  ["Greenfield Foods", "greenfieldfoods.example", "Food & beverage", "501-1000", "Germany", "Berlin", "Europe/Berlin", "Organic packaged foods, sold across the EU."],
  ["Atlas Robotics", "atlasrobotics.example", "Manufacturing", "1001-5000", "Japan", "Osaka", "Asia/Tokyo", "Industrial automation and warehouse robots."],
  ["Pinecrest Education", "pinecrest-edu.example", "Education", "51-200", "United States", "Denver", "America/Denver", "Online certification courses for professionals."],
  ["Mosaic Media Group", "mosaicmedia.example", "Media", "11-50", "United Arab Emirates", "Dubai", "Asia/Dubai", "Digital publishing and sponsored content."],
  ["Solace Wellness", "solacewellness.example", "Wellness", "11-50", "India", "Bengaluru", "Asia/Kolkata", "Corporate wellness programmes."],
  ["Ironclad Security", "ironclad-sec.example", "Cybersecurity", "201-500", "Netherlands", "Amsterdam", "Europe/Amsterdam", "Managed detection and response."],
  ["Riverstone Capital", "riverstone.example", "Financial services", "51-200", "United States", "New York", "America/New_York", "Growth equity for B2B software."],
  ["Dhaka Textiles Co.", "dhakatextiles.example", "Textiles", "1001-5000", "Bangladesh", "Dhaka", "Asia/Dhaka", "Knitwear exporter supplying European brands."],
] as const;
const stacks = ["HubSpot, Slack, Notion", "Salesforce, Outreach, Gong", "Pipedrive, Google Workspace", "Zoho, WhatsApp Business", "Excel and email"];

type Co = { id: string; name: string; domain: string; country: string; city: string; tz: string; industry: string };
const companies: Co[] = [];
const companyRows: Prisma.CompanyCreateManyInput[] = [];
for (const [name, domain, industry, size, country, city, tz, description] of companyDefs) {
  const createdAt = ago(int(35, 70));
  const id = uuid7(createdAt);
  companies.push({ id, name, domain, country, city, tz, industry });
  companyRows.push({
    id,
    workspaceId: W,
    name,
    normalizedName: normalizeCompanyName(name),
    domain,
    website: `https://www.${domain}`,
    industry,
    size,
    country,
    city,
    description,
    ownerId: pick(reps).id,
    customFields: { tech_stack: pick(stacks), careers_page: `https://www.${domain}/careers` },
    createdById: me.id,
    createdAt,
  });
}
await prisma.company.createMany({ data: companyRows });
await prisma.companyTag.createMany({
  data: [
    ...pickSome(companies, 4).map((c) => ({ workspaceId: W, companyId: c.id, tagId: tags["Enterprise"]! })),
    ...pickSome(companies, 2).map((c) => ({ workspaceId: W, companyId: c.id, tagId: tags["Partner"]! })),
  ],
  skipDuplicates: true,
});

// ─── Contacts ────────────────────────────────────────────────────────────────

const firstNames = ["Olivia", "Ethan", "Sofia", "Liam", "Amara", "Noah", "Hana", "Lucas", "Zara", "Mateo", "Aisha", "Daniel", "Mei", "Oscar", "Leila", "Samuel", "Nadia", "Kenji", "Fatima", "Jonas", "Elena", "Arjun", "Chloe", "Tariq", "Grace", "Rohan", "Ines", "Felix", "Yara", "Tomás", "Sara", "Hiro", "Maryam", "Ben", "Anika", "Diego", "Lena", "Omar", "Julia", "Kwame", "Emma", "Rafi", "Clara", "Imran", "Nora", "Theo", "Sana", "Victor"];
const lastNames = ["Bennett", "Okafor", "Rossi", "Nakamura", "Hassan", "Fischer", "Kim", "Moreau", "Patel", "Silva", "Andersson", "Rahman", "Walsh", "Novak", "Haddad", "Tanaka", "Costa", "Ibrahim", "Lindqvist", "Mensah", "Choi", "Dubois", "Kapoor", "Ahmed", "Hughes", "Weber", "Yamamoto", "Lopez", "Karimi", "Murphy", "Sato", "Varga"];
const titles = ["CEO", "Co-founder", "Head of Growth", "VP Sales", "Marketing Director", "Operations Manager", "CTO", "Procurement Lead", "Head of Partnerships", "Sales Manager", "Business Development Lead", "COO"];
const leadSources = ["Website", "Referral", "Webinar", "Cold outbound", "Conference", "CSV import", "Business OS"];
const statusPlan = [
  ...Array(12).fill("new"),
  ...Array(15).fill("contacted"),
  ...Array(8).fill("replied"),
  ...Array(7).fill("interested"),
  ...Array(5).fill("customer"),
  ...Array(4).fill("not_interested"),
  "do_not_contact",
] as Prisma.ContactCreateManyInput["status"][];
const phonePrefix: Record<string, string> = {
  "United States": "+1555", "Canada": "+1555", "United Kingdom": "+447700", "Australia": "+614", "Singapore": "+658", "Germany": "+4915",
  "Japan": "+8190", "United Arab Emirates": "+97150", "India": "+9198", "Netherlands": "+316", "Bangladesh": "+88017",
};

type Ct = {
  id: string; first: string; last: string; full: string; email: string; phone: string | null; title: string;
  company: Co | null; ownerId: string; status: string; createdAt: Date; leadSource: string;
};
const contacts: Ct[] = [];
const contactRows: Prisma.ContactCreateManyInput[] = [];
const usedNames = new Set<string>();
const statuses = [...statusPlan].sort(() => rand() - 0.5);
for (let i = 0; i < statuses.length; i++) {
  let first = "", last = "";
  do {
    first = pick(firstNames);
    last = pick(lastNames);
  } while (usedNames.has(first + last));
  usedNames.add(first + last);
  const company = i < 46 ? companies[i % companies.length]! : null;
  const domain = company?.domain ?? "mail.example";
  const email = `${first.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}.${last.toLowerCase()}@${domain}`;
  const country = company?.country ?? pick(["United States", "United Kingdom", "Bangladesh", "India"]);
  const phone = chance(0.75) ? `${phonePrefix[country] ?? "+1555"}${String(int(1000000, 9999999))}` : null;
  const status = statuses[i]!;
  const createdAt = ago(int(20, 65));
  const id = uuid7(createdAt);
  const ownerId = pick(reps).id;
  const leadSource = pick(leadSources);
  const contacted = status !== "new";
  const lastContactedAt = contacted ? ago(int(1, 18)) : null;
  const repliedish = ["replied", "interested", "customer", "not_interested"].includes(status);
  const qualification =
    status === "customer" || status === "interested" ? "qualified" : status === "replied" ? "qualifying" : status === "not_interested" || status === "do_not_contact" ? "disqualified" : "unqualified";
  const priority = status === "interested" ? pick(["high", "urgent"] as const) : pick(["low", "medium", "medium", "high"] as const);
  contacts.push({ id, first, last, full: `${first} ${last}`, email, phone, title: pick(titles), company, ownerId, status, createdAt, leadSource });
  contactRows.push({
    id,
    workspaceId: W,
    companyId: company?.id ?? null,
    firstName: first,
    lastName: last,
    fullName: `${first} ${last}`,
    email,
    phone,
    jobTitle: contacts[i]!.title,
    website: company ? `https://www.${company.domain}` : "",
    linkedinUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-demo`,
    city: company?.city ?? "",
    country,
    timezone: company?.tz ?? "",
    leadSource,
    ownerId,
    priority,
    qualification,
    status,
    score: int(12, 96),
    customFields: chance(0.5) ? { budget: int(5, 120) * 500, ...(chance(0.4) ? { renewal_date: ahead(int(30, 200)).toISOString().slice(0, 10) } : {}) } : {},
    lastContactedAt,
    lastRepliedAt: repliedish ? ago(int(1, 12)) : null,
    nextActionAt: ["contacted", "replied", "interested"].includes(status) ? (chance(0.3) ? ago(int(1, 3)) : ahead(int(0, 7))) : null,
    nextActionNote: ["contacted", "replied", "interested"].includes(status) ? pick(["Send case study", "Book discovery call", "Follow up on pricing question", "Check in after their board meeting", "Share onboarding plan"]) : "",
    doNotContact: status === "do_not_contact",
    consentStatus: pick(["unknown", "unknown", "granted"] as const),
    createdById: pick(reps).id,
    createdAt,
  });
}
// A near-duplicate pair for the duplicates screen.
{
  const original = contacts.find((c) => c.company && c.status === "contacted")!;
  const createdAt = ago(4);
  const id = uuid7(createdAt);
  const dupEmail = `${original.first[0]!.toLowerCase()}${original.last.toLowerCase()}@${original.company!.domain}`;
  contactRows.push({
    id, workspaceId: W, companyId: original.company!.id, firstName: original.first, lastName: original.last, fullName: original.full,
    email: dupEmail, jobTitle: original.title, country: original.company!.country, leadSource: "CSV import", ownerId: original.ownerId, createdById: me.id, createdAt,
  });
  contacts.push({ ...original, id, email: dupEmail, phone: null, createdAt, leadSource: "CSV import", status: "new" });
}
await prisma.contact.createMany({ data: contactRows });
const dup = contacts[contacts.length - 1]!;
const dupOf = contacts.find((c) => c.full === dup.full && c.id !== dup.id)!;
await prisma.duplicateCandidate.create({ data: { workspaceId: W, contactId: dupOf.id, duplicateId: dup.id, reason: "Same name at the same company", score: 82, createdAt: ago(4) } });

await prisma.contactIdentifier.createMany({
  data: contacts.flatMap((c) => [
    { workspaceId: W, contactId: c.id, kind: "email" as const, value: c.email, isPrimary: true, createdAt: c.createdAt },
    ...(c.phone ? [{ workspaceId: W, contactId: c.id, kind: "phone" as const, value: c.phone, isPrimary: true, createdAt: c.createdAt }] : []),
  ]),
  skipDuplicates: true,
});
const csvImportId = uuid7(ago(30));
await prisma.contactSource.createMany({
  data: contacts.map((c, i) => ({
    workspaceId: W,
    contactId: c.id,
    source: "demo",
    externalId: `demo-${i}`,
    importId: c.leadSource === "CSV import" ? csvImportId : null,
    createdAt: c.createdAt,
  })),
});
await prisma.import.create({
  data: {
    id: csvImportId, workspaceId: W, source: "csv", status: "completed", fileName: "conference-leads-sept.csv",
    mapping: { "First name": "firstName", "Last name": "lastName", Email: "email", Company: "company", Title: "jobTitle" },
    totalRows: 38, processedRows: 38, createdCount: 31, updatedCount: 4, skippedCount: 2, failedCount: 1,
    errors: [{ row: 17, message: "Email is not valid: maria@@harborview" }],
    createdById: maya.id, startedAt: ago(30, 11), finishedAt: ago(30, 11), createdAt: ago(30, 11),
  },
});

const tagRows: Prisma.ContactTagCreateManyInput[] = [];
for (const c of contacts) {
  if (c.status === "interested" || chance(0.15)) tagRows.push({ workspaceId: W, contactId: c.id, tagId: tags["Hot lead"]! });
  if (/CEO|founder|VP|Director|COO|CTO/i.test(c.title)) tagRows.push({ workspaceId: W, contactId: c.id, tagId: tags["Decision maker"]! });
  if (c.leadSource === "Webinar") tagRows.push({ workspaceId: W, contactId: c.id, tagId: tags["Webinar attendee"]! });
  if (chance(0.12)) tagRows.push({ workspaceId: W, contactId: c.id, tagId: tags["Follow up Q4"]! });
}
await prisma.contactTag.createMany({ data: tagRows, skipDuplicates: true });

const dnc = contacts.find((c) => c.status === "do_not_contact")!;
await prisma.suppression.createMany({
  data: [
    { workspaceId: W, kind: "email", value: dnc.email, reason: "do_not_contact", source: "Marked by a teammate", createdById: rafael.id, createdAt: ago(9) },
    { workspaceId: W, kind: "domain", value: "competitor.example", reason: "manual", source: "Competitor — never contact", createdById: me.id, createdAt: ago(40) },
    { workspaceId: W, kind: "email", value: "unsubscribed.reader@mail.example", reason: "unsubscribed", source: "Unsubscribe link", createdAt: ago(15) },
  ],
  skipDuplicates: true,
});

await prisma.savedView.createMany({
  data: [
    { workspaceId: W, userId: null, entity: "contact", name: "Hot leads", filters: { tag: ["Hot lead"], status: ["replied", "interested"] }, sort: { field: "score", dir: "desc" } },
    { workspaceId: W, userId: me.id, entity: "contact", name: "My open leads", filters: { ownerId: "me", status: ["new", "contacted", "replied"] }, sort: { field: "nextActionAt", dir: "asc" } },
    { workspaceId: W, userId: null, entity: "contact", name: "Customers", filters: { status: ["customer"] }, sort: { field: "updatedAt", dir: "desc" } },
    { workspaceId: W, userId: null, entity: "contact", name: "No next step", filters: { noNextAction: true, status: ["contacted", "replied", "interested"] }, sort: {} },
  ],
});

// Timeline entries gathered as we go and written at the end.
const activities: Prisma.ActivityCreateManyInput[] = [];
const act = (a: Omit<Prisma.ActivityCreateManyInput, "workspaceId">) => activities.push({ workspaceId: W, ...a });
for (const c of contacts) act({ contactId: c.id, companyId: c.company?.id, actorId: c.ownerId, type: "contact.created", summary: `${c.full} was added (${c.leadSource})`, occurredAt: c.createdAt });

// ─── Mailboxes, templates, sequences ─────────────────────────────────────────

const mailboxDefs = [
  { email: `${me.name.split(" ")[0]?.toLowerCase() || "sales"}@sentosh-demo.example`, displayName: me.name || "Sales", owner: me },
  { email: "maya@sentosh-demo.example", displayName: "Maya Chen", owner: maya },
];
const mailboxes: { id: string; email: string; displayName: string }[] = [];
for (const m of mailboxDefs) {
  const createdAt = ago(50);
  const id = uuid7(createdAt);
  await prisma.mailbox.create({
    data: {
      id, workspaceId: W, provider: "smtp", email: m.email, displayName: m.displayName, status: "connected", lastCheckedAt: ago(0.2),
      // Local Mailpit, reply tracking off: a demo mailbox can never reach a real inbox.
      smtpHost: "127.0.0.1", smtpPort: 1066, smtpSecurity: "none", smtpUser: m.email, secretSealed: seal("demo"), imapEnabled: false,
      dailyLimit: 60, minDelaySeconds: 120, signature: `—\n${m.displayName}\nSentosh · sentosh-demo.example`, createdById: m.owner.id, createdAt,
    },
  });
  mailboxes.push({ id, email: m.email, displayName: m.displayName });
}

const templateDefs = [
  ["Cold intro — operations leaders", "Prospecting", "Quick question about {{company}}'s outreach", "Hi {{firstName}},\n\nI noticed {{company}} has been growing its team — congrats. Most ops leaders I talk to say follow-ups are where deals quietly die.\n\nWe help teams keep every lead, reply and next step in one place. Worth a 20-minute look next week?\n\nBest,\n{{senderName}}"],
  ["Gentle follow-up", "Follow-up", "", "Hi {{firstName}}, bumping this in case it got buried. Happy to send a 2-minute video instead of a call if that's easier."],
  ["Breakup email", "Follow-up", "Should I close your file?", "Hi {{firstName}},\n\nI haven't heard back, so I'll assume timing isn't right. If that changes, just reply to this email and I'll pick it up from here.\n\nAll the best,\n{{senderName}}"],
  ["Webinar thank-you", "Events", "Slides from yesterday's session", "Hi {{firstName}},\n\nThanks for joining our session on outbound playbooks. Here are the slides and recording, as promised.\n\nIf you'd like, I can walk through how {{company}} could set this up — reply with a time that works."],
  ["Meeting confirmation", "Meetings", "Confirmed: {{company}} × Sentosh", "Hi {{firstName}}, looking forward to our call. I'll send a short agenda the day before. Anyone else from {{company}} who should join?"],
] as const;
const templates: { id: string; name: string; subject: string; body: string }[] = [];
for (const [name, category, subject, body] of templateDefs) {
  const createdAt = ago(int(45, 55));
  const id = uuid7(createdAt);
  await prisma.template.create({
    data: {
      id, workspaceId: W, channel: "email", name, category, subject, body, createdById: me.id, createdAt,
      versions: { create: { workspaceId: W, version: 1, subject, body, createdById: me.id, createdAt } },
    },
  });
  templates.push({ id, name, subject, body });
}
await prisma.template.create({
  data: {
    workspaceId: W, channel: "whatsapp", name: "WhatsApp — meeting reminder", category: "Meetings", body: "Hi {{1}}, a quick reminder of our call tomorrow at {{2}}. Reply here if you need to reschedule.",
    waTemplate: "meeting_reminder", waLanguage: "en", createdById: maya.id, createdAt: ago(30),
    versions: { create: { workspaceId: W, version: 1, subject: "", body: "Hi {{1}}, a quick reminder of our call tomorrow at {{2}}. Reply here if you need to reschedule.", createdById: maya.id } },
  },
});
const [tIntro, tFollow, tBreakup, tWebinar] = templates as [typeof templates[0], typeof templates[0], typeof templates[0], typeof templates[0]];

type StepDef = { type: Prisma.SequenceStepCreateManyInput["type"]; config: Record<string, unknown> };
const emailStep = (t: { id: string; subject: string; body: string }): StepDef => ({ type: "email", config: { subject: t.subject, body: t.body, templateId: t.id } });
const wait = (days: number): StepDef => ({ type: "wait", config: { delayMinutes: days * 1440 } });

async function sequence(name: string, kind: "library" | "campaign", steps: StepDef[], description = "", createdAt = ago(45)) {
  const id = uuid7(createdAt);
  await prisma.sequence.create({
    data: {
      id, workspaceId: W, name, description, kind, createdById: me.id, createdAt,
      steps: { create: steps.map((s, position) => ({ workspaceId: W, position, type: s.type, config: s.config as Prisma.InputJsonValue })) },
    },
  });
  return id;
}

const coldSteps: StepDef[] = [
  emailStep(tIntro),
  wait(3),
  emailStep({ ...tFollow, subject: "" }),
  wait(4),
  { type: "call_task", config: { taskTitle: "Call {{firstName}} at {{company}}", taskType: "call", taskDueMinutes: 1440 } },
  wait(3),
  emailStep(tBreakup),
];
await sequence("Cold outbound — 3 touch + call", "library", coldSteps, "Intro, nudge, call, breakup. Our default for new outbound lists.");
await sequence("Branch on engagement", "library", [
  emailStep(tIntro),
  wait(3),
  { type: "branch", config: { logic: { match: "any", rules: [{ field: "opened", op: "is", value: "yes" }, { field: "clicked", op: "is", value: "yes" }] }, thenLength: 1, elseLength: 2 } },
  { type: "call_task", config: { taskTitle: "They opened — call {{firstName}}", taskType: "call", taskDueMinutes: 240 } },
  { type: "update_field", config: { field: "priority", value: "low" } },
  emailStep({ ...tFollow, subject: "" }),
  { type: "notify", config: { message: "{{fullName}} finished the engagement sequence", strategy: "campaign_owner" } },
], "Calls the people who engaged, nudges the rest.");

// ─── Campaigns, enrollments, sent mail, replies ─────────────────────────────

const replyBodies: Record<string, { sentiment: string; body: string; summary: string }[]> = {
  interested: [
    { sentiment: "positive", body: "Hi, thanks for reaching out — this is timely, we're reviewing our outbound setup this month. Can you send pricing for a team of 6?", summary: "Interested; asked for pricing for 6 seats." },
    { sentiment: "positive", body: "This looks useful. Our SDRs are drowning in spreadsheets. What does onboarding look like?", summary: "Interested; asked about onboarding." },
  ],
  meeting_request: [
    { sentiment: "positive", body: "Sure, let's talk. Does Thursday at 3pm work? Feel free to send an invite.", summary: "Asked to meet Thursday 3pm." },
    { sentiment: "positive", body: "Happy to take a call next week. Tuesday or Wednesday morning is best for me.", summary: "Wants a call Tue/Wed morning next week." },
  ],
  question: [{ sentiment: "neutral", body: "Do you integrate with HubSpot? We'd need contacts to sync both ways.", summary: "Asked about a two-way HubSpot sync." }],
  referral: [{ sentiment: "neutral", body: "I'm not the right person — please reach out to our Head of Sales, she owns this.", summary: "Referred to their Head of Sales." }],
  not_now: [{ sentiment: "neutral", body: "Not a priority until Q1, sorry. Feel free to check back in January.", summary: "Not now; check back in January." }],
  not_interested: [{ sentiment: "negative", body: "Thanks, but we're happy with our current setup.", summary: "Not interested; happy with current tool." }],
  out_of_office: [{ sentiment: "neutral", body: "I'm out of the office until Monday with limited access to email. For urgent matters contact ops@ our domain.", summary: "Out of office until Monday." }],
};

type ConvOut = { conversationId: string; contact: Ct; lastAt: Date; replied: boolean; category: string };
const conversations: ConvOut[] = [];
const messageRows: Prisma.MessageCreateManyInput[] = [];
const eventRows: Prisma.MessageEventCreateManyInput[] = [];
const convRows: Prisma.ConversationCreateManyInput[] = [];
const enrollRows: Prisma.EnrollmentCreateManyInput[] = [];
const execRows: Prisma.StepExecutionCreateManyInput[] = [];
const mailboxDaily = new Map<string, number>();

const fill = (s: string, c: Ct, from: { displayName: string }) =>
  s.replaceAll("{{firstName}}", c.first).replaceAll("{{company}}", c.company?.name ?? "your team").replaceAll("{{senderName}}", from.displayName.split(" ")[0] ?? "");

type CampaignPlan = {
  name: string; description: string; status: "running" | "completed" | "paused" | "draft"; startedDaysAgo: number;
  steps: StepDef[]; audience: Contact[]; ownerId: string; mailboxIds: string[]; replyRate: number;
};
type Contact = Ct;

async function runCampaign(p: CampaignPlan) {
  const createdAt = ago(p.startedDaysAgo + 2);
  const sequenceId = await sequence(p.name, "campaign", p.steps, "", createdAt);
  const id = uuid7(createdAt);
  const startedAt = p.status === "draft" ? null : ago(p.startedDaysAgo, 9);
  await prisma.campaign.create({
    data: {
      id, workspaceId: W, name: p.name, description: p.description, status: p.status, sequenceId,
      audience: { type: "contacts", contactIds: p.audience.map((c) => c.id) },
      schedule: { timezone: ws!.timezone || "UTC", days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" },
      settings: { dailyNewLimit: 40, stopOnReply: true, stopOnAutoReply: false, stopOnMeeting: true, stopOnDealWon: true, trackOpens: true, trackClicks: true, unsubscribeLink: true, gapSeconds: 120 },
      ownerId: p.ownerId, startedAt, createdById: p.ownerId, createdAt,
      pausedAt: p.status === "paused" ? ago(3) : null,
      completedAt: p.status === "completed" ? ago(p.startedDaysAgo - 14) : null,
      mailboxes: { create: p.mailboxIds.map((mailboxId) => ({ workspaceId: W, mailboxId })) },
    },
  });
  if (!startedAt) return id;

  const emailPositions = p.steps.map((s, i) => (s.type === "email" ? i : -1)).filter((i) => i >= 0);
  let positive = 0;
  for (const [n, c] of p.audience.entries()) {
    const mailboxId = p.mailboxIds[n % p.mailboxIds.length]!;
    const box = mailboxes.find((m) => m.id === mailboxId)!;
    // Enrolled in waves, so a running campaign has people at every stage of the sequence.
    const enrolledAt = new Date(startedAt.getTime() + Math.floor(n / 4) * 1.5 * DAY + n * 7 * MIN);
    const enrollmentId = uuid7(enrolledAt);
    const conversationId = uuid7(enrolledAt);
    const rootId = msgId("sentosh-demo.example");
    let t = new Date(enrolledAt.getTime() + int(5, 90) * MIN);
    let stepRun = 0;
    let position = 0;
    let status: Prisma.EnrollmentCreateManyInput["status"] = "active";
    let stopReason = "";
    let repliedAt: Date | null = null;
    let completedAt: Date | null = null;
    let nextRunAt: Date | null = null;
    let lastOut: Date | null = null;
    let lastIn: Date | null = null;
    let category = "";
    const subject = fill(tIntro.subject, c, box);
    const willReply = chance(p.replyRate) && c.status !== "new";
    const replyAfter = willReply ? int(0, emailPositions.length - 1) : -1;
    const bounces = !willReply && chance(0.05);

    for (let pos = 0; pos < p.steps.length; pos++) {
      const step = p.steps[pos]!;
      if (step.type === "wait") {
        t = new Date(t.getTime() + Number(step.config.delayMinutes) * MIN + int(0, 120) * MIN);
        continue;
      }
      if (t.getTime() > NOW - 30 * MIN) {
        // This step is still ahead of us.
        position = pos;
        nextRunAt = p.status === "running" ? new Date(Math.max(t.getTime(), NOW + int(6, 96) * HOUR)) : null;
        break;
      }
      stepRun += 1;
      const execAt = t;
      if (step.type === "call_task") {
        execRows.push({ workspaceId: W, enrollmentId, campaignId: id, position: pos, stepType: "call_task", stepRun, status: "succeeded", result: { taskCreated: true }, startedAt: execAt, finishedAt: execAt });
        position = pos + 1;
        continue;
      }
      // An email step.
      const idx = emailPositions.indexOf(pos);
      const messageId = uuid7(execAt);
      const providerMessageId = idx === 0 ? rootId : msgId("sentosh-demo.example");
      const own = String(step.config.subject ?? "");
      const subj = own ? fill(own, c, box) : `Re: ${subject}`;
      const opened = chance(0.58) ? new Date(execAt.getTime() + int(10, 600) * MIN) : null;
      const clicked = opened && chance(0.22) ? new Date(opened.getTime() + int(1, 30) * MIN) : null;
      const bounced = bounces && idx === 0;
      messageRows.push({
        id: messageId, workspaceId: W, conversationId, channel: "email", direction: "outbound", status: bounced ? "bounced" : "sent",
        fromAddress: box.email, toAddress: c.email, subject: subj, bodyText: fill(String(step.config.body ?? ""), c, box),
        providerMessageId, inReplyTo: idx === 0 ? null : rootId, references: idx === 0 ? null : rootId,
        authorId: null, enrollmentId, campaignId: id, mailboxId, templateId: String(step.config.templateId ?? "") || null,
        attempts: 1, sentAt: execAt, bouncedAt: bounced ? new Date(execAt.getTime() + 2 * MIN) : null,
        openedAt: bounced || !opened || opened.getTime() > NOW ? null : opened, openCount: opened && !bounced && opened.getTime() < NOW ? int(1, 4) : 0,
        clickedAt: bounced || !clicked || clicked.getTime() > NOW ? null : clicked, clickCount: clicked && !bounced && clicked.getTime() < NOW ? 1 : 0,
        createdAt: execAt,
      });
      eventRows.push({ workspaceId: W, messageId, type: "sent", occurredAt: execAt });
      if (bounced) eventRows.push({ workspaceId: W, messageId, type: "bounced", data: { reason: "550 5.1.1 Mailbox does not exist" }, occurredAt: new Date(execAt.getTime() + 2 * MIN) });
      else {
        if (opened && opened.getTime() < NOW) eventRows.push({ workspaceId: W, messageId, type: "opened", occurredAt: opened });
        if (clicked && clicked.getTime() < NOW) eventRows.push({ workspaceId: W, messageId, type: "clicked", data: { url: "https://sentosh-demo.example/demo" }, occurredAt: clicked });
      }
      execRows.push({ workspaceId: W, enrollmentId, campaignId: id, position: pos, stepType: "email", stepRun, status: "succeeded", messageId, result: { mailboxId }, startedAt: execAt, finishedAt: execAt });
      const day = execAt.toISOString().slice(0, 10);
      mailboxDaily.set(`${mailboxId}|${day}`, (mailboxDaily.get(`${mailboxId}|${day}`) ?? 0) + 1);
      act({ contactId: c.id, actorId: null, type: "email.sent", summary: `Email sent: ${subj}`, data: { campaignId: id, messageId }, occurredAt: execAt });
      lastOut = execAt;
      position = pos + 1;

      if (bounced) {
        status = "stopped"; stopReason = "bounced"; completedAt = new Date(execAt.getTime() + 2 * MIN);
        act({ contactId: c.id, type: "email.bounced", summary: `Email to ${c.email} bounced`, occurredAt: completedAt });
        break;
      }
      if (idx === replyAfter) {
        const at = clampPast(new Date(execAt.getTime() + int(40, 60 * 30) * MIN));
        category = c.status === "not_interested" ? "not_interested" : c.status === "interested" || c.status === "customer" ? pick(["interested", "meeting_request"]) : pick(["question", "referral", "not_now", "out_of_office", "interested"]);
        const r = pick(replyBodies[category]!);
        const auto = category === "out_of_office";
        const inId = uuid7(at);
        messageRows.push({
          id: inId, workspaceId: W, conversationId, channel: "email", direction: "inbound", status: "received", fromAddress: c.email, toAddress: box.email,
          subject: `Re: ${subject}`, bodyText: r.body, providerMessageId: msgId(c.company?.domain ?? "mail.example"), inReplyTo: providerMessageId, references: rootId,
          isAutoReply: auto, mailboxId, campaignId: id, enrollmentId, receivedAt: at, createdAt: at,
        });
        act({ contactId: c.id, type: "email.received", summary: auto ? `Auto-reply from ${c.full}` : `${c.full} replied: “${r.body.slice(0, 60)}…”`, data: { campaignId: id }, occurredAt: at });
        lastIn = at;
        if (!auto) {
          status = "stopped"; stopReason = "replied"; repliedAt = at; completedAt = at;
          if (r.sentiment === "positive") positive += 1;
          convRows.push(conv(conversationId, c, box, subject, rootId, id, enrolledAt, lastOut, lastIn, { category, sentiment: r.sentiment, summary: r.summary }));
          conversations.push({ conversationId, contact: c, lastAt: at, replied: true, category });
          break;
        }
      }
      if (pos === emailPositions[emailPositions.length - 1]) {
        status = "completed"; completedAt = execAt; position = p.steps.length;
      }
    }
    if (p.status === "completed" && status === "active") { status = "completed"; completedAt = completedAt ?? lastOut; nextRunAt = null; }
    if (p.status === "paused" && status === "active") status = "paused";
    if (!repliedAt && lastOut) {
      convRows.push(conv(conversationId, c, box, subject, rootId, id, enrolledAt, lastOut, lastIn, category ? { category, sentiment: "neutral", summary: "Automatic out-of-office reply." } : null));
      conversations.push({ conversationId, contact: c, lastAt: lastIn ?? lastOut, replied: false, category });
    }
    enrollRows.push({
      id: enrollmentId, workspaceId: W, campaignId: id, contactId: c.id, status, position, stepRun, nextRunAt: status === "active" ? nextRunAt : null,
      mailboxId, threadMessageId: lastOut ? rootId : null, threadSubject: lastOut ? subject : null, conversationId: lastOut ? conversationId : null,
      stopReason, repliedAt, enrolledById: p.ownerId, source: "manual", enrolledAt, completedAt,
    });
    act({ contactId: c.id, actorId: p.ownerId, type: "campaign.enrolled", summary: `Enrolled in ${p.name}`, data: { campaignId: id }, occurredAt: enrolledAt });
  }
  await prisma.campaign.update({ where: { id }, data: { positiveReplyCount: positive } });
  return id;
}

function conv(
  id: string, c: Ct, box: { id: string; email: string }, subject: string, rootId: string, campaignId: string,
  createdAt: Date, lastOut: Date | null, lastIn: Date | null, ai: { category: string; sentiment: string; summary: string } | null,
): Prisma.ConversationCreateManyInput {
  const last = [lastOut, lastIn].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? createdAt;
  return {
    id, workspaceId: W, channel: "email", contactId: c.id, subject, mailboxId: box.id, externalKey: `${box.id}:${rootId}`,
    peer: c.email, handle: c.email, displayName: c.full, assigneeId: c.ownerId, status: "open",
    unread: Boolean(lastIn && NOW - lastIn.getTime() < 4 * DAY), campaignId,
    lastMessageAt: last, lastInboundAt: lastIn, lastOutboundAt: lastOut,
    aiCategory: ai?.category ?? "", aiSentiment: ai?.sentiment ?? "", aiSummary: ai?.summary ?? "", aiUpdatedAt: ai && lastIn ? lastIn : null,
    createdAt,
  };
}

const reachable = contacts.filter((c) => c.status !== "do_not_contact" && c.id !== dup.id);
const companyContacts = reachable.filter((c) => c.company);
const webinarAudience = reachable.filter((c) => c.status !== "new").slice(0, 14);
const coldAudience = companyContacts.filter((c) => c.status !== "new" && !webinarAudience.includes(c)).slice(0, 24);
const partnerAudience = reachable.filter((c) => !webinarAudience.includes(c) && !coldAudience.includes(c)).slice(0, 8);

const webinarCampaign = await runCampaign({
  name: "September webinar follow-up", description: "Thank-you and follow-up to everyone who joined the outbound playbooks webinar.", status: "completed",
  startedDaysAgo: 38, steps: [emailStep(tWebinar), wait(2), emailStep({ ...tFollow, subject: "" })], audience: webinarAudience,
  ownerId: maya.id, mailboxIds: [mailboxes[1]!.id], replyRate: 0.4,
});
const coldCampaign = await runCampaign({
  name: "Q4 SaaS & ops leaders outreach", description: "Main Q4 outbound push to operations and growth leaders.", status: "running",
  startedDaysAgo: 12, steps: coldSteps, audience: coldAudience, ownerId: me.id, mailboxIds: mailboxes.map((m) => m.id), replyRate: 0.35,
});
await runCampaign({
  name: "Agency partner programme", description: "Invite agencies to resell Sentosh to their clients.", status: "paused",
  startedDaysAgo: 9, steps: [emailStep(tIntro), wait(4), emailStep({ ...tFollow, subject: "" })], audience: partnerAudience,
  ownerId: rafael.id, mailboxIds: [mailboxes[0]!.id], replyRate: 0.25,
});
await runCampaign({
  name: "Holiday reactivation", description: "Win back cold leads before the holidays. Not started yet.", status: "draft",
  startedDaysAgo: 0, steps: [emailStep(tIntro), wait(5), emailStep(tBreakup)], audience: [], ownerId: me.id, mailboxIds: [mailboxes[0]!.id], replyRate: 0,
});

// ─── Inbox beyond campaigns: inbound email, WhatsApp, Telegram ──────────────

const waId = uuid7(ago(40));
const tgId = uuid7(ago(40));
await prisma.channelIntegration.createMany({
  data: [
    { id: waId, workspaceId: W, channel: "whatsapp", provider: "meta_cloud", name: "WhatsApp — Sales line", status: "connected", config: { phoneNumberId: "demo-109876543210", displayNumber: "+1 555 010 4477" }, webhookKey: randomBytes(18).toString("hex"), externalId: `demo-${randomBytes(6).toString("hex")}`, lastEventAt: ago(0.3), createdById: me.id, createdAt: ago(40) },
    { id: tgId, workspaceId: W, channel: "telegram", provider: "telegram_bot", name: "Telegram — @SentoshSalesBot", status: "connected", config: { botUsername: "SentoshSalesBot" }, webhookKey: randomBytes(18).toString("hex"), externalId: `demo-${randomBytes(6).toString("hex")}`, lastEventAt: ago(1), createdById: me.id, createdAt: ago(40) },
  ],
});

type Line = [dir: "in" | "out", text: string, minutesAfterStart: number];
function chat(channel: "whatsapp" | "telegram" | "email", c: Ct, startDaysAgo: number, lines: Line[], extra: { subject?: string; unread?: boolean; assigneeId?: string; ai?: [string, string, string] } = {}) {
  const start = ago(startDaysAgo);
  const id = uuid7(start);
  const integrationId = channel === "whatsapp" ? waId : channel === "telegram" ? tgId : null;
  const box = mailboxes[0]!;
  const handle = channel === "email" ? c.email : channel === "whatsapp" ? (c.phone ?? `+1555${int(1000000, 9999999)}`) : `@${c.first.toLowerCase()}_${c.last.toLowerCase()}`;
  let lastIn: Date | null = null, lastOut: Date | null = null;
  for (const [dir, text, after] of lines) {
    const at = clampPast(new Date(start.getTime() + after * MIN));
    const out = dir === "out";
    messageRows.push({
      id: uuid7(at), workspaceId: W, conversationId: id, channel, direction: out ? "outbound" : "inbound", status: out ? (channel === "email" ? "sent" : "read") : "received",
      fromAddress: out ? (channel === "email" ? box.email : "") : handle, toAddress: out ? handle : channel === "email" ? box.email : "",
      subject: channel === "email" ? (out ? `Re: ${extra.subject}` : extra.subject ?? "") : "", bodyText: text,
      providerMessageId: channel === "email" ? msgId(out ? "sentosh-demo.example" : c.company?.domain ?? "mail.example") : `demo.${randomBytes(8).toString("hex")}`,
      authorId: out ? (extra.assigneeId ?? c.ownerId) : null, mailboxId: channel === "email" ? box.id : null, channelIntegrationId: integrationId,
      sentAt: out ? at : null, deliveredAt: out && channel !== "email" ? at : null, readAt: out && channel !== "email" ? new Date(at.getTime() + 3 * MIN) : null, receivedAt: out ? null : at, createdAt: at,
    });
    if (out) lastOut = at; else lastIn = at;
  }
  const last = [lastIn, lastOut].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0]!;
  convRows.push({
    id, workspaceId: W, channel, contactId: c.id, subject: extra.subject ?? "", mailboxId: channel === "email" ? box.id : null, channelIntegrationId: integrationId,
    externalKey: channel === "email" ? `${box.id}:${msgId("demo")}` : `${integrationId}:${handle}`, peer: channel === "telegram" ? String(int(100000000, 999999999)) : handle, handle,
    displayName: c.full, assigneeId: extra.assigneeId ?? c.ownerId, status: "open", unread: extra.unread ?? false,
    lastMessageAt: last, lastInboundAt: lastIn, lastOutboundAt: lastOut,
    aiCategory: extra.ai?.[0] ?? "", aiSentiment: extra.ai?.[1] ?? "", aiSummary: extra.ai?.[2] ?? "", aiUpdatedAt: extra.ai ? lastIn : null, createdAt: start,
  });
  conversations.push({ conversationId: id, contact: c, lastAt: last, replied: Boolean(lastIn), category: extra.ai?.[0] ?? "" });
  return id;
}

const freeForChat = reachable.filter((c) => !coldAudience.includes(c) && !webinarAudience.includes(c) && !partnerAudience.includes(c));
const chatPick = (i: number) => freeForChat[i % freeForChat.length] ?? reachable[i]!;
const waConvo = chat("whatsapp", chatPick(0), 2, [
  ["in", "Hi! Saw your post about the outreach workspace. Do you offer a trial for agencies?", 0],
  ["out", "Hi! Yes — 14 days, all features. Want me to set one up for your team?", 12],
  ["in", "Yes please. We're 4 people. Can we also connect two mailboxes?", 30],
  ["out", "Absolutely, up to 5 on the trial. I'll send the invite to this number's email — what's the best address?", 41],
  ["in", "Use the one on our website contact page 👍 thanks!", 2 * 60 * 24 + 15],
], { unread: true, ai: ["interested", "positive", "Agency of 4 wants a trial with two mailboxes."] });
chat("whatsapp", chatPick(1), 6, [
  ["out", "Hi, reminder of our call tomorrow at 11:00. Reply here if you need to reschedule.", 0],
  ["in", "Thanks, can we push to 14:00?", 25],
  ["out", "Done — moved to 14:00. Talk then!", 31],
], { ai: ["meeting_request", "neutral", "Asked to move tomorrow's call to 14:00."] });
chat("whatsapp", chatPick(2), 0.4, [["in", "Hello, is the pricing on your website per user or per workspace?", 0]], { unread: true, ai: ["question", "neutral", "Asked whether pricing is per user or per workspace."] });
chat("telegram", chatPick(3), 1, [
  ["in", "/start", 0],
  ["out", "Hi! This is the Sentosh sales team. How can we help?", 1],
  ["in", "Looking for a tool to manage cold email + calls for a 10-person team. Can I get a demo?", 4],
], { unread: true, ai: ["meeting_request", "positive", "10-person team asking for a demo of email + calling."] });
chat("telegram", chatPick(4), 8, [
  ["in", "Hey, quick question about the API — is there a webhook for new replies?", 0],
  ["out", "Yes! Settings → Integrations → Webhooks, event \"reply.received\". Docs link: https://sentosh-demo.example/docs/webhooks", 20],
  ["in", "Perfect, thank you", 26],
]);
chat("email", chatPick(5), 1.5, [
  ["in", "Hi team,\n\nWe're a 25-person logistics company evaluating outreach tools. Could you send a quote for 8 seats with calling included?\n\nThanks", 0],
], { subject: "Quote request — 8 seats", unread: true, assigneeId: maya.id, ai: ["interested", "positive", "Inbound quote request for 8 seats with calling."] });
chat("email", chatPick(6), 5, [
  ["in", "Hello, we met at SaaStock. Following up as promised — when are you free for a call?", 0],
  ["out", "Great to hear from you! How about Thursday 10:00 or Friday 15:00?", 90],
  ["in", "Friday 15:00 works. Send the invite to this address.", 300],
  ["out", "Invite sent — see you Friday.", 320],
], { subject: "Great meeting you at SaaStock", assigneeId: rafael.id, ai: ["meeting_request", "positive", "Booked a call for Friday 15:00 after SaaStock."] });

await prisma.conversation.createMany({ data: convRows });
await prisma.message.createMany({ data: messageRows });
await prisma.messageEvent.createMany({ data: eventRows });
await prisma.enrollment.createMany({ data: enrollRows });
await prisma.stepExecution.createMany({ data: execRows });
await prisma.mailboxDailyCount.createMany({
  data: [...mailboxDaily].map(([k, count]) => {
    const [mailboxId, day] = k.split("|") as [string, string];
    return { workspaceId: W, mailboxId, day, count };
  }),
});
await prisma.conversationNote.createMany({
  data: [
    { workspaceId: W, conversationId: waConvo, authorId: maya.id, body: "Agency lead — good fit for the partner programme. I'll take the trial setup.", createdAt: ago(1) },
    ...conversations.filter((c) => c.replied && c.category === "question").slice(0, 2).map((c) => ({ workspaceId: W, conversationId: c.conversationId, authorId: priya.id, body: "Checked with product: two-way HubSpot sync is on the roadmap for next month.", createdAt: c.lastAt })),
  ],
});

// ─── Pipeline and deals ──────────────────────────────────────────────────────

let pipeline = await prisma.pipeline.findFirst({ where: { workspaceId: W, isDefault: true, archivedAt: null }, include: { stages: { orderBy: { position: "asc" } } } });
pipeline ??= await prisma.pipeline.findFirst({ where: { workspaceId: W, archivedAt: null }, include: { stages: { orderBy: { position: "asc" } } } });
if (!pipeline) {
  pipeline = await prisma.pipeline.create({
    data: {
      workspaceId: W, name: "Sales pipeline", isDefault: true,
      stages: { create: (["New Lead", "Contacted", "Qualified", "Meeting Booked", "Proposal Sent", "Negotiation", "Won", "Lost"] as const).map((name, position) => ({ workspaceId: W, name, position, kind: name === "Won" ? "won" : name === "Lost" ? "lost" : "open", probability: [5, 15, 40, 60, 70, 80, 100, 0][position]! })) },
    },
    include: { stages: { orderBy: { position: "asc" } } },
  });
}
const openStages = pipeline.stages.filter((s) => s.kind === "open");
const wonStage = pipeline.stages.find((s) => s.kind === "won")!;
const lostStage = pipeline.stages.find((s) => s.kind === "lost")!;

const dealCandidates = contacts.filter((c) => c.company && ["replied", "interested", "customer", "not_interested", "contacted"].includes(c.status) && c.id !== dup.id);
const dealNames = ["Team plan", "Annual licence", "Pilot", "Expansion", "Agency bundle", "Onboarding package", "Enterprise rollout"];
const dealRows: Prisma.DealCreateManyInput[] = [];
const stageChangeRows: Prisma.DealStageChangeCreateManyInput[] = [];
const deals: { id: string; contact: Ct; status: string; name: string }[] = [];
const usedForDeal = new Set<string>();
for (const c of dealCandidates) {
  if (deals.length >= 22 || usedForDeal.has(c.company!.id)) continue;
  usedForDeal.add(c.company!.id);
  let target;
  let status: "open" | "won" | "lost" = "open";
  if (c.status === "customer") { target = wonStage; status = "won"; }
  else if (c.status === "not_interested") { target = lostStage; status = "lost"; }
  else if (c.status === "interested") target = pick(openStages.slice(Math.floor(openStages.length / 2)));
  else target = pick(openStages.slice(0, Math.ceil(openStages.length / 2)));
  const createdAt = ago(int(18, 45));
  const id = uuid7(createdAt);
  const path = pipeline.stages.filter((s) => s.kind === "open" && s.position <= (status === "open" ? target.position : int(openStages[2]?.position ?? 2, openStages[openStages.length - 1]!.position)));
  if (status !== "open") path.push(target);
  let t = createdAt.getTime();
  let from: string | null = null;
  const span = (NOW - 2 * DAY - t) / Math.max(1, path.length);
  for (const s of path) {
    stageChangeRows.push({ workspaceId: W, dealId: id, fromStageId: from, toStageId: s.id, changedById: c.ownerId, changedAt: new Date(t) });
    from = s.id;
    t += span * (0.6 + rand() * 0.4);
  }
  const enteredAt = new Date(stageChangeRows[stageChangeRows.length - 1]!.changedAt as Date);
  const name = `${c.company!.name} — ${pick(dealNames)}`;
  dealRows.push({
    id, workspaceId: W, pipelineId: pipeline.id, stageId: target.id, name, contactId: c.id, companyId: c.company!.id, ownerId: c.ownerId,
    value: int(5, 170) * 500, currency: ws.currency || "USD",
    expectedCloseDate: status === "open" ? ahead(int(7, 75)) : enteredAt,
    status, sourceCampaignId: coldAudience.includes(c) ? coldCampaign : webinarAudience.includes(c) ? webinarCampaign : null,
    wonReason: status === "won" ? pick(["Fastest onboarding of the three tools they trialled", "Calling + email in one place", "Price per seat"]) : "",
    lostReason: status === "lost" ? pick(["Went with an existing vendor", "No budget this year", "Chose to build in-house"]) : "",
    proposalUrl: target.position >= (openStages[4]?.position ?? 99) || status === "won" ? `https://sentosh-demo.example/proposals/${id.slice(0, 8)}` : "",
    description: `${c.full} (${c.title}) is the main contact.`,
    stageEnteredAt: enteredAt, closedAt: status === "open" ? null : enteredAt, createdById: c.ownerId, createdAt,
  });
  deals.push({ id, contact: c, status, name });
  act({ contactId: c.id, companyId: c.company!.id, dealId: id, actorId: c.ownerId, type: "deal.created", summary: `Deal created: ${name}`, occurredAt: createdAt });
  if (path.length > 1) act({ contactId: c.id, dealId: id, actorId: c.ownerId, type: "deal.stage_changed", summary: `Moved to ${target.name}`, data: { stage: target.name }, occurredAt: enteredAt });
}
await prisma.deal.createMany({ data: dealRows });
await prisma.dealStageChange.createMany({ data: stageChangeRows });

// ─── Meetings, tasks, calls, notes ──────────────────────────────────────────

const openDeals = deals.filter((d) => d.status === "open");
const meetingRows: Prisma.MeetingCreateManyInput[] = [];
const meetingPlan: [days: number, status: "scheduled" | "completed" | "no_show" | "canceled", title: string][] = [
  [-21, "completed", "Discovery call"], [-14, "completed", "Product demo"], [-9, "no_show", "Discovery call"], [-6, "completed", "Pricing walkthrough"],
  [-3, "canceled", "Technical deep-dive"], [-1, "completed", "Proposal review"], [0.2, "scheduled", "Demo for the sales team"], [1, "scheduled", "Discovery call"],
  [2, "scheduled", "Security review"], [4, "scheduled", "Contract negotiation"], [7, "scheduled", "Kick-off planning"],
];
for (const [i, [d, status, title]] of meetingPlan.entries()) {
  const deal = openDeals[i % Math.max(1, openDeals.length)] ?? deals[i % deals.length]!;
  const startsAt = d < 0 ? ago(-d, int(10, 16)) : d < 1 ? new Date(NOW + 3 * HOUR) : ahead(d, int(10, 16));
  meetingRows.push({
    workspaceId: W, contactId: deal.contact.id, dealId: deal.id, ownerId: deal.contact.ownerId, title: `${title} — ${deal.contact.company?.name ?? deal.contact.full}`,
    startsAt, endsAt: new Date(startsAt.getTime() + (title.includes("Discovery") ? 30 : 45) * MIN), location: pick(["Google Meet", "Zoom", "Phone", "Their office"]), status,
    notes: status === "completed" ? pick(["Good fit. They want a pilot for the SDR team first.", "Main concern is deliverability — send the warm-up guide.", "Budget approved for Q4; procurement needs a security questionnaire."]) : "",
    createdById: deal.contact.ownerId, createdAt: new Date(startsAt.getTime() - int(2, 6) * DAY),
  });
  if (status !== "canceled") act({ contactId: deal.contact.id, dealId: deal.id, actorId: deal.contact.ownerId, type: "meeting.booked", summary: `Meeting booked: ${title}`, occurredAt: new Date(startsAt.getTime() - 3 * DAY) });
}
await prisma.meeting.createMany({ data: meetingRows });

const taskRows: Prisma.TaskCreateManyInput[] = [];
const taskPlan: [type: Prisma.TaskCreateManyInput["type"], title: string, due: number, status: "open" | "done", priority: "low" | "medium" | "high" | "urgent"][] = [
  ["call", "Call back about pricing", -2, "open", "high"], ["follow_up", "Send case study", -1, "open", "medium"], ["proposal", "Draft proposal for pilot", 0.1, "open", "urgent"],
  ["review_reply", "Review reply and answer the HubSpot question", 0.2, "open", "high"], ["email", "Send meeting recap", 0.3, "open", "medium"], ["qualify", "Qualify inbound lead", 1, "open", "medium"],
  ["call", "Intro call", 1, "open", "medium"], ["meeting", "Prepare demo environment", 2, "open", "high"], ["follow_up", "Check in after board meeting", 3, "open", "low"],
  ["custom", "Update CRM notes from conference", 4, "open", "low"], ["follow_up", "Nudge on contract signature", 5, "open", "high"], ["call", "Renewal check-in", 9, "open", "medium"],
  ["email", "Send onboarding checklist", -6, "done", "medium"], ["call", "Discovery call", -9, "done", "high"], ["proposal", "Send revised quote", -4, "done", "high"],
  ["follow_up", "Share recording of webinar", -12, "done", "low"], ["qualify", "Research company before call", -3, "done", "medium"], ["review_reply", "Answer referral reply", -2, "done", "medium"],
];
for (const [i, [type, title, due, status, priority]] of taskPlan.entries()) {
  const d = deals[i % deals.length]!;
  const c = i % 3 === 2 ? reachable[(i * 5) % reachable.length]! : d.contact;
  const assignee = i < 7 ? me : reps[i % reps.length]!;
  const dueAt = due < 0 ? ago(-due, int(10, 17)) : due < 1 ? new Date(NOW + due * 10 * HOUR) : ahead(due, int(10, 17));
  taskRows.push({
    workspaceId: W, type, title: `${title} — ${c.full}`, description: pick(["", "", "See notes on the contact.", "They asked for this on the last call."]), status, priority, dueAt,
    completedAt: status === "done" ? new Date(dueAt.getTime() - int(1, 20) * HOUR) : null, completedById: status === "done" ? assignee.id : null,
    assigneeId: assignee.id, createdById: me.id, contactId: c.id, dealId: i % 3 === 2 ? null : d.id, source: i % 4 === 0 ? "sequence" : "manual",
    campaignId: i % 4 === 0 ? coldCampaign : null, createdAt: new Date(dueAt.getTime() - int(2, 5) * DAY),
  });
}
await prisma.task.createMany({ data: taskRows });

const callRows: Prisma.CallCreateManyInput[] = [];
const outcomes = [
  ["completed", "connected"], ["completed", "meeting_booked"], ["completed", "callback_requested"], ["no_answer", "no_answer"], ["completed", "left_voicemail"],
  ["busy", "busy"], ["completed", "not_interested"], ["completed", "connected"], ["no_answer", "no_answer"], ["completed", "meeting_booked"],
  ["completed", "wrong_number"], ["completed", "connected"], ["no_answer", "left_voicemail"], ["completed", "callback_requested"], ["completed", "connected"],
] as const;
for (const [i, [status, outcome]] of outcomes.entries()) {
  const withPhone = reachable.filter((x) => x.phone);
  const c = withPhone[(i * 2) % withPhone.length]!;
  const d = deals.find((x) => x.contact.id === c.id);
  const user = reps[i % reps.length]!;
  const startedAt = ago(int(0, 20), int(9, 17));
  const talked = status === "completed" && !["left_voicemail", "wrong_number"].includes(outcome);
  const durationSec = talked ? int(90, 1500) : outcome === "left_voicemail" ? int(25, 60) : null;
  callRows.push({
    workspaceId: W, contactId: c.id, dealId: d?.id, userId: user.id, direction: "outbound", provider: "manual", fromNumber: "+15550104477", toNumber: c.phone!,
    status, outcome, durationSec, startedAt, endedAt: durationSec ? new Date(startedAt.getTime() + durationSec * 1000) : startedAt,
    notes: talked ? pick(["Interested, wants a proposal by Friday.", "Uses spreadsheets today; pain is missed follow-ups.", "Asked to call back after their Q4 planning.", "Good conversation; looping in their ops lead."]) : "",
    callbackAt: outcome === "callback_requested" ? ahead(int(1, 4)) : null, createdAt: startedAt,
  });
  if (status === "completed") act({ contactId: c.id, dealId: d?.id, actorId: user.id, type: "call.completed", summary: `Call — ${outcome.replace(/_/g, " ")}${durationSec ? ` (${Math.round(durationSec / 60)} min)` : ""}`, occurredAt: startedAt });
}
await prisma.call.createMany({ data: callRows });

const noteBodies = [
  "Spoke with them at the conference — they run outbound from three Gmail accounts and a shared sheet. Strong fit.",
  "Decision maker is the COO; this contact is the champion. Budget conversation happens in November.",
  "Asked for references in their industry. Sent two case studies.",
  "Prefers WhatsApp over email for quick questions.",
  "Currently on a competitor; contract ends in January. Re-engage mid-December.",
  "Security questionnaire returned. Waiting on legal review.",
  "Wants SSO before rolling out to the whole team.",
];
const noteRows: Prisma.NoteCreateManyInput[] = [];
for (const [i, d] of deals.slice(0, 12).entries()) {
  const at = ago(int(1, 15));
  noteRows.push({ workspaceId: W, contactId: d.contact.id, companyId: d.contact.company?.id, dealId: i % 2 ? d.id : null, authorId: d.contact.ownerId, body: noteBodies[i % noteBodies.length]!, pinned: i < 3, createdAt: at });
  act({ contactId: d.contact.id, dealId: i % 2 ? d.id : null, actorId: d.contact.ownerId, type: "note.added", summary: "Note added", occurredAt: at });
}
await prisma.note.createMany({ data: noteRows });

// ─── Automation and notifications ───────────────────────────────────────────

const workflowDefs = [
  {
    name: "Round-robin new website leads", description: "Every new lead from the website goes to the next rep in line.", enabled: true, trigger: "contact.created",
    conditions: [{ field: "contact.leadSource", op: "is", value: "Website" }],
    actions: [{ type: "assign_contact", delayMinutes: 0, config: { strategy: "round_robin", overwrite: false } }, { type: "create_task", delayMinutes: 0, config: { title: "Qualify new website lead", type: "qualify", priority: "high", dueInMinutes: 240, assignTo: "owner" } }],
    runs: 14,
  },
  {
    name: "Positive reply → hot lead", description: "Tag and prioritise anyone who replies with interest.", enabled: true, trigger: "reply.received",
    conditions: [{ field: "event.category", op: "is", value: "interested" }],
    actions: [{ type: "add_tag", delayMinutes: 0, config: { tag: "Hot lead" } }, { type: "update_contact", delayMinutes: 0, config: { field: "priority", value: "high" } }, { type: "notify", delayMinutes: 0, config: { contactOwner: true, title: "A lead replied with interest" } }],
    runs: 9,
  },
  {
    name: "Deal reached Negotiation", description: "Tell admins when a deal enters negotiation.", enabled: true, trigger: "deal.stage_changed",
    conditions: [{ field: "deal.stage", op: "is", value: "Negotiation" }],
    actions: [{ type: "notify", delayMinutes: 0, config: { roles: ["owner", "admin"], title: "Deal in negotiation" } }],
    runs: 4,
  },
  {
    name: "Overdue task escalation", description: "Draft — escalates tasks overdue by a day.", enabled: false, trigger: "task.overdue", conditions: [],
    actions: [{ type: "notify", delayMinutes: 1440, config: { roles: ["manager"], title: "Task overdue for a day" } }], runs: 0,
  },
];
for (const wf of workflowDefs) {
  const createdAt = ago(35);
  const id = uuid7(createdAt);
  await prisma.workflow.create({
    data: {
      id, workspaceId: W, name: wf.name, description: wf.description, enabled: wf.enabled, trigger: wf.trigger, conditions: wf.conditions, actions: wf.actions,
      runCount: wf.runs, lastRunAt: wf.runs ? ago(int(0, 4)) : null, createdById: me.id, createdAt,
    },
  });
  if (!wf.runs) continue;
  await prisma.workflowRun.createMany({
    data: Array.from({ length: Math.min(wf.runs, 6) }, (_, i) => {
      const at = ago(i * 3 + int(0, 2));
      const ok = i !== 3;
      return {
        workspaceId: W, workflowId: id, eventId: uuid7(at), status: ok ? ("succeeded" as const) : ("skipped" as const), subjectType: "contact", subjectId: pick(reachable).id,
        actionIndex: ok ? wf.actions.length : 0, attempts: 1, createdAt: at, finishedAt: new Date(at.getTime() + 2000),
        log: ok
          ? [{ step: "conditions", met: true, at: at.toISOString() }, ...wf.actions.map((a, index) => ({ step: "action", index, type: a.type, status: "ok", at: at.toISOString() }))]
          : [{ step: "conditions", met: false, failed: wf.conditions[0] ?? null, at: at.toISOString() }],
      };
    }),
  });
}

const replied = conversations.filter((c) => c.replied).sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
await prisma.notification.createMany({
  data: [
    ...replied.slice(0, 4).map((c, i) => ({
      workspaceId: W, userId: me.id, type: "reply.received", title: `${c.contact.full} replied`, body: c.contact.company?.name ?? "",
      link: `/w/${W}/inbox?c=${c.conversationId}`, readAt: i < 2 ? null : c.lastAt, createdAt: c.lastAt,
    })),
    { workspaceId: W, userId: me.id, type: "task.assigned", title: "Maya assigned you a task", body: "Draft proposal for pilot", link: `/w/${W}/tasks`, createdAt: ago(0.5) },
    { workspaceId: W, userId: me.id, type: "campaign.completed", title: "Campaign finished: September webinar follow-up", body: `${webinarAudience.length} enrolled`, link: `/w/${W}/campaigns/${webinarCampaign}`, readAt: ago(20), createdAt: ago(24) },
    { workspaceId: W, userId: me.id, type: "meeting.booked", title: "Meeting booked for tomorrow", body: meetingRows[7]?.title ?? "", link: `/w/${W}/meetings`, createdAt: ago(1) },
    { workspaceId: W, userId: me.id, type: "workflow.notify", title: "Deal in negotiation", body: deals.find((d) => d.status === "open")?.name ?? "", link: `/w/${W}/deals`, readAt: ago(2), createdAt: ago(3) },
  ],
});

await prisma.activity.createMany({ data: activities });

// Campaign counters, computed the way EngineService.refreshStats does (the worker only refreshes recent campaigns).
await prisma.$executeRaw`
  UPDATE "Campaign" c SET
    "enrolledCount" = (SELECT count(*)::int FROM "Enrollment" e WHERE e."campaignId" = c.id),
    "replyCount" = (SELECT count(*)::int FROM "Enrollment" e WHERE e."campaignId" = c.id AND e."repliedAt" IS NOT NULL),
    "failedCount" = (SELECT count(*)::int FROM "Enrollment" e WHERE e."campaignId" = c.id AND e.status = 'failed'),
    "sentCount" = (SELECT count(*)::int FROM "Message" m WHERE m."campaignId" = c.id AND m.direction = 'outbound' AND m."sentAt" IS NOT NULL),
    "openCount" = (SELECT count(*)::int FROM "Message" m WHERE m."campaignId" = c.id AND m.direction = 'outbound' AND m."openedAt" IS NOT NULL),
    "clickCount" = (SELECT count(*)::int FROM "Message" m WHERE m."campaignId" = c.id AND m.direction = 'outbound' AND m."clickedAt" IS NOT NULL),
    "bounceCount" = (SELECT count(*)::int FROM "Message" m WHERE m."campaignId" = c.id AND m.direction = 'outbound' AND (m."bouncedAt" IS NOT NULL OR m.status = 'bounced')),
    "statsUpdatedAt" = now()
  WHERE c."workspaceId" = ${W}::uuid`;

const counts = {
  teammates: teammates.length, companies: companies.length, contacts: contacts.length, deals: deals.length, campaigns: 4,
  conversations: convRows.length, messages: messageRows.length, calls: callRows.length, meetings: meetingRows.length, tasks: taskRows.length, workflows: workflowDefs.length,
};
console.log(`Demo data added to "${ws.name}":`, counts);
await prisma.$disconnect();
