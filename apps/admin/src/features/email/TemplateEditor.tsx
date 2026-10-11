"use client";

import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, History, RotateCcw, Send, Upload } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog, Modal } from "@/components/ui/Dialog";
import { QueryState } from "@/components/ui/ErrorState";
import { Field, FormError } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Input";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonText, Spinner } from "@/components/ui/Skeleton";
import { post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { PlatformTile, platformKey, usePlatform } from "@/features/common/platform";
import { BlockEditor, TokenInput, TokenScope, VariablePicker } from "./BlockEditor";
import { CATEGORY_LABEL } from "./common";
import { SendResultView } from "./EmailSettings";
import type { SendResult, TemplateContent, TemplateDetail, TemplatePreview } from "./types";

/*
 * /email/templates/[key] — edit one system email. The draft lives in the
 * browser until it is published as a new version (which goes live at once).
 * The preview is rendered by the API (same renderer as the real send) with
 * sample values, so what you see is what goes out.
 */

const same = (a: TemplateContent, b: TemplateContent) => JSON.stringify(a) === JSON.stringify(b);
const contentOf = (c: TemplateContent): TemplateContent => ({ subject: c.subject, preheader: c.preheader, blocks: c.blocks });

/** Warns before leaving with unpublished edits: tab close/reload, and in-app links. */
function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.origin !== window.location.origin || a.pathname === window.location.pathname) return;
      if (!window.confirm("You have unpublished changes to this email. Leave without publishing?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
}

/** Debounced server-side render of the draft. */
function usePreview(key: string, draft: TemplateContent | null) {
  const [state, setState] = useState<{ data: TemplatePreview | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
  const body = draft ? JSON.stringify(draft) : null;
  useEffect(() => {
    if (!body) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      post<TemplatePreview>(`/admin/email/templates/${key}/preview`, JSON.parse(body), { signal: ctrl.signal })
        .then((data) => setState({ data, error: null, loading: false }))
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false }));
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [key, body]);
  return state;
}

function Preview({ preview, mode, setMode }: { preview: ReturnType<typeof usePreview>; mode: "html" | "text"; setMode: (m: "html" | "text") => void }) {
  const p = preview.data;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-hi">
          Preview
          {preview.loading && <Spinner size="sm" label="Rendering" />}
        </div>
        <div role="tablist" aria-label="Preview format" className="inline-flex rounded-md border border-line-strong bg-ctl-face p-0.5 text-xs">
          {(["html", "text"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn("rounded px-2 py-0.5", mode === m ? "bg-accent/12 font-medium text-accent-ink" : "text-text-2 hover:text-text")}
            >
              {m === "html" ? "Email" : "Plain text"}
            </button>
          ))}
        </div>
      </div>
      {p && (
        <div className="border-b border-line bg-well px-3 py-2 text-xs">
          <div className="truncate">
            <span className="text-text-3">Subject </span>
            <span className="font-medium text-text">{p.subject || "—"}</span>
          </div>
        </div>
      )}
      {preview.error && <Callout tone="bad" className="m-3">{preview.error}</Callout>}
      {p && p.problems.length > 0 && (
        <div className="border-b border-line bg-warn-wash px-3 py-2">
          <ul className="flex flex-col gap-1 text-xs text-warn-ink">
            {p.problems.map((x) => (
              <li key={x} className="flex gap-1.5">
                <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {x}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="bg-[#f5f5f7]">
        {!p ? (
          <div className="flex h-[560px] items-center justify-center text-sm text-text-3">{preview.loading ? "Rendering…" : "—"}</div>
        ) : mode === "html" ? (
          <iframe title="Email preview" sandbox="" srcDoc={p.html} className="block h-[640px] w-full border-0 bg-[#f5f5f7]" />
        ) : (
          <pre className="h-[640px] overflow-auto bg-panel px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text">{p.text}</pre>
        )}
      </div>
    </Card>
  );
}

function Versions({ t, onLoad, canChange }: { t: TemplateDetail; onLoad: (c: TemplateContent, what: string) => void; canChange: boolean }) {
  const f = useFormat();
  const [activating, setActivating] = useState<{ id: string; version: number } | null>(null);
  const [resetting, setResetting] = useState(false);
  const activate = useApiMutation<TemplateDetail, string>({
    path: (id) => `/admin/email/templates/${t.key}/versions/${id}/activate`,
    body: () => ({}),
    invalidate: [platformKey("email-templates")],
    success: (_d, id) => `Version ${t.versions.find((v) => v.id === id)?.version} is live again`,
    errorToast: false,
  });
  const reset = useApiMutation<TemplateDetail, void>({
    path: `/admin/email/templates/${t.key}/reset`,
    body: () => ({}),
    invalidate: [platformKey("email-templates")],
    success: "Reset to the built-in default",
    errorToast: false,
  });
  return (
    <Card>
      <CardHeader
        icon={<History />}
        title="Version history"
        description="Publishing creates a new version and makes it live. Activate an earlier one to roll back; history is never deleted."
        actions={
          canChange &&
          t.customised && (
            <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => setResetting(true)}>
              Reset to default
            </Button>
          )
        }
      />
      <ul className="divide-y divide-line">
        {t.versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-text-hi">Version {v.version}</span>
                {v.active && (
                  <Badge tone="ok" dot>
                    Live
                  </Badge>
                )}
                <span className="truncate text-xs text-text-3">{v.subject}</span>
              </div>
              <div className="text-xs text-text-3">
                {f.dateTime(v.createdAt)}
                {v.createdBy && ` · ${v.createdBy.name || v.createdBy.email}`}
                {v.note && <span className="text-text-2"> · “{v.note}”</span>}
              </div>
            </div>
            <div className="flex gap-1.5">
              {canChange && (
                <Button size="sm" variant="ghost" onClick={() => onLoad(v, `version ${v.version}`)}>
                  Edit a copy
                </Button>
              )}
              {canChange && !v.active && (
                <Button size="sm" onClick={() => setActivating({ id: v.id, version: v.version })}>
                  Make live
                </Button>
              )}
            </div>
          </li>
        ))}
        <li className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-text-hi">Built-in default</span>
              {!t.customised && (
                <Badge tone="ok" dot>
                  Live
                </Badge>
              )}
              <span className="truncate text-xs text-text-3">{t.default.subject}</span>
            </div>
            <div className="text-xs text-text-3">Shipped with the product; updates with it.</div>
          </div>
          {canChange && (
            <Button size="sm" variant="ghost" onClick={() => onLoad(t.default, "the default")}>
              Edit a copy
            </Button>
          )}
        </li>
      </ul>
      <ConfirmDialog
        open={activating !== null}
        onOpenChange={(v) => !v && setActivating(null)}
        tone="default"
        title={`Make version ${activating?.version} live?`}
        description="Every email of this kind sent from now on uses that version."
        confirmLabel="Make live"
        onConfirm={async () => {
          if (activating) await activate.mutateAsync(activating.id);
        }}
      />
      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Reset to the built-in default?"
        description="This email goes back to the product's default wording now. Your versions stay in the history and can be made live again."
        confirmLabel="Reset to default"
        onConfirm={() => reset.mutateAsync()}
      />
    </Card>
  );
}

function PublishDialog({ open, onOpenChange, onPublish, pending, error, problems }: { open: boolean; onOpenChange: (v: boolean) => void; onPublish: (note: string) => void; pending: boolean; error: string | null; problems: string[] }) {
  const [note, setNote] = useState("");
  useEffect(() => {
    if (open) setNote("");
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Publish this version?"
      description="It goes live immediately for every email of this kind. You can roll back from the version history."
      dismissOnOutside={false}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" icon={<Upload />} loading={pending} disabled={problems.length > 0} onClick={() => onPublish(note.trim())}>
            Publish
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormError error={error} />
        {problems.length > 0 && (
          <Callout tone="warn" title="Fix these first">
            <ul className="list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Callout>
        )}
        <Field label="Note (optional)" hint="What changed — shown in the version history and the audit log.">
          <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Friendlier wording, new button label" />
        </Field>
      </div>
    </Modal>
  );
}

function Editor({ t }: { t: TemplateDetail }) {
  const { canChange } = usePlatform();
  const [draft, setDraft] = useState<TemplateContent>(() => contentOf(t.current));
  const [base, setBase] = useState<TemplateContent>(() => contentOf(t.current));
  const [mode, setMode] = useState<"html" | "text">("html");
  const [publishing, setPublishing] = useState(false);
  const [testResult, setTestResult] = useState<SendResult | null>(null);
  const live = useRef(t.activeVersionId);

  // When what is live changes (publish, rollback, reset), follow it unless there are unsaved edits.
  useEffect(() => {
    if (live.current === t.activeVersionId) return;
    live.current = t.activeVersionId;
    const next = contentOf(t.current);
    setBase(next);
    setDraft((d) => (same(d, base) ? next : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.activeVersionId, t.current]);

  const dirty = !same(draft, base);
  useUnsavedGuard(dirty && canChange);
  const preview = usePreview(t.key, draft);
  const problems = preview.data?.problems ?? [];
  const hasActionUrl = t.variables.some((v) => v.key === "action_url");

  const publish = useApiMutation<TemplateDetail, string>({
    path: `/admin/email/templates/${t.key}/versions`,
    body: (note) => ({ ...draft, note }),
    invalidate: [platformKey("email-templates")],
    success: (d) => `Version ${d.versions[0]?.version} is live`,
    errorToast: false,
    onSuccess: (d) => {
      const next = contentOf(d.current);
      live.current = d.activeVersionId;
      setBase(next);
      setDraft(next);
      setPublishing(false);
    },
  });
  const test = useApiMutation<SendResult, void>({
    path: `/admin/email/templates/${t.key}/test`,
    body: () => (dirty ? { draft } : {}),
    invalidate: [platformKey("email-log")],
    onSuccess: (r) => setTestResult(r),
  });

  const variables = useMemo(() => t.variables, [t.variables]);

  return (
    <>
      <PageHeader
        back={{ href: "/email/templates", label: "Email templates" }}
        icon={<PlatformTile of="email" />}
        title={t.label}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="mute" quiet>
              {CATEGORY_LABEL[t.category] ?? t.category}
            </Badge>
            {t.customised ? (
              <Badge tone="live" quiet>
                Customised · v{t.versions.find((v) => v.active)?.version}
              </Badge>
            ) : (
              <Badge tone="mute" quiet>
                Default
              </Badge>
            )}
            {dirty && (
              <Badge tone="warn" dot>
                Unpublished changes
              </Badge>
            )}
          </span>
        }
        actions={
          canChange && (
            <>
              {dirty && (
                <Button variant="ghost" onClick={() => setDraft(base)}>
                  Discard
                </Button>
              )}
              <Button icon={<Send />} loading={test.isPending} onClick={() => test.mutate()}>
                {dirty ? "Send test of draft" : "Send test"}
              </Button>
              <Button variant="primary" icon={<Upload />} disabled={!dirty} onClick={() => setPublishing(true)}>
                Publish
              </Button>
            </>
          )
        }
      />
      {!canChange && (
        <Callout tone="info" className="mb-4">
          Platform support can view and preview templates; an admin or owner edits them.
        </Callout>
      )}
      <TokenScope>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <Card>
              <CardHeader title="Message" description="Variables are filled when the email is sent; sample values are used in the preview." />
              <CardBody className="flex flex-col gap-3">
                <Field label="Subject" required>
                  <TokenInput value={draft.subject} onChange={(subject) => setDraft({ ...draft, subject })} maxLength={300} disabled={!canChange} />
                </Field>
                <Field label="Preheader" hint="The grey line inbox lists show after the subject. Optional.">
                  <TokenInput value={draft.preheader} onChange={(preheader) => setDraft({ ...draft, preheader })} maxLength={300} disabled={!canChange} />
                </Field>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-text-2">Insert a variable at the cursor</span>
                  <VariablePicker variables={variables} required={t.required} disabled={!canChange} />
                  {t.required.length > 0 && (
                    <span className="text-2xs text-text-3">
                      Highlighted variables are required: {t.required.map((r) => `{{${r}}}`).join(", ")} must appear somewhere in the email.
                    </span>
                  )}
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Content" description="Blocks render top to bottom. The footer (product name and support address) is added automatically." />
              <CardBody>
                <BlockEditor blocks={draft.blocks} onChange={(blocks) => setDraft({ ...draft, blocks })} hasActionUrl={hasActionUrl} disabled={!canChange} />
              </CardBody>
            </Card>
          </div>
          <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
            <Preview preview={preview} mode={mode} setMode={setMode} />
          </div>
        </div>
      </TokenScope>
      <div className="mt-4">
        <Versions
          t={t}
          canChange={canChange}
          onLoad={(c, what) => {
            if (dirty && !window.confirm(`Replace your unpublished changes with ${what}?`)) return;
            setDraft(contentOf(c));
          }}
        />
      </div>
      <PublishDialog
        open={publishing}
        onOpenChange={(v) => {
          setPublishing(v);
          if (!v) publish.reset();
        }}
        onPublish={(note) => publish.mutate(note)}
        pending={publish.isPending}
        error={publish.error?.message ?? null}
        problems={problems}
      />
      <Modal open={testResult !== null} onOpenChange={(v) => !v && setTestResult(null)} title="Test email" footer={<Button onClick={() => setTestResult(null)}>Close</Button>}>
        {testResult && <SendResultView r={testResult} />}
      </Modal>
    </>
  );
}

export function TemplateEditor() {
  const { key } = useParams<{ key: string }>();
  const detail = useApiQuery<TemplateDetail>(platformKey("email-templates", key), `/admin/email/templates/${key}`);
  return (
    <Page>
      <QueryState query={detail} loading={<SkeletonText lines={12} />}>
        {(t) => <Editor key={t.key} t={t} />}
      </QueryState>
    </Page>
  );
}
