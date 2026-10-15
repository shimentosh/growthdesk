"use client";

import { useRef, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, BadgeCheck, MessageSquareText, Trash2 } from "lucide-react";
import { CHANNELS, labelOf, type Channel } from "@growthdesk/shared";
import { AiWriteButton } from "@/components/ai/AiWriteDialog";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, Textarea } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Select } from "@/components/ui/Select";
import { SkeletonText } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toast";
import { TemplatePreviewPanel } from "@/components/templates/TemplatePreviewPanel";
import { VariableMenu, focusAt, spliceToken, useTemplateVariables } from "@/components/templates/VariableMenu";
import { VersionHistory } from "@/components/templates/VersionHistory";
import { useUnsavedChanges } from "@/lib/unsaved";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { Template, TemplateBody, TemplateDeleteResult } from "@/lib/types/templates";

type Draft = { name: string; channel: Channel; category: string; subject: string; body: string; waTemplate: string; waLanguage: string };

const BLANK: Draft = { name: "", channel: "email", category: "", subject: "", body: "", waTemplate: "", waLanguage: "" };

const draftOf = (t: Template): Draft => ({
  name: t.name,
  channel: t.channel,
  category: t.category ?? "",
  subject: t.subject ?? "",
  body: t.body ?? "",
  waTemplate: t.waTemplate ?? "",
  waLanguage: t.waLanguage ?? "",
});

const CHANNEL_HINT: Record<Channel, string> = {
  email: "Used by email steps.",
  whatsapp: "Used by WhatsApp steps.",
  telegram: "Used by Telegram steps.",
  call: "A call script for your own reference; sequence steps do not send call templates.",
  web: "A saved reply for website live chat; paste it into a chat from the inbox.",
};

function Editor({ template }: { template: Template | null }) {
  const ws = useWorkspace();
  const f = useFormat();
  const router = useRouter();
  const qc = useQueryClient();
  const canWrite = ws.can("templates.write");
  const vars = useTemplateVariables();
  const [baseline, setBaseline] = useState<Draft>(() => (template ? draftOf(template) : BLANK));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [confirm, setConfirm] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocus = useRef<"subject" | "body">("body");
  const dirty = JSON.stringify(baseline) !== JSON.stringify(draft);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const isEmail = draft.channel === "email";

  // Leaving with unsaved edits asks first: reloads, closing the tab, and in-app links (the sidebar included).
  useUnsavedChanges(dirty && canWrite, "Your changes to this template will be lost.");

  const save = useApiMutation<Template, TemplateBody>({
    method: template ? "PATCH" : "POST",
    path: template ? ws.path(`/templates/${template.id}`) : ws.path("/templates"),
    invalidate: [ws.key("templates")],
    success: (saved) => (template ? (saved.version !== template.version ? `Saved as version ${saved.version}` : "Template saved") : "Template created"),
    errorToast: false,
    onSuccess: (saved) => {
      const next = draftOf(saved);
      setBaseline(next);
      setDraft(next);
      qc.setQueryData(ws.key("templates", saved.id), saved);
      if (!template) router.replace(ws.href(`/templates/${saved.id}`));
    },
  });
  const remove = useApiMutation<TemplateDeleteResult, void>({
    method: "DELETE",
    path: ws.path(`/templates/${template?.id}`),
    invalidate: [ws.key("templates", "list"), ws.key("templates", "picker")],
    errorToast: false,
    onSuccess: (r) => {
      toast.success(r.archived ? "Template archived" : "Template deleted", {
        description: r.archived ? `Still used by ${r.usedBySteps} step${r.usedBySteps === 1 ? "" : "s"}, which keep sending it.` : undefined,
      });
      router.push(ws.href("/templates"));
    },
  });

  const fields = save.error?.fields ?? {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      name: draft.name.trim(),
      channel: draft.channel,
      category: draft.category.trim(),
      subject: isEmail ? draft.subject : "",
      body: draft.body,
      waTemplate: draft.channel === "whatsapp" ? draft.waTemplate.trim() : "",
      waLanguage: draft.channel === "whatsapp" ? draft.waLanguage.trim() : "",
    });
  };

  const insert = (token: string) => {
    const target = isEmail && lastFocus.current === "subject" ? "subject" : "body";
    const el = target === "subject" ? subjectRef.current : bodyRef.current;
    const next = spliceToken(el, draft[target], token);
    set(target, next.value);
    focusAt(el, next.caret);
  };

  const used = template?.usedBySteps ?? 0;

  return (
    <>
      <PageHeader
        back={{ href: ws.href("/templates"), label: "Templates" }}
        icon={<EntityTile of="templates" />}
        title={draft.name.trim() || (template ? template.name : "New template")}
        meta={
          template ? (
            <>
              <Badge quiet>v{template.version}</Badge>
              {template.fromLibrary && <Badge tone="info">Library</Badge>}
              {template.archivedAt && <Badge tone="warn">Archived</Badge>}
            </>
          ) : undefined
        }
        description={
          template
            ? `${labelOf(template.channel)} · used by ${used} step${used === 1 ? "" : "s"} · updated ${f.relative(template.updatedAt)}`
            : "Write it once, personalise it with variables, and reuse it in sequence steps."
        }
        actions={
          canWrite ? (
            <>
              {dirty && <span className="text-xs text-text-3">Unsaved changes</span>}
              {template && (
                <Button variant="ghost" icon={used > 0 ? <Archive /> : <Trash2 />} onClick={() => setConfirm(true)}>
                  {used > 0 ? "Archive" : "Delete"}
                </Button>
              )}
              {dirty && template && (
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
              <Button variant="primary" type="submit" form="template-form" loading={save.isPending} disabled={template ? !dirty : false}>
                {template ? "Save" : "Create template"}
              </Button>
            </>
          ) : undefined
        }
      />

      {!canWrite && (
        <Callout tone="info" className="mb-4">
          You can view this template; your role cannot change it.
        </Callout>
      )}
      {template?.archivedAt && (
        <Callout tone="warn" className="mb-4">
          This template is archived: the template list hides it unless you filter for archived ones, and the steps that already use it keep sending it.
        </Callout>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <form id="template-form" onSubmit={submit} noValidate className="min-w-0">
          <fieldset disabled={!canWrite} className="flex min-w-0 flex-col gap-4">
            {save.error && !save.error.isPlanLimit && <FormError error={save.error.message} />}
            <Card>
              <CardBody className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" required error={fields.name} className="sm:col-span-2">
                  <Input value={draft.name} maxLength={120} onChange={(e) => set("name", e.target.value)} placeholder="Intro: founder to founder" />
                </Field>
                <Field label="Channel" error={fields.channel} hint={CHANNEL_HINT[draft.channel]}>
                  <Select<Channel>
                    value={draft.channel}
                    disabled={!canWrite}
                    onValueChange={(v) => set("channel", v)}
                    options={CHANNELS.map((c) => ({ value: c, label: labelOf(c) }))}
                  />
                </Field>
                <Field label="Category" error={fields.category} hint="Optional, for finding it later.">
                  <Input value={draft.category} maxLength={60} onChange={(e) => set("category", e.target.value)} placeholder="Intro, follow-up, break-up…" />
                </Field>
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                icon={<MessageSquareText />}
                title="Message"
                description={
                  <>
                    Variables are filled from the contact. Add a fallback after a pipe for contacts without a value:{" "}
                    <code className="font-mono text-text-2">{vars.data.fallbackSyntax}</code>
                  </>
                }
                actions={
                  canWrite ? (
                    <>
                      <AiWriteButton
                        target="template"
                        channel={draft.channel}
                        subject={draft.subject}
                        body={draft.body}
                        onApply={(out) => setDraft((d) => ({ ...d, body: out.body, ...(d.channel === "email" ? { subject: out.subject } : {}) }))}
                      />
                      <VariableMenu onPick={insert} />
                    </>
                  ) : undefined
                }
              />
              <CardBody className="flex flex-col gap-4">
                {isEmail && (
                  <Field label="Subject" error={fields.subject} hint="Empty on a follow-up step: it replies in the first email's thread (“Re: …”).">
                    <Input
                      ref={subjectRef}
                      value={draft.subject}
                      maxLength={300}
                      onFocus={() => (lastFocus.current = "subject")}
                      onChange={(e) => set("subject", e.target.value)}
                      placeholder="Quick question about {{company|your team}}"
                    />
                  </Field>
                )}
                <Field
                  label="Body"
                  required
                  error={fields.body}
                  hint={isEmail ? "Plain text. **Bold**, _italics_, lists, quotes and links are formatted when the email is sent." : undefined}
                >
                  <Textarea
                    ref={bodyRef}
                    rows={14}
                    value={draft.body}
                    maxLength={50000}
                    onFocus={() => (lastFocus.current = "body")}
                    onChange={(e) => set("body", e.target.value)}
                    placeholder={"Hi {{first_name|there}},\n\n…"}
                    className="font-mono text-[13px]"
                  />
                </Field>
              </CardBody>
            </Card>

            {draft.channel === "whatsapp" && (
              <Card>
                <CardHeader icon={<BadgeCheck />} title="WhatsApp approved template" description="Optional. The name of a message template approved in your WhatsApp Business account." />
                <CardBody className="grid gap-4 sm:grid-cols-2">
                  <Field label="Template name" error={fields.waTemplate} hint="When set, the step sends this approved template.">
                    <Input value={draft.waTemplate} maxLength={200} onChange={(e) => set("waTemplate", e.target.value)} placeholder="intro_v1" className="font-mono" />
                  </Field>
                  <Field label="Language" error={fields.waLanguage} hint="Empty: en.">
                    <Input value={draft.waLanguage} maxLength={20} onChange={(e) => set("waLanguage", e.target.value)} placeholder="en" className="font-mono" />
                  </Field>
                </CardBody>
              </Card>
            )}
          </fieldset>
        </form>

        <div className="flex min-w-0 flex-col gap-4">
          <TemplatePreviewPanel templateId={template?.id ?? null} channel={draft.channel} subject={draft.subject} body={draft.body} />
          {template && (
            <VersionHistory
              templateId={template.id}
              currentVersion={template.version}
              showSubject={isEmail}
              onRestore={
                canWrite
                  ? (v) => {
                      setDraft((d) => ({ ...d, subject: v.subject, body: v.body }));
                      toast.info(`Version ${v.version} is in the editor`, { description: "Save to make it the current wording." });
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>

      {template && (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={used > 0 ? `Archive “${template.name}”?` : `Delete “${template.name}”?`}
          confirmLabel={used > 0 ? "Archive" : "Delete"}
          description={
            used > 0
              ? `${used} sequence or campaign step${used === 1 ? " uses" : "s use"} it, so it is archived instead of deleted: those steps keep sending it, and the template list hides it unless you filter for archived ones.`
              : "No step uses it. It and its version history are removed for good."
          }
          onConfirm={() => remove.mutateAsync()}
        />
      )}
    </>
  );
}

export default function TemplateEditorPage() {
  const ws = useWorkspace();
  const { templateId } = useParams<{ templateId: string }>();
  const isNew = templateId === "new";
  const tpl = useApiQuery<Template>(ws.key("templates", templateId), isNew ? null : ws.path(`/templates/${templateId}`));

  return (
    <Page width="capped">
      <RequirePermission permission={isNew ? "templates.write" : "templates.read"}>
        {isNew ? (
          <Editor key="new" template={null} />
        ) : (
          <QueryState
            query={tpl}
            loading={
              <Card className="p-4">
                <SkeletonText lines={8} />
              </Card>
            }
          >
            {(t) => <Editor key={t.id} template={t} />}
          </QueryState>
        )}
      </RequirePermission>
    </Page>
  );
}
