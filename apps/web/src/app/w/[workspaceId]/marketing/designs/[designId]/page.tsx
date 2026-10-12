"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Copy } from "lucide-react";
import { EmailBlocks, EmailTheme as EmailThemeSchema, type EmailBlock, type EmailTheme } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input } from "@/components/ui/Input";
import { Kbd } from "@/components/ui/Kbd";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { BlockEditor } from "@/components/marketing/BlockEditor";
import { useMarketing } from "@/components/marketing/common";
import { DesignPreview } from "@/components/marketing/designs/DesignPreview";
import { cleanTheme, ThemePanel } from "@/components/marketing/designs/ThemePanel";
import { useLeaveGuard } from "@/components/marketing/designs/useLeaveGuard";
import { messageOf, post } from "@/lib/api";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { EmailDesign } from "@/lib/types/marketing";

type Draft = { name: string; blocks: EmailBlock[]; theme: EmailTheme };

const draftOf = (d: EmailDesign): Draft => ({ name: d.name, blocks: d.blocks, theme: cleanTheme(d.theme ?? {}) });

export default function DesignEditorPage() {
  const mk = useMarketing();
  const { designId } = useParams<{ designId: string }>();
  const design = useApiQuery<EmailDesign>(mk.key("designs", designId), mk.path(`/designs/${designId}`));
  return (
    <Page>
      <RequirePermission permission="marketing.read">
        <QueryState
          query={design}
          loading={
            <Card className="p-4">
              <SkeletonText lines={8} />
            </Card>
          }
        >
          {(d) => <Designer key={d.id} design={d} />}
        </QueryState>
      </RequirePermission>
    </Page>
  );
}

function Designer({ design }: { design: EmailDesign }) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const f = useFormat();
  const router = useRouter();
  const qc = useQueryClient();
  const canWrite = ws.can("marketing.write");
  const [baseline, setBaseline] = useState<Draft>(() => draftOf(design));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const dirty = canWrite && JSON.stringify(baseline) !== JSON.stringify(draft);
  const guard = useLeaveGuard(dirty);

  const save = useApiMutation<EmailDesign, Draft>({
    method: "PATCH",
    path: mk.path(`/designs/${design.id}`),
    invalidate: [mk.key("designs", "list")],
    errorToast: false,
    onSuccess: (saved) => {
      const next = draftOf(saved);
      setBaseline(next);
      setDraft(next);
      qc.setQueryData(mk.key("designs", saved.id), saved);
    },
  });
  const archive = useApiMutation<{ archived: boolean }, void>({
    method: "DELETE",
    path: mk.path(`/designs/${design.id}`),
    invalidate: [mk.key("designs")],
    errorToast: false,
    success: "Design archived",
    onSuccess: () => router.push(mk.href("/designs")),
  });

  /** The draft as the API takes it, or null (with a toast) when a block does not match the schema yet. */
  const payload = (): Draft | null => {
    const name = draft.name.trim();
    if (!name) {
      toast.error("Give the design a name first.");
      return null;
    }
    const parsed = EmailBlocks.safeParse(draft.blocks);
    if (!parsed.success) {
      toast.error("Some blocks need fixing first", { description: "The fields to fix are marked in the blocks." });
      return null;
    }
    const theme = EmailThemeSchema.safeParse(draft.theme);
    if (!theme.success) {
      toast.error("The theme needs fixing first", { description: "Use hex colours like #0071e3." });
      return null;
    }
    return { name, blocks: parsed.data, theme: theme.data };
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!dirty || save.isPending) return;
    const body = payload();
    if (body) save.mutate(body, { onSuccess: () => toast.success("Design saved") });
  };

  // ⌘S / Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Duplicates what is on screen: unsaved changes are saved first, so the copy matches. */
  const duplicate = async () => {
    setDuplicating(true);
    try {
      if (dirty) {
        const body = payload();
        if (!body) return;
        await save.mutateAsync(body);
      }
      const copy = await post<EmailDesign>(mk.path(`/designs/${design.id}/duplicate`));
      await qc.invalidateQueries({ queryKey: mk.key("designs", "list") });
      toast.success("Design duplicated", { description: `You're now editing “${copy.name}”.` });
      router.push(mk.href(`/designs/${copy.id}`));
    } catch (e) {
      toast.error(messageOf(e));
    } finally {
      setDuplicating(false);
    }
  };

  const blockCount = draft.blocks.length;

  return (
    <>
      <PageHeader
        back={{ href: mk.href("/designs"), label: "Email designs" }}
        icon={<EntityTile of="designs" />}
        title={draft.name.trim() || design.name}
        meta={
          design.archivedAt || design.fromLibrary ? (
            <span className="flex items-center gap-2">
              {design.fromLibrary && <Badge tone="info">Library</Badge>}
              {design.archivedAt && <Badge tone="warn">Archived</Badge>}
            </span>
          ) : undefined
        }
        description={`${blockCount} block${blockCount === 1 ? "" : "s"} · updated ${f.relative(design.updatedAt)}`}
        actions={
          canWrite ? (
            <>
              {dirty && <span className="text-xs text-text-3">Unsaved changes</span>}
              <Button variant="ghost" icon={<Copy />} loading={duplicating} onClick={() => void duplicate()} title={dirty ? "Saves your changes, then makes a copy" : undefined}>
                Duplicate
              </Button>
              {!design.archivedAt && (
                <Button variant="ghost" icon={<Archive />} onClick={() => setConfirmArchive(true)}>
                  Archive
                </Button>
              )}
              {dirty && (
                <Button
                  onClick={() => {
                    setDraft(baseline);
                    save.reset();
                  }}
                  disabled={save.isPending}
                >
                  Discard
                </Button>
              )}
              <Button variant="primary" type="submit" form="design-form" loading={save.isPending && !duplicating} disabled={!dirty} title="Save (⌘S)">
                Save
              </Button>
            </>
          ) : undefined
        }
      />

      {!canWrite && (
        <Callout tone="info" className="mb-4">
          You can view this design; your role cannot change it.
        </Callout>
      )}
      {canWrite && design.fromLibrary && !design.archivedAt && (
        <Callout tone="info" className="mb-4">
          This design comes from the built-in library. Change it as you like, or duplicate it first to keep the original as a starting point.
        </Callout>
      )}
      {design.archivedAt && (
        <Callout tone="warn" className="mb-4">
          This design is archived: it is hidden from the designs list and cannot be picked for new campaigns.
        </Callout>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <form id="design-form" onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
          {save.error && !save.error.isPlanLimit && <FormError error={save.error.message} />}
          <Card>
            <CardBody>
              <Field
                label="Name"
                required
                error={save.error?.fields.name}
                hint={
                  canWrite ? (
                    <>
                      Only your team sees it. Press <Kbd>⌘S</Kbd> to save.
                    </>
                  ) : undefined
                }
              >
                <Input value={draft.name} maxLength={120} disabled={!canWrite} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Monthly newsletter" />
              </Field>
            </CardBody>
          </Card>
          <ThemePanel theme={draft.theme} onChange={(theme) => setDraft((d) => ({ ...d, theme }))} disabled={!canWrite} />
          <BlockEditor blocks={draft.blocks} theme={draft.theme} onChange={(blocks) => setDraft((d) => ({ ...d, blocks }))} disabled={!canWrite} />
        </form>

        <DesignPreview blocks={draft.blocks} theme={draft.theme} className="h-[min(760px,calc(100dvh-8rem))] min-h-[480px] lg:sticky lg:top-5" />
      </div>

      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive “${design.name}”?`}
        confirmLabel="Archive"
        description={
          dirty
            ? "Your unsaved changes are discarded. The design leaves the designs list and can't be picked for new campaigns; campaigns that already use it keep their own copy."
            : "It leaves the designs list and can't be picked for new campaigns. Campaigns that already use it keep their own copy of the content."
        }
        onConfirm={() => archive.mutateAsync()}
      />
      <ConfirmDialog
        open={guard.pending !== null}
        onOpenChange={(o) => !o && guard.stay()}
        title="Leave without saving?"
        description="Your changes to this design will be lost."
        confirmLabel="Leave"
        cancelLabel="Keep editing"
        onConfirm={guard.leave}
      />
    </>
  );
}
