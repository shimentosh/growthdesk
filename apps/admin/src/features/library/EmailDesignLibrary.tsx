"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Download, Plus } from "lucide-react";
import { starterBlocks } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { FilterBar, PlatformTile, platformEmpty, platformKey, usePlatform } from "@/features/common/platform";
import { LibraryPreview, LibraryStatusBadge } from "./common";
import { ImportDesignModal } from "./ImportDesignModal";
import type { LibraryDesign } from "./types";

/*
 * /library/email-templates — the email design templates every workspace can
 * start a design from. Published entries show in the workspaces' gallery;
 * drafts only here. The built-ins are entries like any other once shipped.
 */

const GRID = "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4";
const shortId = () => Math.random().toString(36).slice(2, 10);

type Show = "all" | "published" | "draft";

export function EmailDesignLibrary() {
  const { canChange } = usePlatform();
  const list = useApiQuery<LibraryDesign[]>(platformKey("email-designs"), "/admin/email-designs");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [show, setShow] = useState<Show>("all");
  const [category, setCategory] = useState("");

  const actions = canChange ? (
    <>
      <Button icon={<Download />} onClick={() => setImporting(true)}>
        Import from a workspace
      </Button>
      <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
        New template
      </Button>
    </>
  ) : undefined;

  return (
    <Page>
      <PageHeader
        icon={<PlatformTile of="library" />}
        title="Email templates"
        description="Marketing email designs every workspace can start from. Published templates appear in each workspace's “Start from template” gallery; new workspaces also get a copy of the published built-ins."
        actions={actions}
      />
      <QueryState
        query={list}
        loading={
          <div className={GRID} aria-busy>
            {Array.from({ length: 8 }, (_, i) => (
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
              {...platformEmpty("library")}
              title="No email templates yet"
              description="The built-in designs are added when the API starts. Create a template, or import a design from a workspace."
              action={actions}
            />
          </Card>
        }
      >
        {(items) => <Grid items={items} show={show} setShow={setShow} category={category} setCategory={setCategory} />}
      </QueryState>
      {canChange && <NewTemplateModal open={creating} onOpenChange={setCreating} />}
      {canChange && <ImportDesignModal open={importing} onOpenChange={setImporting} />}
    </Page>
  );
}

function Grid({ items, show, setShow, category, setCategory }: { items: LibraryDesign[]; show: Show; setShow: (v: Show) => void; category: string; setCategory: (v: string) => void }) {
  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean))].sort(), [items]);
  const published = items.filter((i) => i.status === "published").length;
  const shown = items.filter((i) => (show === "all" || i.status === show) && (!category || i.category === category));
  return (
    <>
      <FilterBar>
        <NativeSelect
          aria-label="Status"
          size="sm"
          className="w-44"
          value={show}
          onChange={(e) => setShow(e.target.value as Show)}
          options={[
            { value: "all", label: `All (${items.length})` },
            { value: "published", label: `Published (${published})` },
            { value: "draft", label: `Drafts (${items.length - published})` },
          ]}
        />
        {categories.length > 0 && (
          <NativeSelect
            aria-label="Category"
            size="sm"
            className="w-44"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={[{ value: "", label: "Every category" }, ...categories.map((c) => ({ value: c, label: c }))]}
          />
        )}
      </FilterBar>
      {shown.length === 0 ? (
        <Card>
          <EmptyState compact title="Nothing matches these filters" />
        </Card>
      ) : (
        <ul className={GRID}>
          {shown.map((d) => (
            <TemplateCard key={d.id} design={d} />
          ))}
        </ul>
      )}
    </>
  );
}

function TemplateCard({ design: d }: { design: LibraryDesign }) {
  const f = useFormat();
  const href = `/library/email-templates/${d.id}`;
  return (
    <li className="min-w-0">
      <Card className="group relative overflow-hidden transition-shadow hover:shadow-lg focus-within:shadow-lg">
        <Link href={href} className="block outline-none" aria-label={`Open ${d.name}`}>
          <LibraryPreview blocks={d.blocks} theme={d.theme} className="aspect-[4/3] border-b border-line" />
        </Link>
        <div className="flex flex-col gap-1 px-3.5 py-2.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <Link href={href} className="block min-w-0 flex-1 truncate text-sm font-medium text-text-hi hover:underline">
              {d.name}
            </Link>
            <LibraryStatusBadge status={d.status} />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-text-3">
            {d.category && (
              <Badge tone="mute" quiet>
                {d.category}
              </Badge>
            )}
            {d.builtIn && (
              <Badge tone="info" quiet title="Shipped with the product">
                Built-in
              </Badge>
            )}
            <span title="Sort order: lower comes first">#{d.sortOrder}</span>
            <span aria-hidden>·</span>
            <span title={f.dateTime(d.updatedAt)}>Updated {f.relative(d.updatedAt)}</span>
          </div>
        </div>
      </Card>
    </li>
  );
}

/** Name it, create it as a draft with a starter heading, paragraph and button, and open it. */
function NewTemplateModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const create = useApiMutation<LibraryDesign, { name: string; category: string }>({
    path: "/admin/email-designs",
    body: (v) => ({ ...v, blocks: starterBlocks(shortId) }),
    invalidate: [platformKey("email-designs")],
    errorToast: false,
    onSuccess: (d) => router.push(`/library/email-templates/${d.id}`),
  });
  const change = (o: boolean) => {
    if (create.isPending) return;
    if (!o) {
      setName("");
      setCategory("");
      create.reset();
    }
    onOpenChange(o);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate({ name: name.trim(), category: category.trim() });
  };
  return (
    <Modal
      open={open}
      onOpenChange={change}
      size="sm"
      icon={<PlatformTile of="library" size="md" />}
      title="New email template"
      description="It starts as a draft with a heading, a paragraph and a button. Workspaces see it once you publish it."
      footer={
        <>
          <Button onClick={() => change(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-library-design" loading={create.isPending} disabled={!name.trim()}>
            Create and edit
          </Button>
        </>
      }
    >
      <form id="new-library-design" onSubmit={submit} noValidate className="flex flex-col gap-3">
        {create.error && !create.error.fields.name && <FormError error={create.error.message} />}
        <Field label="Name" required error={create.error?.fields.name}>
          <Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Black Friday sale" />
        </Field>
        <Field label="Category" hint="Groups templates in the gallery, e.g. Newsletter, Promotion, Announcement." error={create.error?.fields.category}>
          <Input value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} placeholder="Promotion" />
        </Field>
      </form>
    </Modal>
  );
}
