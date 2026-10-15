"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Building2, Check, Download } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import type { Paged } from "@/lib/types";
import type { AdminWorkspaceRow } from "@/features/common/types";
import { PlatformTile, platformKey } from "@/features/common/platform";
import type { LibraryDesign, WorkspaceDesignSources } from "./types";

/*
 * Copies one workspace's email design into the library as a draft: find the
 * workspace, pick the design, optionally give it a category. The workspace's
 * own design is not changed. Like the support view, a customer's designs are
 * readable only under an active support access grant (the API answers 403
 * with how to get one, shown in place of the list).
 */

const row = "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-hover focus-visible:bg-hover focus-visible:outline-none";

export function ImportDesignModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const f = useFormat();
  const [q, setQ] = useState("");
  const [workspace, setWorkspace] = useState<{ id: string; name: string } | null>(null);
  const [designId, setDesignId] = useState<string | null>(null);
  const [category, setCategory] = useState("");

  const workspaces = useApiQuery<Paged<AdminWorkspaceRow>>(platformKey("email-designs", "import", "workspaces"), open && !workspace ? "/admin/workspaces" : null, {
    query: { q, page: 1, pageSize: 8 },
    keepPrevious: true,
  });
  const sources = useApiQuery<WorkspaceDesignSources>(platformKey("email-designs", "import", "sources", workspace?.id), workspace ? `/admin/email-designs/sources/${workspace.id}` : null);
  const importDesign = useApiMutation<LibraryDesign, void>({
    path: "/admin/email-designs/import",
    body: () => ({ workspaceId: workspace?.id, designId, ...(category.trim() ? { category: category.trim() } : {}) }),
    invalidate: [platformKey("email-designs")],
    success: "Imported as a draft",
    errorToast: false,
    onSuccess: (d) => router.push(`/library/email-templates/${d.id}`),
  });

  const change = (o: boolean) => {
    if (importDesign.isPending) return;
    if (!o) {
      setQ("");
      setWorkspace(null);
      setDesignId(null);
      setCategory("");
      importDesign.reset();
    }
    onOpenChange(o);
  };

  return (
    <Modal
      open={open}
      onOpenChange={change}
      icon={<PlatformTile of="library" size="md" />}
      title="Import from a workspace design"
      description="Copies the design's theme and blocks into the library as a draft; the workspace's design is not changed. A customer's workspace must have granted support access (your own workspaces need no grant)."
      footer={
        <>
          <Button onClick={() => change(false)} disabled={importDesign.isPending}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Download />} loading={importDesign.isPending} disabled={!workspace || !designId} onClick={() => importDesign.mutate()}>
            Import as draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormError error={importDesign.error?.message} />
        {!workspace ? (
          <>
            <SearchInput autoFocus value={q} onChange={setQ} placeholder="Find a workspace by name or id…" aria-label="Find a workspace" />
            <QueryState query={workspaces} loading={<SkeletonText lines={4} />}>
              {(page) =>
                page.items.length === 0 ? (
                  <p className="px-1 text-sm text-text-3">No workspace matches.</p>
                ) : (
                  <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
                    {page.items.map((w) => (
                      <li key={w.id}>
                        <button type="button" className={row} onClick={() => setWorkspace({ id: w.id, name: w.name })}>
                          <Building2 aria-hidden className="size-4 shrink-0 text-text-3" />
                          <span className="min-w-0 flex-1 truncate font-medium text-text">{w.name}</span>
                          <span className="truncate text-xs text-text-3">{w.billingAccount.owner.email}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              }
            </QueryState>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-well px-3 py-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Building2 aria-hidden className="size-4 shrink-0 text-text-3" />
                <span className="truncate font-medium text-text">{workspace.name}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setWorkspace(null);
                  setDesignId(null);
                }}
              >
                Change
              </Button>
            </div>
            <QueryState query={sources} loading={<SkeletonText lines={4} />}>
              {(s) =>
                s.designs.length === 0 ? (
                  <p className="px-1 text-sm text-text-3">This workspace has no email designs.</p>
                ) : (
                  <ul role="listbox" aria-label="Designs" className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
                    {s.designs.map((d) => (
                      <li key={d.id} role="option" aria-selected={designId === d.id}>
                        <button type="button" className={cn(row, designId === d.id && "bg-accent/8")} onClick={() => setDesignId(d.id)}>
                          <span className="flex size-4 shrink-0 items-center justify-center text-accent-ink">{designId === d.id && <Check aria-hidden className="size-4" />}</span>
                          <span className="min-w-0 flex-1 truncate text-text">{d.name}</span>
                          {d.fromLibrary && (
                            <Badge tone="info" quiet>
                              From library
                            </Badge>
                          )}
                          <span className="shrink-0 text-xs text-text-3" title={f.dateTime(d.updatedAt)}>
                            {f.relative(d.updatedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              }
            </QueryState>
            <Field label="Category" hint="Optional; you can change it and the name in the editor.">
              <Input value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} placeholder="Newsletter" />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
