"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CircleDot, ExternalLink, Globe, RotateCcw, Save, Send, Undo2 } from "lucide-react";
import { SITE_CONTENT_SCHEMAS, type SiteContentKey, type SiteContentMap } from "@growthdesk/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { IconTile } from "@/components/ui/IconTile";
import { toast } from "@/components/ui/Toast";
import { api, type ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { platformKey, usePlatform } from "@/features/common/platform";

/*
 * The draft → publish editor behind every Website page.
 *
 *   const ed = useSiteEditor("landing");
 *   ed.value            the content being edited (local edits over the saved draft)
 *   ed.update(d => …)   change it (mutate the clone you are handed)
 *   ed.errors           client-side validation by dotted path (the shared Zod schema)
 *   <DraftBar editors={[ed]} … />   save / publish / discard for one or more keys
 *
 * Three layers: unsaved local edits → the saved draft (PUT) → the published
 * copy the customer site serves (POST …/publish). The API is the source of
 * truth; it validates again and checks every asset id.
 */

export type Person = { id: string; name: string; email: string };

/** GET /admin/site/:key */
export type SiteRow<K extends SiteContentKey> = {
  key: K;
  draft: SiteContentMap[K];
  published: SiteContentMap[K];
  publishedAt: string | null;
  publishedBy: Person | null;
  updatedAt: string | null;
  isDefault: boolean;
  hasUnpublishedChanges: boolean;
};

/** GET /admin/site/assets */
export type SiteAsset = { id: string; kind: "logo" | "favicon" | "og"; mime: string; size: number; sha256: string; createdAt: string; createdById: string | null; url: string };

export const siteKey = (key: SiteContentKey) => platformKey("site", key);
export const SITE_ASSETS_KEY = platformKey("site", "assets");

const clone = <T,>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function errorsOf(key: SiteContentKey, value: unknown): Record<string, string> {
  const res = SITE_CONTENT_SCHEMAS[key].safeParse(value);
  if (res.success) return {};
  const out: Record<string, string> = {};
  for (const issue of res.error.issues) out[issue.path.join(".") || "_"] ??= issue.message;
  return out;
}

export type SiteEditor<K extends SiteContentKey> = ReturnType<typeof useSiteEditor<K>>;

export function useSiteEditor<K extends SiteContentKey>(key: K) {
  const qc = useQueryClient();
  const query = useApiQuery<SiteRow<K>>(siteKey(key), `/admin/site/${key}`);
  const [local, setLocal] = useState<SiteContentMap[K] | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | "save" | "publish" | "discard">(null);

  const row = query.data;
  const value = (local ?? row?.draft) as SiteContentMap[K] | undefined;
  const dirty = Boolean(row && local && !same(local, row.draft));
  const clientErrors = useMemo(() => (value ? errorsOf(key, value) : {}), [key, value]);
  const errors = { ...serverErrors, ...clientErrors };
  const valid = Object.keys(clientErrors).length === 0;

  const accept = (next: SiteRow<K>) => {
    qc.setQueryData(siteKey(key), next);
    void qc.invalidateQueries({ queryKey: platformKey("site"), exact: true });
    setLocal(null);
    setServerErrors({});
  };

  const run = async <T,>(kind: "save" | "publish" | "discard", fn: () => Promise<T>) => {
    setBusy(kind);
    try {
      return await fn();
    } catch (e) {
      const err = e as ApiError;
      setServerErrors(err.fields ?? {});
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      const next = await api<SiteRow<K>>(`/admin/site/${key}`, { method: "PUT", body: value });
      accept(next);
      return next;
    });

  return {
    key,
    query,
    row,
    value,
    dirty,
    errors,
    valid,
    busy,
    /** Change the content: mutate the clone you are handed. */
    update(fn: (draft: SiteContentMap[K]) => void) {
      if (!value) return;
      const next = clone(value);
      fn(next);
      setLocal(next);
    },
    /** Drop unsaved local edits. */
    revert: () => {
      setLocal(null);
      setServerErrors({});
    },
    save,
    /** Saves pending edits first, then publishes the draft. */
    publish: () =>
      run("publish", async () => {
        if (dirty) {
          const saved = await api<SiteRow<K>>(`/admin/site/${key}`, { method: "PUT", body: value });
          accept(saved);
        }
        const next = await api<SiteRow<K>>(`/admin/site/${key}/publish`, { method: "POST" });
        accept(next);
        return next;
      }),
    discard: () =>
      run("discard", async () => {
        const next = await api<SiteRow<K>>(`/admin/site/${key}/discard`, { method: "POST" });
        accept(next);
        return next;
      }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = SiteEditor<any>;

/** Warns before leaving the page with unsaved edits. */
function useLeaveGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}

/**
 * The sticky bar on top of every Website page: where the content stands
 * (unsaved / draft / live), when it was last published and by whom, and the
 * actions. With several editors (SEO + analytics) it acts on all of them.
 */
export function DraftBar({ editors, appUrl, livePath = "/", label }: { editors: AnyEditor[]; appUrl: string | null; livePath?: string; label?: string }) {
  const { canChange } = usePlatform();
  const f = useFormat();
  const [confirm, setConfirm] = useState<null | "publish" | "discard">(null);
  const loaded = editors.every((e) => e.row);
  const dirty = editors.some((e) => e.dirty);
  const unpublished = editors.some((e) => e.row?.hasUnpublishedChanges);
  const valid = editors.every((e) => e.valid);
  const busy = editors.find((e) => e.busy)?.busy ?? null;
  useLeaveGuard(dirty);

  const latest = editors
    .map((e) => e.row)
    .filter((r): r is NonNullable<typeof r> => Boolean(r?.publishedAt))
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))[0];
  const allDefault = editors.every((e) => e.row?.isDefault);

  const status = dirty
    ? { tone: "warn" as const, text: "Unsaved changes" }
    : unpublished
      ? { tone: "info" as const, text: "Draft not published" }
      : allDefault
        ? { tone: "mute" as const, text: "Built-in defaults" }
        : { tone: "ok" as const, text: "Live" };

  const saveAll = async () => {
    try {
      for (const e of editors) if (e.dirty) await e.save();
      toast.success("Draft saved");
    } catch (err) {
      toast.error(err as Error);
    }
  };

  return (
    <div className="sticky top-0 z-20 -mx-4 mb-5 border-b border-line bg-bg/90 px-4 py-2.5 backdrop-blur-md nav:-mx-6 nav:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Badge tone={status.tone} dot>
            {status.text}
          </Badge>
          {label && <span className="hidden text-xs font-medium text-text-2 sm:inline">{label}</span>}
          <span className="truncate text-xs text-text-3">
            {!loaded
              ? "Loading…"
              : latest
                ? `Last published ${f.relative(latest.publishedAt)}${latest.publishedBy ? ` by ${latest.publishedBy.name || latest.publishedBy.email}` : ""}`
                : "Never published — the site shows the built-in defaults"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {appUrl && (
            <Button size="sm" variant="ghost" icon={<ExternalLink />} href={`${appUrl}${livePath}`} external>
              View live
            </Button>
          )}
          {canChange && (
            <>
              {dirty ? (
                <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => editors.forEach((e) => e.revert())} disabled={Boolean(busy)}>
                  Revert edits
                </Button>
              ) : (
                <Button size="sm" variant="ghost" icon={<RotateCcw />} disabled={!unpublished || Boolean(busy)} onClick={() => setConfirm("discard")}>
                  Discard draft
                </Button>
              )}
              <Button size="sm" icon={<Save />} disabled={!dirty || !valid} loading={busy === "save"} onClick={() => void saveAll()}>
                Save draft
              </Button>
              <Button size="sm" variant="primary" icon={<Send />} disabled={(!dirty && !unpublished) || !valid || Boolean(busy && busy !== "publish")} loading={busy === "publish"} onClick={() => setConfirm("publish")}>
                Publish
              </Button>
            </>
          )}
        </div>
      </div>
      {!valid && dirty && <p className="mt-1.5 text-xs text-bad-ink">Fix the highlighted fields to save.</p>}

      <ConfirmDialog
        open={confirm === "publish"}
        onOpenChange={(v) => !v && setConfirm(null)}
        tone="default"
        title="Publish to the live site?"
        description={`${dirty ? "Your edits are saved and the" : "The"} draft replaces what visitors see now. The customer site picks it up within about a minute.`}
        confirmLabel="Publish"
        onConfirm={async () => {
          for (const e of editors) if (e.dirty || e.row?.hasUnpublishedChanges) await e.publish();
          toast.success("Published");
        }}
      />
      <ConfirmDialog
        open={confirm === "discard"}
        onOpenChange={(v) => !v && setConfirm(null)}
        title="Discard the draft?"
        description="The saved draft goes back to what is live now (or to the built-in defaults, if nothing was ever published). This cannot be undone."
        confirmLabel="Discard draft"
        onConfirm={async () => {
          for (const e of editors) if (e.row?.hasUnpublishedChanges) await e.discard();
          toast.success("Draft discarded");
        }}
      />
    </div>
  );
}

/** The Website section's page tile. */
export function WebsiteTile({ icon = <Globe />, size = "lg" }: { icon?: ReactNode; size?: "sm" | "md" | "lg" }) {
  return <IconTile icon={icon} tint="purple" size={size} />;
}

/** A small "Changed" marker next to a section that differs from the live copy. */
export function ChangedDot({ changed, className }: { changed: boolean; className?: string }) {
  if (!changed) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-2xs font-semibold text-warn-ink", className)}>
      <CircleDot className="size-3" /> Not live
    </span>
  );
}

export function ReadOnlyNote() {
  const { canChange } = usePlatform();
  if (canChange) return null;
  return <p className="mb-4 rounded-md border border-line bg-well px-3 py-2 text-xs text-text-2">Platform support can view the website content; an admin or owner edits and publishes it.</p>;
}

export { same as sameJson };
