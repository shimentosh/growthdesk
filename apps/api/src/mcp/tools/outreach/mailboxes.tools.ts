import { z } from "zod";
import { ChannelsService } from "../../../channels/channels.service.js";
import { MailboxesService } from "../../../mailboxes/mailboxes.service.js";
import { replyTrackingProblem } from "../../../mailboxes/mailbox-upkeep.js";
import { defineTool } from "../../tool.js";

/*
 * Sending mailboxes and chat channels, read only. Connecting one takes a
 * password or an OAuth sign-in, which never goes through a chat: the model
 * sends the person to Settings → Mailboxes / Channels instead.
 */

const CONNECT_HINT =
  "Connecting, reconnecting or changing a mailbox needs its password or a Google/Microsoft sign-in, which never goes through this chat: send the person to Settings → Mailboxes in Growthdesk.";

export const OUTREACH_MAILBOX_TOOLS = [
  defineTool({
    name: "list_mailboxes",
    title: "List sending mailboxes",
    description: `The workspace's sending mailboxes for outreach: id (for a campaign's mailboxIds), address, status (connected / error / …), daily limit, sent today and room left, pacing, reply tracking (IMAP — needed for stop-on-reply) and, unless checkDns is false, the domain's SPF / DKIM / DMARC / MX health. Check this before building a campaign. ${CONNECT_HINT}`,
    input: z.object({
      checkDns: z.boolean().default(true).describe("Look up each sending domain's SPF/DKIM/DMARC/MX (a few seconds). false for a quick list."),
    }),
    permission: "integrations.read",
    risk: "read",
    handler: async (ctx, args, deps) => {
      const svc = deps.get(MailboxesService);
      const boxes = await svc.list(ctx);
      const now = new Date();
      // One lookup per domain, not per mailbox.
      const dns = new Map<string, Promise<unknown>>();
      if (args.checkDns) {
        for (const b of boxes) {
          const domain = b.email.split("@")[1] ?? "";
          if (!dns.has(domain)) {
            dns.set(
              domain,
              svc.dns(ctx, b.id).then(
                (d) => ({ state: d.state, summary: d.detail, inOrder: `${d.done}/${d.total}`, records: d.records.map((r) => ({ record: r.id, state: r.state, detail: r.detail })) }),
                () => ({ state: "unknown", summary: "The DNS lookup failed." }),
              ),
            );
          }
        }
      }
      const items = await Promise.all(
        boxes.map(async (b) => ({
          id: b.id,
          email: b.email,
          name: b.displayName,
          provider: b.provider,
          status: b.status,
          ...(b.lastError ? { lastError: b.lastError } : {}),
          dailyLimit: b.dailyLimit,
          sentToday: b.sentToday,
          roomToday: Math.max(0, b.dailyLimit - b.sentToday),
          minDelaySeconds: b.minDelaySeconds,
          replyTracking: {
            on: Boolean(b.imapEnabled && b.imapHost),
            lastSyncedAt: b.lastSyncedAt,
            problem: replyTrackingProblem(b, now),
          },
          ...(args.checkDns ? { dns: await dns.get(b.email.split("@")[1] ?? "") } : {}),
        })),
      );
      return {
        items,
        ...(items.length ? {} : { note: `No mailbox is connected yet. ${CONNECT_HINT}` }),
      };
    },
  }),

  defineTool({
    name: "channel_status",
    title: "WhatsApp / Telegram status",
    description:
      "Whether WhatsApp and Telegram are connected (for whatsapp / telegram sequence steps — without a connection those steps are skipped). Connecting a channel needs provider credentials: send the person to Settings → Channels.",
    input: z.object({}),
    permission: "integrations.read",
    risk: "read",
    handler: async (ctx, _args, deps) => {
      const rows = (await deps.get(ChannelsService).list(ctx)) as {
        id: string;
        channel: string;
        provider: string;
        name: string;
        status: string;
        lastError: string;
        lastEventAt: Date | null;
        details: Record<string, unknown>;
      }[];
      const chat = rows.filter((r) => r.channel === "whatsapp" || r.channel === "telegram");
      const connected = (channel: string) => chat.some((r) => r.channel === channel && r.status === "connected");
      return {
        whatsapp: connected("whatsapp"),
        telegram: connected("telegram"),
        integrations: chat.map((r) => ({
          id: r.id,
          channel: r.channel,
          provider: r.provider,
          name: r.name,
          status: r.status,
          ...(r.lastError ? { lastError: r.lastError } : {}),
          lastEventAt: r.lastEventAt,
          account: r.details.displayPhoneNumber ?? r.details.botUsername ?? r.details.verifiedName ?? null,
        })),
      };
    },
  }),
];
