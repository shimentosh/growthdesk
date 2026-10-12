"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Archive, Copy, Ellipsis, PencilLine, Plus } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { ENTITY, EntityTile } from "@/components/ui/icons";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Skeleton } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { useMarketing } from "@/components/marketing/common";
import { Choice } from "@/components/marketing/designs/controls";
import { DesignThumbnail } from "@/components/marketing/designs/DesignThumbnail";
import { NewDesignModal } from "@/components/marketing/designs/NewDesignModal";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { EmailDesign } from "@/lib/types/marketing";

export default function DesignsPage() {
  return (
    <Page>
      <RequirePermission permission="marketing.read">
        <Designs />
      </RequirePermission>
    </Page>
  );
}

const DesignGlyph = ENTITY.designs.icon;
const GRID = "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4";

type Show = "all" | "mine" | "library";

function Designs() {
  const ws = useWorkspace();
  const mk = useMarketing();
  const canWrite = ws.can("marketing.write");
  const list = useApiQuery<EmailDesign[]>(mk.key("designs", "list"), mk.path("/designs"));
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<EmailDesign | null>(null);
  const [show, setShow] = useState<Show>("all");

  const duplicate = useApiMutation<EmailDesign, EmailDesign>({
    path: (d) => mk.path(`/designs/${d.id}/duplicate`),
    body: () => undefined,
    invalidate: [mk.key("designs")],
    onSuccess: (copy) => {
      toast.success("Design duplicated", { description: copy.name, action: { label: "Open", href: mk.href(`/designs/${copy.id}`) } });
    },
  });
  const archive = useApiMutation<{ archived: boolean }, EmailDesign>({
    method: "DELETE",
    path: (d) => mk.path(`/designs/${d.id}`),
    invalidate: [mk.key("designs")],
    errorToast: false,
    success: "Design archived",
  });

  const create = canWrite ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      New design
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        icon={<EntityTile of="designs" />}
        title="Email designs"
        description="Reusable layouts for marketing emails. A campaign copies a design when you pick it, so changing a design never changes an email already sent."
        actions={list.data && list.data.length > 0 ? create : undefined}
      />
      <QueryState
        query={list}
        loading={
          <div className={GRID} aria-busy>
            {Array.from({ length: 4 }, (_, i) => (
              <Card key={i} className="overflow-hidden">
                <Skeleton className="aspect-[4/3] rounded-none" />
                <div className="flex flex-col gap-2 p-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </Card>
            ))}
          </div>
        }
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={<DesignGlyph />}
              tint={ENTITY.designs.tint}
              title="No email designs yet"
              description={
                canWrite
                  ? "Build a newsletter or announcement once from headings, text, buttons and images, then start any campaign from it."
                  : "Nobody has made an email design yet."
              }
              action={create}
            />
          </Card>
        }
      >
        {(designs) => {
          const library = designs.filter((d) => d.fromLibrary).length;
          const mixed = library > 0 && library < designs.length;
          const shown = designs.filter((d) => !mixed || show === "all" || (show === "library") === d.fromLibrary);
          return (
            <>
              {mixed && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <Choice<Show>
                    aria-label="Show designs"
                    value={show}
                    onChange={setShow}
                    options={[
                      { value: "all", label: `All (${designs.length})` },
                      { value: "mine", label: `Yours (${designs.length - library})` },
                      { value: "library", label: `Library (${library})` },
                    ]}
                  />
                  {canWrite && <p className="text-xs text-text-3">Duplicate a library design to make your own variant.</p>}
                </div>
              )}
              <ul className={GRID}>
                {shown.map((d) => (
              <DesignCard
                key={d.id}
                design={d}
                canWrite={canWrite}
                duplicating={duplicate.isPending && duplicate.variables?.id === d.id}
                onDuplicate={() => duplicate.mutate(d)}
                onArchive={() => setArchiving(d)}
              />
                ))}
              </ul>
            </>
          );
        }}
      </QueryState>

      {canWrite && <NewDesignModal open={creating} onOpenChange={setCreating} />}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`Archive “${archiving?.name ?? ""}”?`}
        confirmLabel="Archive"
        description="It leaves this list and can't be picked for new campaigns. Campaigns that already use it keep their own copy of the content."
        onConfirm={() => archiving && archive.mutateAsync(archiving)}
      />
    </>
  );
}

function DesignCard({
  design: d,
  canWrite,
  duplicating,
  onDuplicate,
  onArchive,
}: {
  design: EmailDesign;
  canWrite: boolean;
  duplicating: boolean;
  onDuplicate: () => void;
  onArchive: () => void;
}) {
  const mk = useMarketing();
  const f = useFormat();
  const router = useRouter();
  const href = mk.href(`/designs/${d.id}`);
  const blocks = d.blocks.length;
  return (
    <li className="min-w-0">
      <Card className="group relative overflow-hidden transition-shadow hover:shadow-lg focus-within:shadow-lg">
        <Link href={href} className="block outline-none" aria-label={`Open ${d.name}`}>
          <DesignThumbnail blocks={d.blocks} theme={d.theme} className="aspect-[4/3] border-b border-line" />
        </Link>
        <div className="flex items-start gap-2 py-2.5 pr-2 pl-3.5">
          <div className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <Link href={href} className="block truncate text-sm font-medium text-text hover:text-accent-hi">
                {d.name}
              </Link>
              {d.fromLibrary && (
                <Badge tone="info" title="From the built-in library">
                  Library
                </Badge>
              )}
            </span>
            <p className="truncate text-xs text-text-3" title={f.dateTime(d.updatedAt)}>
              Updated {f.relative(d.updatedAt)} · {blocks} block{blocks === 1 ? "" : "s"}
            </p>
          </div>
          {canWrite && (
            <Button size="sm" variant="ghost" icon={<Copy />} loading={duplicating} onClick={onDuplicate} aria-label={`Duplicate ${d.name}`} className="mt-0.5 shrink-0">
              Duplicate
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" label={`Actions for ${d.name}`} icon={<Ellipsis />} className="mt-0.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem icon={<PencilLine />} onSelect={() => router.push(href)}>
                {canWrite ? "Edit" : "View"}
              </DropdownMenuItem>
              {canWrite && (
                <>
                  <DropdownMenuItem icon={<Copy />} onSelect={onDuplicate} disabled={duplicating}>
                    Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger icon={<Archive />} onSelect={onArchive}>
                    Archive
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Card>
    </li>
  );
}
