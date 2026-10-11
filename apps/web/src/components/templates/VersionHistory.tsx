"use client";

import { useState } from "react";
import { Eye, History, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useMembers } from "@/components/pickers/Pickers";
import { useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { TemplateVersion } from "@/lib/types/templates";

/**
 * GET /templates/:id/versions — every wording the template has had, newest
 * first. Restoring copies a version into the editor; nothing changes until
 * the template is saved (which records it as a new version).
 */
export function VersionHistory({
  templateId,
  currentVersion,
  showSubject,
  onRestore,
}: {
  templateId: string;
  currentVersion: number;
  showSubject: boolean;
  /** Absent when the viewer cannot edit. */
  onRestore?: (v: TemplateVersion) => void;
}) {
  const ws = useWorkspace();
  const f = useFormat();
  const members = useMembers();
  const [open, setOpen] = useState<TemplateVersion | null>(null);
  const versions = useApiQuery<TemplateVersion[]>(ws.key("templates", templateId, "versions"), ws.path(`/templates/${templateId}/versions`));
  const author = (id: string | null) => {
    const m = id ? members.data?.members.find((x) => x.userId === id) : undefined;
    return m ? m.name || m.email : null;
  };

  return (
    <Card>
      <CardHeader icon={<History />} title="Version history" description="A new version is kept each time the subject or body changes." />
      <QueryState
        query={versions}
        loading={
          <div className="p-4">
            <SkeletonText lines={3} />
          </div>
        }
        isEmpty={(d) => d.length === 0}
        empty={<p className="p-4 text-xs text-text-3">No versions recorded.</p>}
      >
        {(rows) => (
          <ul className="max-h-80 divide-y divide-line overflow-y-auto">
            {rows.map((v) => {
              const by = author(v.createdById);
              return (
                <li key={v.id} className="flex items-center gap-2 px-4 py-2">

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm text-text">
                      <span className="font-medium tabular-nums">v{v.version}</span>
                      {v.version === currentVersion && <Badge tone="ok">Current</Badge>}
                    </div>
                    <div className="truncate text-xs text-text-3" title={f.dateTime(v.createdAt)}>
                      {f.smart(v.createdAt)}
                      {by ? ` · ${by}` : ""}
                      {showSubject && v.subject ? ` · ${v.subject}` : ""}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" icon={<Eye />} onClick={() => setOpen(v)}>
                    View
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
      <Modal
        open={open !== null}
        onOpenChange={(o) => !o && setOpen(null)}
        size="lg"
        title={open ? `Version ${open.version}` : "Version"}
        description={open ? `Saved ${f.dateTime(open.createdAt)}${author(open.createdById) ? ` by ${author(open.createdById)}` : ""}` : undefined}
        footer={
          <>
            <Button onClick={() => setOpen(null)}>Close</Button>
            {onRestore && open && open.version !== currentVersion && (
              <Button
                variant="primary"
                icon={<RotateCcw />}
                onClick={() => {
                  onRestore(open);
                  setOpen(null);
                }}
              >
                Restore into editor
              </Button>
            )}
          </>
        }
      >
        {open && (
          <div className="flex flex-col gap-3">
            {showSubject && (
              <div>
                <div className="text-xs font-medium text-text-2">Subject</div>
                <div className="mt-1 text-sm text-text">{open.subject || <span className="text-text-3">(no subject)</span>}</div>
              </div>
            )}
            <div>
              <div className="text-xs font-medium text-text-2">Body</div>
              <div className="mt-1 rounded-md border border-line bg-well p-3 text-sm leading-relaxed break-words whitespace-pre-wrap text-text">{open.body}</div>
            </div>
            {onRestore && open.version !== currentVersion && (
              <p className="text-xs text-text-3">Restoring puts this wording in the editor. Saving then records it as a new version; nothing earlier is lost.</p>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}
