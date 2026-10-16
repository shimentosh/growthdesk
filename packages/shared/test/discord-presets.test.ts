import { describe, expect, it } from "vitest";
import { DISCORD_TEMPLATE_PRESETS, DiscordTemplateInput, WEBHOOK_EVENTS, WORKFLOW_TRIGGERS, discordTokens, renderDiscordMessage, validateDiscordTemplate } from "../src/index.js";

const KNOWN_EVENTS = new Set<string>([...WEBHOOK_EVENTS, ...WORKFLOW_TRIGGERS]);

// A context shaped like discord-context.service.ts builds, every part filled.
const ctx = {
  event: { type: "deal.won", label: "Deal won", link: "https://app.test/w/1/deals/2", occurredAt: "2026-10-16T10:00:00.000Z", actor: { name: "Priya" } },
  workspace: { name: "Acme" },
  payload: { days: 21, stage: "Proposal", quoteNumber: "Q-0042", total: 1200, currency: "USD" },
  contact: { fullName: "Ada Lovelace", email: "ada@example.test", phone: "+1 555", jobTitle: "CTO", leadSource: "Clientdesk", country: "UK", score: 80, owner: { name: "Sam" }, company: { name: "Analytical" } },
  deal: { title: "Pilot", valueFormatted: "$1,200.00", stage: "Won", pipeline: "Sales", expectedCloseDate: "2026-11-01", owner: { name: "Sam" }, company: { name: "Analytical" } },
  conversation: { from: "Ada", subject: "Re: pilot", summary: "Wants a call", sentiment: "positive", assignee: { name: "Sam" } },
  meeting: { title: "Intro", when: "17 Oct 2026, 15:00 (UTC)", attendeeName: "Ada", attendeeEmail: "ada@example.test", location: "Zoom", conferenceUrl: "https://zoom.test/1" },
  call: { outcome: "connected", summary: "Good call", by: { name: "Sam" }, direction: "outbound", durationSec: 300 },
  task: { title: "Send proposal", due: "15 Oct 2026, 09:00 (UTC)", priority: "high", assignee: { name: "Sam" } },
  campaign: { name: "Q4 outreach", enrolledCount: 100, sentCount: 300, replyCount: 12, positiveReplyCount: 5, bounceCount: 2 },
};

describe("Discord template presets", () => {
  it("have unique keys and names", () => {
    expect(new Set(DISCORD_TEMPLATE_PRESETS.map((p) => p.key)).size).toBe(DISCORD_TEMPLATE_PRESETS.length);
    expect(new Set(DISCORD_TEMPLATE_PRESETS.map((p) => p.name)).size).toBe(DISCORD_TEMPLATE_PRESETS.length);
  });

  for (const p of DISCORD_TEMPLATE_PRESETS) {
    describe(p.name, () => {
      it("is a valid template body for the API", () => {
        expect(DiscordTemplateInput.safeParse({ name: p.name, description: p.description, ...p.body }).success).toBe(true);
        expect(validateDiscordTemplate(p.body).errors).toEqual({});
      });

      it("listens to events the system emits", () => {
        expect(p.events.length).toBeGreaterThan(0);
        for (const e of p.events) expect(KNOWN_EVENTS.has(e)).toBe(true);
      });

      it("uses only plain variables (no nesting)", () => {
        const texts = [p.body.content, p.body.embed.title, p.body.embed.description, ...p.body.embed.fields.map((f) => f.value)];
        for (const t of texts) expect((t.match(/\{\{/g) ?? []).length).toBe(discordTokens(t).length);
      });

      it("renders a message with nothing missing when the data is there", () => {
        const r = renderDiscordMessage(p.body, ctx);
        expect(r.skip).toBeNull();
        expect(r.missing).toEqual([]);
      });

      it("still renders when only the event is known", () => {
        const r = renderDiscordMessage(p.body, { event: ctx.event, workspace: ctx.workspace, payload: {} });
        expect(r.skip).toBeNull();
      });
    });
  }
});
