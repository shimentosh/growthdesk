"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { PLATFORM_DRIP_TRIGGER_LABELS, PLATFORM_DRIP_TRIGGERS, type PlatformDripTrigger } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { platformKey, table, usePlatform } from "@/features/common/platform";
import { GrowthTile, growthEmpty } from "./common";
import type { SequenceDetail, SequenceRow } from "./types";

/*
 * /growth/sequences — onboarding and lifecycle drips: a trigger (signed up,
 * verified, trial started / ending / ended) and timed steps. Only people whose
 * trigger happens after the sequence is switched on are enrolled; history is
 * never backfilled.
 */

export const triggerLabel = (t: string) => PLATFORM_DRIP_TRIGGER_LABELS[t as PlatformDripTrigger]?.label ?? t;

function NewSequence({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<PlatformDripTrigger>("signup");
  const create = useApiMutation<SequenceDetail, void>({
    path: "/admin/growth/sequences",
    body: () => ({ name, trigger }),
    invalidate: [platformKey("growth", "sequences")],
    errorToast: false,
    onSuccess: (s) => router.push(`/growth/sequences/${s.id}`),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      icon={<GrowthTile of="sequences" size="md" />}
      title="New sequence"
      description="It starts switched off with one welcome step to edit."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
            Create sequence
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="e.g. Welcome series" autoFocus />
        </Field>
        <Field label="Starts when" hint={PLATFORM_DRIP_TRIGGER_LABELS[trigger].description}>
          <NativeSelect value={trigger} onChange={(e) => setTrigger(e.target.value as PlatformDripTrigger)} options={PLATFORM_DRIP_TRIGGERS.map((t) => ({ value: t, label: PLATFORM_DRIP_TRIGGER_LABELS[t].label }))} />
        </Field>
        <FormError error={create.error?.message ?? null} />
      </form>
    </Modal>
  );
}

/** /growth/sequences */
export function Sequences() {
  const f = useFormat();
  const { canChange } = usePlatform();
  const [creating, setCreating] = useState(false);
  const list = useApiQuery<SequenceRow[]>(platformKey("growth", "sequences"), "/admin/growth/sequences");
  return (
    <Page>
      <PageHeader
        icon={<GrowthTile of="sequences" />}
        title="Onboarding sequences"
        description="Timed product emails that start when something happens to a user. Each person is enrolled once, only with consent, and leaves the moment they unsubscribe."
        actions={
          canChange && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              New sequence
            </Button>
          )
        }
      />
      <QueryState
        query={list}
        loading={<SkeletonText lines={6} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              {...growthEmpty("sequences")}
              title="No sequences yet"
              description="A welcome series after sign-up, a nudge three days before a trial ends — set the trigger, write the steps, switch it on."
              action={
                canChange && (
                  <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                    New sequence
                  </Button>
                )
              }
            />
          </Card>
        }
      >
        {(rows) => (
          <Card className="overflow-hidden">
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Sequence</th>
                    <th className={table.th}>Status</th>
                    <th className={cn(table.th, "hidden md:table-cell")}>Steps</th>
                    <th className={cn(table.th, "hidden sm:table-cell text-right")}>In progress</th>
                    <th className={cn(table.th, "hidden lg:table-cell text-right")}>Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} className="hover:bg-hover">
                      <td className={table.td}>
                        <Link href={`/growth/sequences/${s.id}`} className="block">
                          <div className="font-medium text-text-hi hover:underline">{s.name}</div>
                          <div className="text-xs text-text-3">Starts: {triggerLabel(s.trigger)}</div>
                        </Link>
                      </td>
                      <td className={table.td}>
                        {s.active ? (
                          <Badge tone="live" dot title={s.activatedAt ? `Active since ${f.dateTime(s.activatedAt)}` : undefined}>
                            Active
                          </Badge>
                        ) : (
                          <Badge tone="mute">Off</Badge>
                        )}
                      </td>
                      <td className={cn(table.td, "hidden text-text-2 md:table-cell")}>{s.steps}</td>
                      <td className={cn(table.td, "hidden text-right tabular-nums sm:table-cell")}>{formatNumber(s.enrollments.active)}</td>
                      <td className={cn(table.td, "hidden text-right tabular-nums text-text-2 lg:table-cell")}>{formatNumber(s.enrollments.completed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </QueryState>
      {creating && <NewSequence open onOpenChange={(v) => !v && setCreating(false)} />}
    </Page>
  );
}
