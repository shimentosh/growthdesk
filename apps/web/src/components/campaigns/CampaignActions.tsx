"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CalendarClock, ChevronDown, Copy, ListOrdered, Mail, MoreHorizontal, Pause, Pencil, Play, Rocket, Square, Trash2, Type, Users } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CampaignDetail, CampaignReadiness, LaunchResult } from "@/lib/types/campaigns";
import { FixLink, SkippedList, isEditable, plural, skippedTotal } from "./common";

type Dialog = "launch" | "stop" | "delete" | null;

/**
 * Launch / pause / resume / stop, duplicate and delete, with a confirmation
 * for anything that starts or ends sending. The launch confirmation shows the
 * readiness check (GET /readiness): each blocking problem links to where it
 * is fixed, and the confirm button stays disabled until there are none. The
 * result lists who was enrolled and why the rest were skipped, in the API's
 * own words.
 */
export function CampaignActions({ campaign }: { campaign: CampaignDetail }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const canLaunch = ws.can("campaigns.launch");
  const canWrite = ws.can("campaigns.write");
  const s = campaign.status;
  const base = `/campaigns/${campaign.id}`;
  const invalidate = [ws.key("campaigns")];

  // Always re-checked when the dialog opens: a fix made on another tab must clear its problem.
  const readiness = useApiQuery<CampaignReadiness>(ws.key("campaigns", campaign.id, "readiness"), dialog === "launch" ? ws.path(`${base}/readiness`) : null, { staleTime: 0 });
  const launch = useApiMutation<LaunchResult, void>({
    path: ws.path(`${base}/launch`),
    invalidate,
    errorToast: false,
    onSuccess: (r) => {
      setDialog(null);
      setResult(r);
    },
    // A 422 means something changed since the check; show the fresh list of problems.
    onError: () => void readiness.refetch(),
  });
  const pause = useApiMutation<CampaignDetail, void>({ path: ws.path(`${base}/pause`), invalidate, success: "Campaign paused" });
  const resume = useApiMutation<CampaignDetail, void>({ path: ws.path(`${base}/resume`), invalidate, success: "Campaign resumed" });
  const stop = useApiMutation<CampaignDetail, void>({ path: ws.path(`${base}/stop`), invalidate, success: "Campaign stopped", errorToast: false });
  const duplicate = useApiMutation<CampaignDetail, void>({
    path: ws.path(`${base}/duplicate`),
    invalidate,
    success: "Campaign duplicated",
    onSuccess: (c) => router.push(ws.href(`/campaigns/${c.id}`)),
  });
  const remove = useApiMutation<{ deleted: boolean }, void>({
    method: "DELETE",
    path: ws.path(base),
    invalidate: [ws.key("campaigns", "list"), ws.key("campaigns", "picker")],
    success: "Campaign deleted",
    errorToast: false,
    onSuccess: () => router.push(ws.href("/campaigns")),
  });

  const future = campaign.startAt && new Date(campaign.startAt).getTime() > Date.now();
  const r = readiness.data;
  const closeLaunch = (o: boolean) => {
    if (launch.isPending) return;
    if (!o) launch.reset();
    setDialog(o ? "launch" : null);
  };
  // Launch only once the check has come back clean (the API refuses otherwise anyway).
  const launchBlocked = !r || readiness.isFetching || r.problems.length > 0;
  const canDelete = canWrite && s !== "running" && s !== "scheduled";
  const live = s === "running" || s === "scheduled";
  const openTab = (tab: string) => router.replace(`${pathname}?tab=${tab}`, { scroll: false });

  return (
    <>
      {canWrite && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button icon={<Pencil />}>
              Edit
              <ChevronDown aria-hidden className="-mr-1 size-3.5 text-text-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {live && canLaunch && (
              <>
                <DropdownMenuItem
                  icon={<Pause />}
                  onSelect={() =>
                    pause.mutate(undefined, {
                      onSuccess: () => openTab("steps"),
                    })
                  }
                >
                  Pause and edit steps
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {(isEditable(s) || live) && (
              <>
                {live && <DropdownMenuLabel>View (pause to change)</DropdownMenuLabel>}
                <DropdownMenuItem icon={<ListOrdered />} onSelect={() => openTab("steps")}>
                  Steps and messages
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Users />} onSelect={() => openTab("audience")}>
                  Audience
                </DropdownMenuItem>
                <DropdownMenuItem icon={<CalendarClock />} onSelect={() => openTab("schedule")}>
                  Schedule and settings
                </DropdownMenuItem>
                <DropdownMenuItem icon={<Mail />} onSelect={() => openTab("mailboxes")}>
                  Mailboxes
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem icon={<Type />} onSelect={() => openTab("schedule")}>
              Name and description
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {canLaunch && s === "draft" && (
        <Button variant="primary" icon={<Rocket />} onClick={() => setDialog("launch")}>
          Launch
        </Button>
      )}
      {canLaunch && (s === "running" || s === "scheduled") && (
        <Button icon={<Pause />} loading={pause.isPending} onClick={() => pause.mutate()}>
          Pause
        </Button>
      )}
      {canLaunch && s === "paused" && (
        <Button variant="primary" icon={<Play />} loading={resume.isPending} onClick={() => resume.mutate()}>
          Resume
        </Button>
      )}
      {(canWrite || (canLaunch && (s === "running" || s === "scheduled" || s === "paused"))) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton variant="secondary" label="More actions" icon={<MoreHorizontal />} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canWrite && (
              <DropdownMenuItem icon={<Copy />} onSelect={() => duplicate.mutate()}>
                Duplicate
              </DropdownMenuItem>
            )}
            {canLaunch && (s === "running" || s === "scheduled" || s === "paused") && (
              <DropdownMenuItem icon={<Square />} onSelect={() => setDialog("stop")}>
                Stop campaign
              </DropdownMenuItem>
            )}
            {canDelete && (
              <DropdownMenuItem icon={<Trash2 />} danger onSelect={() => setDialog("delete")}>
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Modal
        open={dialog === "launch"}
        onOpenChange={closeLaunch}
        title={`Launch “${campaign.name}”?`}
        description={
          future
            ? `Contacts are enrolled now and the first steps run from ${f.dateTime(campaign.startAt)}, inside the send window.`
            : "Contacts are enrolled now and the first steps run inside the send window, at most the daily new-contact limit per day."
        }
        footer={
          <>
            {r && r.problems.length > 0 && !readiness.isFetching && (
              <span className="mr-auto self-center text-xs text-text-3">Fix {r.problems.length === 1 ? "the problem" : "the problems"} above to launch.</span>
            )}
            <Button disabled={launch.isPending} onClick={() => closeLaunch(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={<Rocket />} loading={launch.isPending} disabled={launchBlocked} onClick={() => launch.mutate()}>
              {future ? "Schedule" : "Launch"}
            </Button>
          </>
        }
      >
        {readiness.isPending ? (
          <p className="text-sm text-text-3">Checking the campaign…</p>
        ) : readiness.isError ? (
          <p className="text-sm text-bad-ink">{readiness.error.message}</p>
        ) : r ? (
          <div className="flex flex-col gap-3">
            {launch.error && (
              <p role="alert" className="text-sm text-bad-ink">
                {launch.error.message}
              </p>
            )}
            {r.problems.length > 0 && (
              <Callout tone="bad" title="Not ready to launch">
                <ul className="flex flex-col gap-1.5">
                  {r.problems.map((p, i) => (
                    <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <span>{p.message}</span>
                      {p.fix && <FixLink fix={p.fix} onNavigate={() => closeLaunch(false)} />}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
            {r.warnings.length > 0 && (
              <Callout tone="warn">
                <ul className="list-disc pl-4">
                  {r.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <div className="rounded-md border border-line p-3 text-sm">
              <p className="text-text">
                {r.audience.description}: {plural(r.audience.candidates, "contact")}, of whom{" "}
                <strong className="font-medium">{formatCount(r.audience.eligible)}</strong> can be enrolled.
              </p>
              {r.audience.skipped.length > 0 && (
                <>
                  <p className="mt-2 text-xs text-text-3">Skipped ({formatCount(skippedTotal(r.audience.skipped))})</p>
                  <SkippedList items={r.audience.skipped} className="mt-1 flex flex-col gap-0.5 text-sm" />
                </>
              )}
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={dialog === "stop"}
        onOpenChange={(o) => setDialog(o ? "stop" : null)}
        title={`Stop “${campaign.name}”?`}
        confirmLabel="Stop campaign"
        description="Every active and paused enrollment is stopped and nothing more is sent. A stopped campaign cannot be resumed; duplicate it to run it again."
        onConfirm={() => stop.mutateAsync()}
      />

      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => setDialog(o ? "delete" : null)}
        title={`Delete “${campaign.name}”?`}
        description="The campaign disappears from the list. Messages it already sent stay in the inbox and on contact timelines."
        onConfirm={() => remove.mutateAsync()}
      />

      <Modal
        open={result !== null}
        onOpenChange={(o) => !o && setResult(null)}
        title={result?.campaign.status === "scheduled" ? "Campaign scheduled" : "Campaign launched"}
        footer={
          <Button variant="primary" onClick={() => setResult(null)}>
            Done
          </Button>
        }
      >
        {result && (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-text">
              <strong className="font-medium">{plural(result.enrolled, "contact")}</strong> enrolled
              {result.campaign.status === "scheduled" && result.campaign.startAt ? `; the first steps run from ${f.dateTime(result.campaign.startAt)}.` : "."}
            </p>
            {result.skipped.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-text-3">Not enrolled ({formatCount(skippedTotal(result.skipped))})</p>
                <SkippedList items={result.skipped} />
              </div>
            )}
            {result.warnings.length > 0 && (
              <Callout tone="warn">
                <ul className="list-disc pl-4">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Callout>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

const formatCount = (n: number) => n.toLocaleString();
