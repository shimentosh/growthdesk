"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CircleAlert, EyeOff, Trash2, Upload } from "lucide-react";
import { designProblems, EmailBlocks, EmailTheme, renderLibraryPreview, type EmailBlock } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { PlatformTile, platformKey, usePlatform } from "@/features/common/platform";
import { LibraryStatusBadge } from "./common";
import type { LibraryDesign } from "./types";

/*
 * /library/email-templates/[id] — one template: its details, its theme and
 * blocks as JSON (the shapes in packages/shared/src/email-design.ts, checked
 * as you type), and a live preview rendered by the shared renderer with a
 * sample contact, exactly as a workspace's preview shows it.
 */

type Draft = { name: string; description: string; category: string; sortOrder: string; theme: string; blocks: string };

const json = (v: unknown) => JSON.stringify(v, null, 2);
const draftOf = (d: LibraryDesign): Draft => ({
  name: d.name,
  description: d.description,
  category: d.category,
  sortOrder: String(d.sortOrder),
  theme: json(d.theme),
  blocks: json(d.blocks),
});

/** Parses and validates one JSON field: the value, or the first few problems in words. */
function check<T>(text: string, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, what: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false as const, errors: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true as const, value: parsed.data };
  const errors = parsed.error.issues.slice(0, 6).map((i) => `${[what, ...i.path.map(String)].join(".")}: ${i.message}`);
  if (parsed.error.issues.length > 6) errors.push(`…and ${parsed.error.issues.length - 6} more`);
  return { ok: false as const, errors };
}

function JsonErrors({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1 rounded-md bg-bad-wash px-3 py-2 text-xs text-bad-ink">
      {errors.map((e) => (
        <li key={e} className="flex gap-1.5 font-mono">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {e}
        </li>
      ))}
    </ul>
  );
}

function Editor({ d }: { d: LibraryDesign }) {
  const { canChange } = usePlatform();
  const f = useFormat();
  const router = useRouter();
  const [baseline, setBaseline] = useState<Draft>(() => draftOf(d));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [deleting, setDeleting] = useState(false);
  const dirty = canChange && JSON.stringify(draft) !== JSON.stringify(baseline);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const theme = useMemo(() => check(draft.theme, EmailTheme, "theme"), [draft.theme]);
  const blocks = useMemo(() => check<EmailBlock[]>(draft.blocks, EmailBlocks, "blocks"), [draft.blocks]);
  // The preview keeps the last valid version while the JSON is mid-edit.
  const [shown, setShown] = useState({ theme: d.theme, blocks: d.blocks });
  useEffect(() => {
    if (theme.ok && blocks.ok) setShown({ theme: theme.value, blocks: blocks.value });
  }, [theme, blocks]);
  const html = useMemo(() => renderLibraryPreview(shown.blocks, shown.theme).html, [shown]);
  const problems = useMemo(() => (blocks.ok ? designProblems(blocks.value) : []), [blocks]);
  const sortOrder = Number(draft.sortOrder);
  const sortOk = draft.sortOrder.trim() !== "" && Number.isInteger(sortOrder) && sortOrder >= 0 && sortOrder <= 100_000;
  const valid = theme.ok && blocks.ok && sortOk && draft.name.trim() !== "";

  const onSaved = (saved: LibraryDesign) => {
    const next = draftOf(saved);
    setBaseline(next);
    setDraft(next);
  };
  const save = useApiMutation<LibraryDesign, void>({
    method: "PATCH",
    path: `/admin/email-designs/${d.id}`,
    body: () => ({
      name: draft.name.trim(),
      description: draft.description.trim(),
      category: draft.category.trim(),
      sortOrder,
      ...(theme.ok ? { theme: theme.value } : {}),
      ...(blocks.ok ? { blocks: blocks.value } : {}),
    }),
    invalidate: [platformKey("email-designs")],
    errorToast: false,
    onSuccess: onSaved,
  });
  const publish = useApiMutation<LibraryDesign, void>({
    path: `/admin/email-designs/${d.id}/publish`,
    body: () => ({}),
    invalidate: [platformKey("email-designs")],
    success: "Published — workspaces can start from it now",
    errorToast: false,
  });
  const unpublish = useApiMutation<LibraryDesign, void>({
    path: `/admin/email-designs/${d.id}/unpublish`,
    body: () => ({}),
    invalidate: [platformKey("email-designs")],
    success: "Unpublished — it left the workspaces' gallery",
  });
  const remove = useApiMutation<{ deleted: boolean }, void>({
    method: "DELETE",
    path: `/admin/email-designs/${d.id}`,
    invalidate: [platformKey("email-designs")],
    success: "Template deleted",
    errorToast: false,
    onSuccess: () => router.push("/library/email-templates"),
  });

  /** Saves pending edits first, so what is published is what is on screen. */
  const doPublish = async () => {
    if (dirty) onSaved(await save.mutateAsync());
    await publish.mutateAsync();
  };

  const error = save.error ?? publish.error;
  const published = d.status === "published";

  return (
    <>
      <PageHeader
        back={{ href: "/library/email-templates", label: "Email templates" }}
        icon={<PlatformTile of="library" />}
        title={draft.name.trim() || d.name}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <LibraryStatusBadge status={d.status} />
            {d.builtIn && (
              <Badge tone="info" quiet title="Shipped with the product">
                Built-in
              </Badge>
            )}
            {dirty && (
              <Badge tone="warn" dot>
                Unsaved changes
              </Badge>
            )}
          </span>
        }
        description={
          <>
            <span className="font-mono">{d.key}</span> · updated {f.relative(d.updatedAt)}
            {d.createdBy && ` · added by ${d.createdBy.name || d.createdBy.email}`}
          </>
        }
        actions={
          canChange && (
            <>
              <Button variant="ghost" icon={<Trash2 />} onClick={() => setDeleting(true)}>
                Delete
              </Button>
              {dirty && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraft(baseline);
                    save.reset();
                  }}
                  disabled={save.isPending}
                >
                  Discard
                </Button>
              )}
              <Button loading={save.isPending && !publish.isPending} disabled={!dirty || !valid} onClick={() => save.mutate(undefined, { onSuccess: () => toast.success("Template saved") })}>
                Save
              </Button>
              {published ? (
                <Button icon={<EyeOff />} loading={unpublish.isPending} onClick={() => unpublish.mutate()}>
                  Unpublish
                </Button>
              ) : (
                <Button
                  variant="primary"
                  icon={<Upload />}
                  loading={publish.isPending}
                  disabled={!valid || problems.length > 0}
                  title={problems.length ? "Fix the problems listed under the preview first" : undefined}
                  onClick={() => void doPublish().catch(() => undefined)}
                >
                  {dirty ? "Save and publish" : "Publish"}
                </Button>
              )}
            </>
          )
        }
      />
      {!canChange && (
        <Callout tone="info" className="mb-4">
          Platform support can view and preview templates; an admin or owner edits them.
        </Callout>
      )}
      {canChange && published && (
        <Callout tone="info" className="mb-4">
          Published: saved changes reach every workspace's gallery at once{d.builtIn ? ", and new workspaces get this version as their built-in copy" : ""}. Designs workspaces already made from it keep their own copy.
        </Callout>
      )}
      <FormError error={error?.message} className="mb-4" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Details" description="What workspaces see in the gallery. The key never changes; designs made from this template remember it." />
            <CardBody className="flex flex-col gap-3">
              <Field label="Name" required error={save.error?.fields.name ?? (draft.name.trim() ? undefined : "Required")}>
                <Input value={draft.name} maxLength={120} disabled={!canChange} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Description" hint="One sentence on when to use it." error={save.error?.fields.description}>
                <Textarea rows={2} maxLength={500} value={draft.description} disabled={!canChange} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Category" hint="Groups templates in the gallery." error={save.error?.fields.category}>
                  <Input value={draft.category} maxLength={60} disabled={!canChange} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="Newsletter" />
                </Field>
                <Field label="Sort order" hint="Lower comes first." error={sortOk ? save.error?.fields.sortOrder : "A whole number from 0 to 100000"}>
                  <Input type="number" min={0} max={100000} step={1} value={draft.sortOrder} disabled={!canChange} onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })} />
                </Field>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Theme" description="Colours (hex), fonts (system, helvetica, georgia, verdana, trebuchet, mono) and corner radii. {} uses the defaults." />
            <CardBody>
              <Textarea
                aria-label="Theme JSON"
                rows={10}
                spellCheck={false}
                readOnly={!canChange}
                value={draft.theme}
                invalid={!theme.ok}
                onChange={(e) => setDraft({ ...draft, theme: e.target.value })}
                className="font-mono text-xs leading-relaxed"
              />
              <JsonErrors errors={theme.ok ? [] : theme.errors} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Blocks" description="Rendered top to bottom: header, hero, heading, text, button, image, columns, list, callout, social, divider, spacer. Each needs a unique id." />
            <CardBody>
              <Textarea
                aria-label="Blocks JSON"
                rows={28}
                spellCheck={false}
                readOnly={!canChange}
                value={draft.blocks}
                invalid={!blocks.ok}
                onChange={(e) => setDraft({ ...draft, blocks: e.target.value })}
                className="font-mono text-xs leading-relaxed"
              />
              <JsonErrors errors={blocks.ok ? [] : blocks.errors} />
            </CardBody>
          </Card>
        </div>
        <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <Card className="overflow-hidden">
            <CardHeader title="Preview" description="With a sample contact (Alex Rivera) and placeholder footer, as a workspace's preview shows it." />
            {!(theme.ok && blocks.ok) && <div className="border-b border-line bg-warn-wash px-3 py-2 text-xs text-warn-ink">Showing the last valid version while the JSON has errors.</div>}
            {problems.length > 0 && (
              <div className="border-b border-line bg-warn-wash px-3 py-2">
                <ul className="flex flex-col gap-1 text-xs text-warn-ink">
                  {problems.map((x) => (
                    <li key={x} className="flex gap-1.5">
                      <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <iframe title="Email preview" sandbox="" srcDoc={html} className="block h-[min(760px,calc(100dvh-10rem))] min-h-[480px] w-full border-0 bg-[#f5f5f7]" />
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete “${d.name}”?`}
        description={
          d.builtIn
            ? "It leaves every workspace's gallery and new workspaces no longer get it. It stays deleted: the built-in is not added back on the next deploy. Designs already made from it are not affected."
            : "It leaves every workspace's gallery. Designs already made from it are not affected."
        }
        confirmLabel="Delete template"
        onConfirm={() => remove.mutateAsync()}
      />
    </>
  );
}

export function EmailDesignEditor() {
  const { id } = useParams<{ id: string }>();
  const detail = useApiQuery<LibraryDesign>(platformKey("email-designs", id), `/admin/email-designs/${id}`);
  return (
    <Page>
      <QueryState query={detail} loading={<SkeletonText lines={12} />}>
        {(d) => <Editor key={d.id} d={d} />}
      </QueryState>
    </Page>
  );
}
