import { z } from "zod";
import { ENROLLMENT_STATUSES, EnrollInput } from "@growthdesk/shared";
import { CampaignsService, EnrollmentListQuery } from "../../../campaigns/campaigns.service.js";
import { EnrollmentService, SKIP_LABELS, SKIP_REASONS, type Skipped } from "../../../campaigns/enrollment.service.js";
import { isUuid } from "../../../campaigns/campaign-config.js";
import { ContactsService } from "../../../crm/contacts.service.js";
import { holds, ownershipScope } from "../../../common/context.js";
import { badRequest, conflict, forbidden, notFound } from "../../../common/errors.js";
import { defineTool, pageInput, paged, type McpCtx, type McpDeps } from "../../tool.js";
import { describeLimits, describeSteps, firstSendAt, id, sendingMailboxes, validate } from "./shared.js";

/*
 * The people in a campaign. Enrolling and putting people back start sending
 * to them, so they are important actions (campaigns.launch, as in the
 * controller); pausing or resuming one contact is a plain write.
 */

const ENROLLABLE = ["scheduled", "running", "paused"];

const enrollmentOut = (e: Awaited<ReturnType<CampaignsService["enrollments"]>>["items"][number]) => ({
  id: e.id,
  status: e.status,
  contact: { id: e.contact.id, name: e.contact.fullName, email: e.contact.email, ...(e.contact.company ? { company: e.contact.company } : {}) },
  step: e.step ? `${e.step.position + 1}: ${e.step.type}` : null,
  ...(e.nextRunAt ? { nextRunAt: e.nextRunAt } : {}),
  ...(e.repliedAt ? { repliedAt: e.repliedAt } : {}),
  ...(e.lastError ? { lastError: e.lastError } : {}),
  ...(e.stopReason ? { stopReason: e.stopReason } : {}),
  ...(e.mailbox ? { mailbox: e.mailbox.email } : {}),
  enrolledAt: e.enrolledAt,
});

const skippedText = (s: Skipped) =>
  SKIP_REASONS.filter((r) => (s[r] ?? 0) > 0)
    .map((r) => `${s[r]} ${SKIP_LABELS[r]}`)
    .join(", ");

/** The campaign and one of its enrollments (with the contact), or a 404. */
async function oneEnrollment(ctx: McpCtx, deps: McpDeps, campaignId: string, enrollmentId: string) {
  const c = await deps.get(CampaignsService).get(ctx, campaignId);
  if (!isUuid(enrollmentId)) throw notFound("That enrollment");
  const e = await deps.prisma.db.enrollment.findFirst({
    where: { id: enrollmentId, workspaceId: ctx.workspace.id, campaignId: c.id },
    include: { contact: { select: { fullName: true, email: true } } },
  });
  if (!e) throw notFound("That enrollment");
  const who = `${e.contact.fullName}${e.contact.email ? ` <${e.contact.email}>` : ""}`;
  return { c, e, who };
}

const enrollmentIds = { campaignId: id("campaign"), enrollmentId: z.string().uuid().describe("The enrollment id (list_enrollments).") };

export const OUTREACH_ENROLLMENT_TOOLS = [
  defineTool({
    name: "list_enrollments",
    title: "List a campaign's enrollments",
    description: "The contacts in a campaign: status (active, paused, completed, stopped, failed), the step they are on, when the next one runs, replies, errors and stop reasons. Filter by status or replied.",
    input: z.object({
      campaignId: id("campaign"),
      status: z.enum(ENROLLMENT_STATUSES).optional(),
      replied: z.boolean().optional().describe("true: only contacts who replied; false: only those who did not."),
      search: z.string().trim().max(200).optional().describe("Matches the contact's name or email."),
      ...pageInput,
    }),
    permission: "campaigns.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const q = validate(EnrollmentListQuery, {
        page: args.page,
        pageSize: args.limit,
        status: args.status,
        replied: args.replied === undefined ? undefined : String(args.replied),
        q: args.search,
      });
      const r = await deps.get(CampaignsService).enrollments(ctx, args.campaignId, q);
      return paged(r.items.map(enrollmentOut), r.total, args.page, args.limit);
    },
  }),

  defineTool({
    name: "enroll_contacts",
    title: "Enroll contacts in a campaign",
    description:
      "Adds contacts to a launched (scheduled, running or paused) campaign — they start receiving its steps under the daily limit. Give contactIds and/or emails of existing contacts. Unsubscribed, bounced, suppressed, do-not-contact and already-enrolled people are skipped. Needs the person's confirmation; the preview says how many are eligible and why the rest are skipped. For a draft, set its audience instead.",
    input: z.object({
      campaignId: id("campaign"),
      contactIds: z.array(z.string().uuid()).max(10000).optional().describe("Contact ids."),
      emails: z.array(z.string().trim().max(320)).max(5000).optional().describe("Email addresses of existing contacts (resolved to contacts; unknown ones are reported)."),
    }),
    permission: "campaigns.launch",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const c = await deps.get(CampaignsService).get(ctx, args.campaignId);
      if (!ENROLLABLE.includes(c.status)) {
        throw conflict(
          c.status === "draft"
            ? `“${c.name}” has not been launched. Put these contacts in its audience (update_campaign_audience) and launch it, or launch it first.`
            : `“${c.name}” is ${c.status} and takes no new contacts. duplicate_campaign to run it again.`,
        );
      }
      const ids = new Set(args.contactIds ?? []);
      let unknown: string[] = [];
      if (args.emails?.length) {
        if (!holds(ctx, "contacts.read")) throw forbidden("Looking contacts up by email needs contacts.read.");
        const found = await deps.get(ContactsService).resolve(ctx, { emails: args.emails });
        for (const x of found.contacts) ids.add(x.id);
        unknown = [...found.unknownEmails, ...found.invalid];
      }
      if (!ids.size) throw badRequest(unknown.length ? `No contact has ${unknown.length === 1 ? "that address" : "those addresses"}: ${unknown.slice(0, 10).join(", ")}.` : "Give contactIds or emails.");
      if (ids.size > 10000) throw badRequest("At most 10,000 contacts at a time.");

      const workspaceId = ctx.workspace.id;
      const visible = await deps.prisma.db.contact.findMany({ where: { workspaceId, id: { in: [...ids] }, ...ownershipScope(ctx) }, select: { id: true } });
      const res = await deps.get(EnrollmentService).eligible(workspaceId, visible.map((v) => v.id), EnrollmentService.requiresEmail(c.steps));
      const skipped: Skipped = { ...res.skipped };
      if (ids.size > visible.length) skipped.not_found = (skipped.not_found ?? 0) + ids.size - visible.length;
      const already = res.eligible.length
        ? await deps.prisma.db.enrollment.count({ where: { workspaceId, campaignId: c.id, contactId: { in: res.eligible } } })
        : 0;
      if (already) skipped.already_enrolled = already;
      const n = res.eligible.length - already;
      const skippedLine = skippedText(skipped);
      if (n <= 0) throw conflict(`None of them can be enrolled in “${c.name}”: ${skippedLine || "no one eligible"}.`);
      const mailboxes = c.steps.some((s) => s.type === "email") ? await sendingMailboxes(ctx, deps, c.mailboxes) : "no email steps";
      return {
        summary: [
          `Enroll ${n} contact${n === 1 ? "" : "s"} in the outreach campaign “${c.name}” (${c.status}${c.status === "paused" ? " — they wait until it is resumed" : ""}).`,
          skippedLine ? `Skipped: ${skippedLine}.` : "",
          unknown.length ? `Not found: ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? ` and ${unknown.length - 10} more` : ""}.` : "",
          `They receive: ${describeSteps(c.steps)}.`,
          `Sends from: ${mailboxes}.`,
          `Limits: ${describeLimits(c)}; first starts from ${firstSendAt(c, c.steps).toISOString()}.`,
        ]
          .filter(Boolean)
          .join(" "),
        details: { campaignId: c.id, name: c.name, toEnroll: n, skipped, unknownEmails: unknown.slice(0, 50) },
        // Store the resolved ids, so confirming enrolls exactly the people previewed.
        args: { campaignId: c.id, contactIds: [...ids] },
      };
    },
    handler: async (ctx, args, deps) => {
      const ids = new Set(args.contactIds ?? []);
      if (args.emails?.length) for (const x of (await deps.get(ContactsService).resolve(ctx, { emails: args.emails })).contacts) ids.add(x.id);
      const { contactIds } = validate(EnrollInput, { contactIds: [...ids] });
      return deps.get(CampaignsService).enroll(ctx, args.campaignId, contactIds);
    },
  }),

  defineTool({
    name: "retry_enrollment",
    title: "Put a failed or stopped contact back",
    description: "Puts one failed or stopped enrollment back on the clock at the step it ended on (errors cleared; runs at the next send-window opening). Refused if the contact replied (with stop-on-reply) or can no longer be contacted. Needs the person's confirmation.",
    input: z.object(enrollmentIds),
    permission: "campaigns.launch",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const { c, e, who } = await oneEnrollment(ctx, deps, args.campaignId, args.enrollmentId);
      if (e.status !== "failed" && e.status !== "stopped") throw conflict(`This enrollment is ${e.status}; only a failed or stopped one can be retried.`);
      const why = e.lastError || e.stopReason;
      return {
        summary: `Put ${who} back into “${c.name}” at step ${e.position + 1} of ${c.steps.length}${why ? ` (it ended: ${why.slice(0, 200)})` : ""}. Their next step runs at the next opening of the send window and messages go out again.`,
        details: { campaignId: c.id, enrollmentId: e.id, contact: who, status: e.status, position: e.position },
      };
    },
    handler: async (ctx, args, deps) => deps.get(CampaignsService).retryEnrollment(ctx, args.campaignId, args.enrollmentId),
  }),

  defineTool({
    name: "retry_failed_enrollments",
    title: "Retry every failed contact",
    description: "Puts every failed enrollment of a campaign back at the step it failed on, spaced by the campaign's gap inside its send window. Contacts who replied (with stop-on-reply) or can no longer be contacted are left out. Fix the cause first (campaign_health). Needs the person's confirmation.",
    input: z.object({ campaignId: id("campaign") }),
    permission: "campaigns.launch",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const c = await deps.get(CampaignsService).get(ctx, args.campaignId);
      if (!ENROLLABLE.includes(c.status)) throw conflict(`“${c.name}” is ${c.status}, so its enrollments can no longer be put back.`);
      const failed = c.enrollments.failed;
      if (!failed) throw conflict(`“${c.name}” has no failed enrollments.`);
      const latest = await deps.prisma.db.enrollment.findFirst({
        where: { workspaceId: ctx.workspace.id, campaignId: c.id, status: "failed", lastError: { not: "" } },
        orderBy: { updatedAt: "desc" },
        select: { lastError: true },
      });
      return {
        summary: `Retry up to ${failed} failed contact${failed === 1 ? "" : "s"} in “${c.name}”: they go back to the step they failed on and messages go out again (${describeLimits(c)}). Those who replied or can no longer be contacted are left out.${latest?.lastError ? ` Latest error: ${latest.lastError.slice(0, 200)}` : ""}`,
        details: { campaignId: c.id, name: c.name, failed },
      };
    },
    handler: async (ctx, args, deps) => deps.get(CampaignsService).retryFailed(ctx, args.campaignId),
  }),

  defineTool({
    name: "pause_enrollment",
    title: "Pause one contact in a campaign",
    description: "Holds one active contact where they are (nothing more is sent to them) until resume_enrollment.",
    input: z.object(enrollmentIds),
    permission: "campaigns.launch",
    risk: "write",
    handler: async (ctx, args, deps) => enrollmentShort(await deps.get(CampaignsService).pauseEnrollment(ctx, args.campaignId, args.enrollmentId)),
  }),

  defineTool({
    name: "resume_enrollment",
    title: "Resume one paused contact",
    description: "Puts one paused contact back on the clock at the step they were held on (stop conditions such as a reply are re-checked before anything is sent).",
    input: z.object(enrollmentIds),
    permission: "campaigns.launch",
    risk: "write",
    handler: async (ctx, args, deps) => enrollmentShort(await deps.get(CampaignsService).resumeEnrollment(ctx, args.campaignId, args.enrollmentId)),
  }),

  defineTool({
    name: "stop_enrollment",
    title: "Stop one contact's sequence",
    description: "Ends one contact's sequence in a campaign for good (nothing more is sent to them by it). Needs the person's confirmation.",
    input: z.object(enrollmentIds),
    permission: "campaigns.launch",
    risk: "important",
    preview: async (ctx, args, deps) => {
      const { c, e, who } = await oneEnrollment(ctx, deps, args.campaignId, args.enrollmentId);
      if (e.status !== "active" && e.status !== "paused") throw conflict(`This enrollment is already ${e.status}.`);
      return {
        summary: `Stop ${who}'s sequence in “${c.name}” for good (now at step ${e.position + 1} of ${c.steps.length}); nothing more is sent to them by this campaign.`,
        details: { campaignId: c.id, enrollmentId: e.id, contact: who, status: e.status },
      };
    },
    handler: async (ctx, args, deps) => enrollmentShort(await deps.get(CampaignsService).stopEnrollment(ctx, args.campaignId, args.enrollmentId)),
  }),
];

function enrollmentShort(e: { id: string; status: string; contact: { fullName: string; email: string | null }; step: { position: number; type: string } | null; nextRunAt: Date | null; stopReason: string }) {
  return {
    id: e.id,
    status: e.status,
    contact: `${e.contact.fullName}${e.contact.email ? ` <${e.contact.email}>` : ""}`,
    step: e.step ? `${e.step.position + 1}: ${e.step.type}` : null,
    ...(e.nextRunAt ? { nextRunAt: e.nextRunAt } : {}),
    ...(e.stopReason ? { stopReason: e.stopReason } : {}),
  };
}
