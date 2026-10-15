import { WORKFLOW_ACTIONS, type WorkflowTrigger } from "./schemas.js";

/*
 * Two kinds of workflow, told apart by their trigger: sales (leads, replies,
 * meetings, deals, tasks) and email marketing (list joins, opens, clicks,
 * unsubscribes). The builder offers each kind only its own triggers and the
 * actions that make sense there, and starts from a template — so nothing is
 * stored about the kind: an existing workflow's trigger already says it.
 */

export const WORKFLOW_KINDS = ["sales", "marketing"] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];
export type WorkflowActionType = (typeof WORKFLOW_ACTIONS)[number];

export const TRIGGER_KIND: Record<WorkflowTrigger, WorkflowKind> = {
  "contact.created": "sales",
  "lead.imported": "sales",
  "contact.qualified": "sales",
  "reply.received": "sales",
  "call.completed": "sales",
  "meeting.booked": "sales",
  "deal.stage_changed": "sales",
  "task.overdue": "sales",
  "list.subscribed": "marketing",
  "marketing.opened": "marketing",
  "marketing.clicked": "marketing",
  "marketing.unsubscribed": "marketing",
};

/** The kind a trigger belongs to; an unknown one counts as sales. */
export const workflowKind = (trigger: string): WorkflowKind => TRIGGER_KIND[trigger as WorkflowTrigger] ?? "sales";

/** Actions offered per kind (some fit both). The API accepts any action on any trigger; this only shapes the builder. */
export const KIND_ACTIONS: Record<WorkflowKind, WorkflowActionType[]> = {
  sales: ["assign_contact", "create_task", "notify", "update_contact", "add_tag", "enroll_campaign", "stop_campaigns", "add_to_list"],
  marketing: ["hand_to_sales", "add_to_list", "remove_from_list", "add_tag", "update_contact", "notify", "create_task", "assign_contact"],
};

/** Event fields a condition can read per trigger, beyond the contact and deal ones (`event.<key>`). */
export const TRIGGER_EVENT_FIELDS: Partial<Record<WorkflowTrigger, { key: string; label: string }[]>> = {
  "list.subscribed": [
    { key: "listName", label: "List name" },
    { key: "source", label: "How they joined" },
  ],
  "marketing.opened": [{ key: "campaignName", label: "Campaign name" }],
  "marketing.clicked": [
    { key: "url", label: "Link clicked" },
    { key: "campaignName", label: "Campaign name" },
  ],
  "marketing.unsubscribed": [
    { key: "scope", label: "From (all / list)" },
    { key: "listName", label: "List name" },
    { key: "campaignName", label: "Campaign name" },
  ],
  "lead.imported": [{ key: "source", label: "Import source" }],
};

export type WorkflowTemplateAction = { type: WorkflowActionType; delayMinutes?: number; config: Record<string, unknown> };

export type WorkflowTemplate = {
  id: string;
  kind: WorkflowKind;
  name: string;
  /** One line: what it does, in the person's terms. */
  summary: string;
  description: string;
  trigger: WorkflowTrigger;
  conditions: { field: string; op: "is" | "is_not" | "contains" | "gt" | "lt" | "exists"; value: string }[];
  actions: WorkflowTemplateAction[];
  /** What is left to choose before it can be saved (a list, a campaign…), shown on the card. */
  todo?: string;
};

const DAY = 24 * 60;

/** Ready-made workflows: pick one, fill in what `todo` names, turn it on. */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  // ─── Sales ────────────────────────────────────────────────────────────────
  {
    id: "sales-speed-to-lead",
    kind: "sales",
    name: "Speed to lead: call within 15 minutes",
    summary: "A new lead gets an owner at once, an urgent call task due in 15 minutes, and the owner an email alert.",
    description: "Leads called in the first minutes convert several times better than ones called the next day.",
    trigger: "contact.created",
    conditions: [],
    actions: [
      { type: "assign_contact", config: { strategy: "round_robin", overwrite: false } },
      { type: "create_task", config: { title: "Call the new lead now", type: "call", priority: "urgent", dueInMinutes: 15, assignTo: "owner" } },
      { type: "notify", config: { contactOwner: true, title: "New lead: call within 15 minutes", email: true } },
    ],
  },
  {
    id: "sales-round-robin",
    kind: "sales",
    name: "Assign imported leads round-robin",
    summary: "Every lead from a form, the API or a CSV gets an owner, in turn, and a first-touch task.",
    description: "Spreads new leads evenly across the team so nobody sits unowned.",
    trigger: "lead.imported",
    conditions: [],
    actions: [
      { type: "assign_contact", config: { strategy: "round_robin", overwrite: false } },
      { type: "create_task", config: { title: "First touch with this new lead", type: "follow_up", priority: "medium", dueInMinutes: DAY, assignTo: "owner" } },
    ],
  },
  {
    id: "sales-new-lead-sequence",
    kind: "sales",
    name: "New lead → outreach sequence",
    summary: "Every new lead from a form, the API or an import starts your email sequence automatically.",
    description: "Use an outreach campaign with “Always on” turned on, so it keeps taking new leads.",
    trigger: "lead.imported",
    conditions: [],
    actions: [
      { type: "add_tag", config: { tags: ["In sequence"] } },
      { type: "enroll_campaign", config: { campaignId: "" } },
    ],
    todo: "Choose an always-on campaign",
  },
  {
    id: "sales-referral-vip",
    kind: "sales",
    name: "Referral lead → VIP treatment",
    summary: "Leads whose source mentions a referral are tagged, made high priority and called within two hours.",
    description: "Referrals close best — make sure they never wait.",
    trigger: "contact.created",
    conditions: [{ field: "contact.leadSource", op: "contains", value: "referral" }],
    actions: [
      { type: "update_contact", config: { field: "priority", value: "high" } },
      { type: "add_tag", config: { tags: ["Referral", "VIP"] } },
      { type: "create_task", config: { title: "Call the referral", type: "call", priority: "high", dueInMinutes: 120, assignTo: "owner" } },
    ],
  },
  {
    id: "sales-reply-task",
    kind: "sales",
    name: "Reply received → answer within the hour",
    summary: "When someone replies, they are marked Replied, made high priority and their owner gets a task due in an hour.",
    description: "Makes sure every reply is answered while the person is still interested.",
    trigger: "reply.received",
    conditions: [],
    actions: [
      { type: "update_contact", config: { field: "status", value: "replied" } },
      { type: "update_contact", config: { field: "priority", value: "high" } },
      { type: "create_task", config: { title: "Answer the reply", type: "review_reply", priority: "high", dueInMinutes: 60, assignTo: "owner" } },
    ],
  },
  {
    id: "sales-qualified-handoff",
    kind: "sales",
    name: "Qualified → stop outreach and call",
    summary: "A qualified contact leaves automated sequences, is tagged Qualified and gets a discovery-call task.",
    description: "Hands qualified people from automation to a person.",
    trigger: "contact.qualified",
    conditions: [],
    actions: [
      { type: "stop_campaigns", config: {} },
      { type: "add_tag", config: { tags: ["Qualified"] } },
      { type: "create_task", config: { title: "Discovery call", type: "call", priority: "high", dueInMinutes: DAY, assignTo: "owner" } },
    ],
  },
  {
    id: "sales-meeting-prep",
    kind: "sales",
    name: "Meeting booked → pause outreach and prepare",
    summary: "Stops their email sequences, marks them Interested and reminds the owner to prepare.",
    description: "No automated follow-up lands after they have already said yes, and nobody walks in cold.",
    trigger: "meeting.booked",
    conditions: [],
    actions: [
      { type: "stop_campaigns", config: {} },
      { type: "update_contact", config: { field: "status", value: "interested" } },
      { type: "add_tag", config: { tags: ["Meeting booked"] } },
      { type: "create_task", config: { title: "Prepare for the meeting", type: "follow_up", priority: "medium", dueInMinutes: 120, assignTo: "owner" } },
    ],
  },
  {
    id: "sales-proposal-followup",
    kind: "sales",
    name: "Proposal sent → follow up in 3 days",
    summary: "When a deal reaches the proposal stage, the owner gets a follow-up task three days later.",
    description: "Most proposals are won on the follow-up. Change the stage name to match your pipeline.",
    trigger: "deal.stage_changed",
    conditions: [{ field: "deal.stage", op: "contains", value: "Proposal" }],
    actions: [
      { type: "create_task", config: { title: "Follow up on the proposal", type: "proposal", priority: "high", dueInMinutes: 3 * DAY, assignTo: "owner" } },
      { type: "add_tag", config: { tags: ["Proposal sent"] } },
    ],
  },
  {
    id: "sales-deal-won",
    kind: "sales",
    name: "Deal won → customer onboarding",
    summary: "Tells the team, marks the contact Customer, stops prospecting emails and creates an onboarding task.",
    description: "Celebrate the win and start the customer off well.",
    trigger: "deal.stage_changed",
    conditions: [{ field: "deal.status", op: "is", value: "won" }],
    actions: [
      { type: "notify", config: { roles: ["owner", "admin"], contactOwner: true, title: "Deal won", email: false } },
      { type: "stop_campaigns", config: {} },
      { type: "update_contact", config: { field: "status", value: "customer" } },
      { type: "add_tag", config: { tags: ["Customer"] } },
      { type: "create_task", config: { title: "Onboarding kickoff", type: "meeting", priority: "high", dueInMinutes: 2 * DAY, assignTo: "owner" } },
    ],
  },
  {
    id: "sales-deal-lost-nurture",
    kind: "sales",
    name: "Deal lost → win them back later",
    summary: "Tags the contact and gives the owner a task, due in 90 days, to check back in.",
    description: "A lost deal is often a “not now”. Come back when timing may have changed.",
    trigger: "deal.stage_changed",
    conditions: [{ field: "deal.status", op: "is", value: "lost" }],
    actions: [
      { type: "add_tag", config: { tags: ["Lost deal"] } },
      { type: "create_task", config: { title: "Check back in with this lost deal", type: "follow_up", priority: "low", dueInMinutes: 90 * DAY, assignTo: "owner" } },
    ],
  },
  {
    id: "sales-overdue-nudge",
    kind: "sales",
    name: "Overdue task → nudge, then escalate",
    summary: "An overdue task emails its owner at once, and tells the admins if it is still waiting a day later.",
    description: "Keeps follow-ups from slipping without managers chasing by hand.",
    trigger: "task.overdue",
    conditions: [],
    actions: [
      { type: "notify", config: { contactOwner: true, title: "A task is overdue", email: true } },
      { type: "notify", delayMinutes: DAY, config: { roles: ["admin"], title: "A task has been overdue for a day", email: false } },
    ],
  },

  // ─── Email marketing ──────────────────────────────────────────────────────
  {
    id: "mkt-welcome-tag",
    kind: "marketing",
    name: "New subscriber → tag and welcome",
    summary: "Everyone who joins a list is tagged Subscriber and added to your welcome list.",
    description: "Pair it with a marketing campaign sent to the welcome list.",
    trigger: "list.subscribed",
    conditions: [],
    actions: [
      { type: "add_tag", config: { tags: ["Subscriber"] } },
      { type: "add_to_list", config: { listId: "" } },
    ],
    todo: "Choose the welcome list",
  },
  {
    id: "mkt-click-to-sales",
    kind: "marketing",
    name: "Clicked pricing → hand to sales",
    summary: "Someone clicks a pricing link: they move to In sales and the owner gets a call task.",
    description: "Turns marketing interest into a sales conversation.",
    trigger: "marketing.clicked",
    conditions: [{ field: "event.url", op: "contains", value: "pricing" }],
    actions: [
      { type: "hand_to_sales", config: { createTask: true, taskTitle: "Call: clicked pricing in a marketing email", dueInMinutes: DAY } },
      { type: "notify", config: { contactOwner: true, title: "A subscriber clicked pricing", email: false } },
    ],
  },
  {
    id: "mkt-engaged-tag",
    kind: "marketing",
    name: "Opened an email → tag Engaged",
    summary: "Readers who open a campaign are tagged Engaged, so you can target them next.",
    description: "Build an engaged segment automatically.",
    trigger: "marketing.opened",
    conditions: [],
    actions: [{ type: "add_tag", config: { tags: ["Engaged"] } }],
  },
  {
    id: "mkt-nurture-move",
    kind: "marketing",
    name: "Move between lists",
    summary: "When someone joins one list, put them on the next and take them off the first.",
    description: "E.g. Webinar attendees → Nurture.",
    trigger: "list.subscribed",
    conditions: [{ field: "event.listName", op: "is", value: "" }],
    actions: [
      { type: "add_to_list", config: { listId: "" } },
      { type: "remove_from_list", config: { listId: "" } },
    ],
    todo: "Name the first list in the condition and choose both lists",
  },
  {
    id: "mkt-unsubscribed",
    kind: "marketing",
    name: "Unsubscribed → tag and tell the owner",
    summary: "Tags people who unsubscribe and lets their owner know.",
    description: "So sales knows not to push newsletter content.",
    trigger: "marketing.unsubscribed",
    conditions: [],
    actions: [
      { type: "add_tag", config: { tags: ["Unsubscribed"] } },
      { type: "notify", config: { contactOwner: true, title: "A contact unsubscribed from marketing email", email: false } },
    ],
  },
];
