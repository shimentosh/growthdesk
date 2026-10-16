"use client";

import { useState } from "react";
import { Pencil, Send } from "lucide-react";
import { DISCORD_TEMPLATE_PRESETS, discordEventLabel, type DiscordTemplatePreset } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import { toast } from "@/components/ui/Toast";
import { messageOf, patch, post, put } from "@/lib/api";
import { useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { DiscordDestination, DiscordRule, DiscordTemplate, DiscordTemplates, DiscordTestResult } from "@/lib/types/discord";

/*
 * The notification map: one row per common notification (the ready-made
 * templates), each with the channel it posts to. Choosing a channel is all it
 * takes — it creates (or updates) a rule named after the notification, using
 * that notification's template, adding the template first when the workspace
 * does not have it yet. "Don't post" switches the rule off and keeps it.
 *
 * A row's rule is the one named exactly like the notification; renaming it
 * turns it into a custom rule, listed below the map.
 */

/** The notifications on the map, in the order a lead travels (the one-liner is a style, not a notification). */
const ORDER = [
  "new_lead",
  "lead_qualified",
  "reply",
  "meeting_booked",
  "call_completed",
  "deal_created",
  "deal_stage",
  "quote_accepted",
  "deal_won",
  "deal_lost",
  "deal_stale",
  "task_overdue",
  "campaign_completed",
];
export const MAP_PRESETS = ORDER.map((key) => DISCORD_TEMPLATE_PRESETS.find((p) => p.key === key)).filter((p): p is DiscordTemplatePreset => Boolean(p));
export const MAP_NAMES = new Set(MAP_PRESETS.map((p) => p.name));

const OFF = "";

function MapRow({
  preset,
  rule,
  destinations,
  templates,
  onEdit,
}: {
  preset: DiscordTemplatePreset;
  rule: DiscordRule | undefined;
  destinations: DiscordDestination[];
  templates: DiscordTemplates | undefined;
  onEdit: (rule: DiscordRule) => void;
}) {
  const ws = useWorkspace();
  const invalidate = useInvalidate();
  const canManage = ws.can("integrations.manage");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const on = Boolean(rule?.enabled);
  const value = on ? (rule!.destinationIds[0] ?? OFF) : OFF;
  const extra = on ? rule!.destinationIds.length - 1 : 0;
  const nameOf = (id: string) => destinations.find((d) => d.id === id)?.name ?? "removed channel";

  const templateId = async (): Promise<string> => {
    const found = templates?.items.find((t) => t.name === preset.name);
    if (found) return found.id;
    const created = await post<DiscordTemplate>(ws.path("/discord/templates"), { name: preset.name, description: preset.description, ...preset.body });
    return created.id;
  };

  const choose = async (destinationId: string) => {
    setBusy("save");
    try {
      if (!destinationId) {
        if (rule?.enabled) await patch(ws.path(`/discord/rules/${rule.id}`), { enabled: false });
        toast.success(`${preset.name}: not posted any more`);
      } else if (rule) {
        await put(ws.path(`/discord/rules/${rule.id}`), {
          name: rule.name,
          events: rule.events,
          destinationIds: [destinationId],
          templateId: rule.templateId,
          conditions: rule.conditions,
          enabled: true,
        });
        toast.success(`${preset.name} → #${nameOf(destinationId)}`);
      } else {
        await post(ws.path("/discord/rules"), { name: preset.name, events: preset.events, destinationIds: [destinationId], templateId: await templateId(), conditions: [], enabled: true });
        toast.success(`${preset.name} → #${nameOf(destinationId)}`, { description: "Send a test to see how it looks." });
      }
    } catch (e) {
      toast.error(messageOf(e));
    } finally {
      await invalidate(ws.key("discord"));
      setBusy(null);
    }
  };

  const test = async () => {
    if (!rule) return;
    setBusy("test");
    try {
      const r = await post<DiscordTestResult>(ws.path(`/discord/rules/${rule.id}/test`), {
        eventType: preset.events[0],
        templateId: rule.templateId,
        conditions: [],
        destinationIds: rule.destinationIds,
      });
      const failed = r.deliveries.filter((d) => d.status === "failed");
      if (failed.length) toast.error(`Not posted: ${failed[0]!.error || "Discord refused it"}`);
      else
        toast.success(`Test sent to ${rule.destinationIds.map((id) => `#${nameOf(id)}`).join(", ")}`, { description: r.source === "event" ? "Using your latest real event." : "Using sample data." });
      await invalidate(ws.key("discord", "deliveries"));
    } catch (e) {
      toast.error(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: preset.body.embed.color || "var(--text-3)" }} />
      <div className="min-w-48 flex-1">
        <div className="text-sm font-medium text-text-hi">{preset.name}</div>
        <div className="text-xs text-text-3">When: {preset.events.map(discordEventLabel).join(" or ")}</div>
      </div>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <span aria-hidden className="hidden text-text-3 sm:inline">
          →
        </span>
        <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
          <Select
            aria-label={`Channel for ${preset.name}`}
            value={value}
            disabled={!canManage || busy !== null || destinations.length === 0}
            onValueChange={(v) => void choose(v)}
            options={[{ value: OFF, label: "Don't post" }, ...destinations.map((d) => ({ value: d.id, label: `#${d.name}`, description: d.guildName, text: d.name, group: d.group || undefined }))]}
          />
        </div>
        {extra > 0 && <span className="shrink-0 text-xs text-text-3">+{extra} more</span>}
        {canManage && (
          <Button size="sm" variant="ghost" icon={<Send />} loading={busy === "test"} disabled={!on || busy !== null} onClick={() => void test()} title="Post a test message now">
            Test
          </Button>
        )}
        {/* The space stays when there is nothing to edit yet, so every row's channel lines up. */}
        {canManage && (rule ? <IconButton label={`More options for ${preset.name}`} icon={<Pencil />} onClick={() => onEdit(rule)} /> : <span aria-hidden className="size-8 shrink-0" />)}
      </div>
    </li>
  );
}

/** What to post where: the common notifications, one channel each. */
export function DiscordQuickMap({
  rules,
  destinations,
  templates,
  onEdit,
}: {
  rules: DiscordRule[];
  destinations: DiscordDestination[];
  templates: DiscordTemplates | undefined;
  onEdit: (rule: DiscordRule) => void;
}) {
  const active = MAP_PRESETS.filter((p) => rules.some((r) => r.name === p.name && r.enabled)).length;
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-text-hi">What to post where</h2>
        <p className="text-xs text-text-3">
          Pick a channel for each notification — that&apos;s all. {active > 0 ? `${active} of ${MAP_PRESETS.length} on.` : "Start with New lead and Deal won."} Each uses its ready-made template;
          change the wording on the Templates tab.
        </p>
      </div>
      <Card>
        <ul className="divide-y divide-line">
          {MAP_PRESETS.map((p) => (
            <MapRow key={p.key} preset={p} rule={rules.find((r) => r.name === p.name)} destinations={destinations} templates={templates} onEdit={onEdit} />
          ))}
        </ul>
      </Card>
    </section>
  );
}
