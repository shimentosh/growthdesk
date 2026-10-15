"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { LayoutTemplate } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { EntityTile } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { useMarketing } from "@/components/marketing/common";
import { DesignThumbnail } from "@/components/marketing/designs/DesignThumbnail";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import type { EmailDesign, LibraryTemplate } from "@/lib/types/marketing";

const OTHER = "Other";

/**
 * "Start from template": the published email templates platform staff
 * curate, grouped by category and previewed live. Using one copies it into
 * this workspace's designs and opens it in the editor.
 */
export function TemplateGalleryModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const mk = useMarketing();
  const router = useRouter();
  const [category, setCategory] = useState<string | null>(null);
  const list = useApiQuery<LibraryTemplate[]>(mk.key("design-library"), open ? mk.path("/design-library") : null, { staleTime: 60_000 });
  const use = useApiMutation<EmailDesign, LibraryTemplate>({
    path: (t) => mk.path(`/design-library/${t.id}/use`),
    body: () => undefined,
    invalidate: [mk.key("designs")],
    onSuccess: (d) => {
      toast.success("Design created from the template", { description: "Make it yours — it is your own copy." });
      onOpenChange(false);
      router.push(mk.href(`/designs/${d.id}`));
    },
  });

  const groups = useMemo(() => {
    const items = list.data ?? [];
    const names = [...new Set(items.map((t) => t.category || OTHER))];
    return names.map((name) => ({ name, items: items.filter((t) => (t.category || OTHER) === name) }));
  }, [list.data]);
  const shown = category ? groups.filter((g) => g.name === category) : groups;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (use.isPending) return;
        if (!o) setCategory(null);
        onOpenChange(o);
      }}
      size="xl"
      icon={<EntityTile of="designs" size="md" />}
      title="Start from a template"
      description="Ready-made layouts. Using one adds a copy to your designs, so you can change anything without affecting the template."
    >
      <QueryState
        query={list}
        loading={
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="aspect-[4/3]" />
            ))}
          </div>
        }
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState compact icon={<LayoutTemplate />} title="No templates yet" description="There are no email templates to start from at the moment." />}
      >
        {() => (
          <div className="flex flex-col gap-5">
            {groups.length > 1 && (
              <div role="group" aria-label="Category" className="flex flex-wrap gap-1.5">
                {[null, ...groups.map((g) => g.name)].map((name) => (
                  <button
                    key={name ?? "all"}
                    type="button"
                    aria-pressed={category === name}
                    onClick={() => setCategory(name)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                      category === name ? "border-accent bg-accent/10 text-accent-hi" : "border-line text-text-2 hover:bg-hover hover:text-text",
                    )}
                  >
                    {name ?? "All"}
                  </button>
                ))}
              </div>
            )}
            {shown.map((g) => (
              <section key={g.name} aria-label={g.name}>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-text-3 uppercase">{g.name}</h3>
                <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {g.items.map((t) => (
                    <li key={t.id} className="min-w-0">
                      <Card className="flex h-full flex-col overflow-hidden">
                        <DesignThumbnail blocks={t.blocks} theme={t.theme} className="aspect-[4/3] border-b border-line" />
                        <div className="flex flex-1 flex-col gap-2 p-3">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-text">{t.name}</div>
                            {t.description && <p className="mt-0.5 line-clamp-2 text-xs text-text-3">{t.description}</p>}
                          </div>
                          <Button size="sm" variant="primary" loading={use.isPending && use.variables?.id === t.id} disabled={use.isPending} onClick={() => use.mutate(t)}>
                            Use template
                          </Button>
                        </div>
                      </Card>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </QueryState>
    </Modal>
  );
}
