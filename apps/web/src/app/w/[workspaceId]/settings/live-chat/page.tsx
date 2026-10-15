"use client";

import { useState, type FormEvent } from "react";
import { Eye, MessagesSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { WIDGET_DEFAULTS, type WebWidgetSettingsT } from "@growthdesk/shared";
import { useTags } from "@/components/crm/Tags";
import { tagTone } from "@/components/imports/labels";
import { CopyValue } from "@/components/integrations/Copy";
import { MemberPicker } from "@/components/pickers/Pickers";
import { formLevelError } from "@/components/pipeline/utils";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, NativeSelect, Textarea } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { RequirePermission } from "@/components/ui/RequirePermission";
import { Switch } from "@/components/ui/Switch";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";

/** `LiveChatService.dto()` — GET /livechat/widgets. */
type Widget = {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  settings: WebWidgetSettingsT;
  lastEventAt: string | null;
  snippet: string;
  previewUrl: string;
  createdAt: string;
  updatedAt: string;
};

export default function LiveChatSettingsPage() {
  return (
    <RequirePermission permission="integrations.read">
      <LiveChatSettings />
    </RequirePermission>
  );
}

function LiveChatSettings() {
  const ws = useWorkspace();
  const canManage = ws.can("integrations.manage");
  const widgets = useApiQuery<Widget[]>(ws.key("livechat", "widgets"), ws.path("/livechat/widgets"));
  // undefined: closed; null: new; a widget: editing it.
  const [editing, setEditing] = useState<Widget | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Widget | null>(null);
  const [preview, setPreview] = useState<Widget | null>(null);

  const remove = useApiMutation<unknown, string>({
    method: "DELETE",
    path: (id) => ws.path(`/livechat/widgets/${id}`),
    invalidate: [ws.key("livechat"), ws.key("inbox", "facets")],
    success: "Widget removed",
  });

  const newButton = canManage ? (
    <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>
      New widget
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        icon={<EntityTile of="liveChat" />}
        title="Live chat"
        description="A chat bubble for your website. Visitors' messages arrive in the Inbox next to email, WhatsApp and Telegram, and your replies show up in their chat window instantly."
        actions={newButton}
      />

      <QueryState
        query={widgets}
        isEmpty={(d) => d.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={<MessagesSquare />}
              tint="purple"
              title="No chat widget yet"
              description="Create a widget, paste one line of code into your website, and start chatting with visitors from the Inbox."
              action={newButton}
            />
          </Card>
        }
      >
        {(rows) => (
          <div className="flex flex-col gap-4">
            {rows.map((w) => (
              <WidgetCard key={w.id} w={w} canManage={canManage} onEdit={() => setEditing(w)} onDelete={() => setDeleting(w)} onPreview={() => setPreview(w)} />
            ))}
          </div>
        )}
      </QueryState>

      {editing !== undefined && <WidgetForm widget={editing} onClose={() => setEditing(undefined)} />}

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name ?? "this widget"}?`}
        description="The chat bubble disappears from every site using this code. Past chats stay in the Inbox."
        confirmLabel="Remove widget"
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />

      <Modal open={Boolean(preview)} onOpenChange={(o) => !o && setPreview(null)} title={`Preview: ${preview?.name ?? ""}`} size="sm">
        {preview && (
          <div className="flex flex-col gap-2">
            <iframe title="Chat preview" src={preview.previewUrl} className="h-[560px] w-full rounded-lg border border-line bg-s-2" />
            <p className="text-2xs text-text-3">How the open chat looks on your site. Messages are not sent from the preview.</p>
          </div>
        )}
      </Modal>
    </>
  );
}

function WidgetCard({ w, canManage, onEdit, onDelete, onPreview }: { w: Widget; canManage: boolean; onEdit: () => void; onDelete: () => void; onPreview: () => void }) {
  const ws = useWorkspace();
  const f = useFormat();
  const toggle = useApiMutation<Widget, { enabled: boolean }>({
    method: "PATCH",
    path: ws.path(`/livechat/widgets/${w.id}`),
    invalidate: [ws.key("livechat")],
    success: (r) => (r.enabled ? "Chat switched on" : "Chat switched off"),
  });
  const s = w.settings;
  return (
    <Card>
      <CardHeader
        icon={
          <span aria-hidden className="block size-4 rounded-full" style={{ background: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : undefined }} />
        }
        title={w.name}
        description={w.lastEventAt ? `Last message ${f.relative(w.lastEventAt)}` : "No chats yet"}
        actions={
          <div className="flex items-center gap-2">
            <Switch
              aria-label="Chat on"
              checked={w.enabled}
              disabled={!canManage || toggle.isPending}
              onCheckedChange={(enabled) => toggle.mutate({ enabled })}
              label={w.enabled ? "On" : "Off"}
            />
            <Button size="sm" variant="secondary" icon={<Eye />} onClick={onPreview}>
              Preview
            </Button>
            {canManage && (
              <>
                <Button size="sm" variant="secondary" icon={<Pencil />} onClick={onEdit}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={onDelete} aria-label="Remove widget" />
              </>
            )}
          </div>
        }
      />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <Field label="Install" hint="Paste before </body> on every page where the chat should appear (or add it with Google Tag Manager).">
          <CopyValue value={w.snippet} copied="Snippet copied" />
        </Field>
        <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
          <Row label="Title">{s.title}</Row>
          <Row label="Side">{s.position === "left" ? "Bottom left" : "Bottom right"}</Row>
          <Row label="Ask for name & email">{s.preChat === "required" ? "Before chatting" : s.preChat === "optional" ? "After the first message (optional)" : "Never"}</Row>
          <Row label="Allowed sites">{s.allowedDomains.length ? s.allowedDomains.join(", ") : "Any website"}</Row>
        </dl>
      </div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-text-3">{label}</dt>
      <dd className="min-w-0 truncate text-text">{children}</dd>
    </div>
  );
}

function WidgetForm({ widget, onClose }: { widget: Widget | null; onClose: () => void }) {
  const ws = useWorkspace();
  const tags = useTags();
  const start: WebWidgetSettingsT = { ...WIDGET_DEFAULTS, allowedDomains: [], tagIds: [], ...widget?.settings };
  const [name, setName] = useState(widget?.name ?? "Website chat");
  const [s, setS] = useState<WebWidgetSettingsT>(start);
  const [domains, setDomains] = useState(start.allowedDomains.join("\n"));
  const set = (patch: Partial<WebWidgetSettingsT>) => setS((prev) => ({ ...prev, ...patch }));

  const save = useApiMutation<Widget, { name: string; settings: WebWidgetSettingsT }>({
    method: widget ? "PATCH" : "POST",
    path: widget ? ws.path(`/livechat/widgets/${widget.id}`) : ws.path("/livechat/widgets"),
    invalidate: [ws.key("livechat"), ws.key("inbox", "facets")],
    success: widget ? "Widget saved" : "Widget created",
    errorToast: false,
    onSuccess: onClose,
  });
  const fields = save.error?.fields ?? {};
  const formError = formLevelError(save.error, ["name", "settings.title", "settings.greeting", "settings.replyTime", "settings.color", "settings.allowedDomains", "settings.assigneeId", "settings.tagIds"]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const allowedDomains = domains
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean);
    save.mutate({ name: name.trim(), settings: { ...s, allowedDomains } });
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={widget ? `Edit ${widget.name}` : "New chat widget"}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="widget-form" loading={save.isPending}>
            {widget ? "Save" : "Create widget"}
          </Button>
        </>
      }
    >
      <form id="widget-form" onSubmit={submit} className="flex flex-col gap-3.5">
        <FormError error={formError} />
        <Field label="Name" hint="For you; visitors see the title." error={fields.name} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Title" error={fields["settings.title"]}>
            <Input value={s.title} onChange={(e) => set({ title: e.target.value })} maxLength={60} />
          </Field>
          <Field label="Colour" error={fields["settings.color"]}>
            <div className="flex items-center gap-2">
              <input type="color" aria-label="Colour" value={s.color} onChange={(e) => set({ color: e.target.value })} className="h-8 w-10 cursor-pointer rounded-sm border border-line bg-transparent" />
              <Input value={s.color} onChange={(e) => set({ color: e.target.value })} maxLength={7} className="w-24 font-mono" />
            </div>
          </Field>
        </div>
        <Field label="Greeting" hint="The first message a visitor sees." error={fields["settings.greeting"]}>
          <Textarea rows={2} value={s.greeting} onChange={(e) => set({ greeting: e.target.value })} maxLength={300} />
        </Field>
        <Field label="Reply time" hint="Under the title, e.g. “We usually reply within an hour”." error={fields["settings.replyTime"]}>
          <Input value={s.replyTime} onChange={(e) => set({ replyTime: e.target.value })} maxLength={80} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Position">
            <NativeSelect
              value={s.position}
              onChange={(e) => set({ position: e.target.value as WebWidgetSettingsT["position"] })}
              options={[
                { value: "right", label: "Bottom right" },
                { value: "left", label: "Bottom left" },
              ]}
            />
          </Field>
          <Field label="Ask for name & email">
            <NativeSelect
              value={s.preChat}
              onChange={(e) => set({ preChat: e.target.value as WebWidgetSettingsT["preChat"] })}
              options={[
                { value: "optional", label: "After the first message (optional)" },
                { value: "required", label: "Before chatting (required)" },
                { value: "off", label: "Never" },
              ]}
            />
          </Field>
        </div>
        <Field label="Assign new chats to" hint="Otherwise they arrive unassigned." error={fields["settings.assigneeId"]}>
          <MemberPicker value={s.assigneeId} placeholder="Nobody (unassigned)" onChange={(assigneeId) => set({ assigneeId })} />
        </Field>
        <Field label="Tag new chats with" hint="Makes them easy to filter in the Inbox rail." error={fields["settings.tagIds"]}>
          <div className="flex flex-wrap gap-1.5">
            {(tags.data ?? []).map((t) => {
              const on = s.tagIds.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ tagIds: on ? s.tagIds.filter((x) => x !== t.id) : [...s.tagIds, t.id].slice(0, 10) })}
                  className={on ? "rounded-xs ring-2 ring-accent" : "rounded-xs opacity-60 hover:opacity-100"}
                >
                  <Badge tone={tagTone(t.color)}>{t.name}</Badge>
                </button>
              );
            })}
            {!tags.data?.length && <span className="text-xs text-text-3">No tags yet. Create them under Settings → Tags.</span>}
          </div>
        </Field>
        <Field
          label="Allowed websites"
          hint="One per line, e.g. example.com (its subdomains are included). Leave empty to allow any site."
          error={fields["settings.allowedDomains"] ?? Object.entries(fields).find(([k]) => k.startsWith("settings.allowedDomains."))?.[1]}
        >
          <Textarea rows={2} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" />
        </Field>
      </form>
    </Modal>
  );
}
