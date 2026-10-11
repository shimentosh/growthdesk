"use client";

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, Check, CircleCheck, ClipboardCheck, LayoutTemplate, Send, SlidersHorizontal, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { EntityTile } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { toast } from "@/components/ui/Toast";
import { CampaignStatusBadge, useMarketing } from "@/components/marketing/common";
import { cn } from "@/lib/cn";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useFormat, useWorkspace } from "@/lib/session";
import type { CampaignReadiness, MarketingCampaign, MarketingCampaignPatch } from "@/lib/types/marketing";
import { CampaignMenu } from "./common";
import {
  SECTIONS,
  SECTION_FIELDS,
  SECTION_LABEL,
  draftOf,
  patchOf,
  problemHome,
  same,
  sectionOfField,
  type Draft,
  type DraftKey,
  type EditableSection,
  type Section,
} from "./editor";
import { AudienceSection } from "./AudienceSection";
import { ContentSection } from "./ContentSection";
import { DetailsSection } from "./DetailsSection";
import { ReviewSection } from "./ReviewSection";
import { TrackingSection } from "./TrackingSection";

const ICON: Record<Section, ComponentType<{ "aria-hidden"?: boolean }>> = {
  details: SlidersHorizontal,
  audience: Users,
  content: LayoutTemplate,
  tracking: Activity,
  review: ClipboardCheck,
};

type SaveVars = { keys: DraftKey[]; sent: Partial<Draft>; body: MarketingCampaignPatch; label: string };

/** What a section gets from the editor. */
export type SectionProps = {
  campaign: MarketingCampaign;
  value: Draft;
  set: <K extends DraftKey>(key: K, v: Draft[K]) => void;
  /** No marketing.write: everything is read-only. */
  disabled: boolean;
  /** Field errors from the last save, keyed like the API's (dotted). */
  errors: Record<string, string>;
};

/**
 * A draft campaign: Details, Audience, Content, Tracking, then Review & send.
 * Each section saves on its own (PATCH with just its fields); the tabs show
 * which have unsaved changes and which still block sending.
 */
export function CampaignEditor({ campaign }: { campaign: MarketingCampaign }) {
  const ws = useWorkspace();
  const mk = useMarketing();
  const f = useFormat();
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const canWrite = ws.can("marketing.write");
  const canSend = ws.can("marketing.send");
  const id = campaign.id;

  const raw = sp.get("tab");
  const tab: Section = (SECTIONS as readonly string[]).includes(raw ?? "") ? (raw as Section) : "details";
  const setTab = (next: string) => {
    const p = new URLSearchParams();
    if (next !== "details") p.set("tab", next);
    router.replace(p.size ? `${pathname}?${p}` : pathname, { scroll: false });
  };

  const saved = useMemo(() => draftOf(campaign), [campaign]);
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const value: Draft = { ...saved, ...edits };
  const set = <K extends DraftKey>(key: K, v: Draft[K]) => {
    setEdits((e) => ({ ...e, [key]: v }));
    if (errors[key] || Object.keys(errors).some((k) => k.startsWith(`${key}.`))) {
      setErrors((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== key && !k.startsWith(`${key}.`))));
    }
  };
  const dirtyKeys = (Object.keys(edits) as DraftKey[]).filter((k) => !same(edits[k], saved[k]));
  const dirtyIn = (s: EditableSection) => SECTION_FIELDS[s].some((k) => dirtyKeys.includes(k));
  const dirtySections = (Object.keys(SECTION_FIELDS) as EditableSection[]).filter(dirtyIn);
  const dirty = dirtyKeys.length > 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const readiness = useApiQuery<CampaignReadiness>(mk.key("campaigns", id, "readiness"), mk.path(`/campaigns/${id}/readiness`));

  /** A fresh campaign from the API: show it, and refresh what depends on it. */
  const accept = (c: MarketingCampaign) => {
    qc.setQueryData(mk.key("campaigns", id), c);
    void qc.invalidateQueries({ queryKey: mk.key("campaigns", "list") });
    void qc.invalidateQueries({ queryKey: mk.key("campaigns", id, "readiness") });
  };

  const save = useApiMutation<MarketingCampaign, SaveVars>({
    method: "PATCH",
    path: mk.path(`/campaigns/${id}`),
    body: (v) => v.body,
    errorToast: false,
    success: (_, v) => `${v.label} saved`,
    onSuccess: (c, v) => {
      accept(c);
      // Drop the overrides that were saved, unless they were edited again while saving.
      setEdits((e) => {
        const next = { ...e };
        for (const k of v.keys) if (same(next[k], v.sent[k])) delete next[k];
        return next;
      });
    },
    onError: (err) => {
      const fields = err.fields ?? {};
      if (Object.keys(fields).length) {
        setErrors(fields);
        const first = Object.keys(fields).map(sectionOfField).find(Boolean);
        toast.error(`Could not save: ${Object.values(fields)[0]}`);
        if (first && first !== tab) setTab(first);
      } else if (!err.isPlanLimit && !err.isAuth) toast.error(err);
    },
  });

  const saveSections = (sections: EditableSection[]) => {
    const keys = sections.flatMap((s) => SECTION_FIELDS[s]).filter((k) => dirtyKeys.includes(k));
    if (!keys.length) return Promise.resolve(campaign);
    setErrors({});
    const sent = Object.fromEntries(keys.map((k) => [k, value[k]])) as Partial<Draft>;
    const label = sections.length === 1 ? SECTION_LABEL[sections[0]!] : "Changes";
    return save.mutateAsync({ keys, sent, body: patchOf(value, keys), label });
  };
  const discard = (s: EditableSection) =>
    setEdits((e) => {
      const next = { ...e };
      for (const k of SECTION_FIELDS[s]) delete next[k];
      return next;
    });

  const applyDesign = useApiMutation<MarketingCampaign, string>({
    method: "PATCH",
    path: mk.path(`/campaigns/${id}`),
    body: (designId) => ({ designId }),
    success: "Design applied",
    onSuccess: (c) => {
      accept(c);
      setEdits(({ blocks: _, ...rest }) => rest);
    },
  });

  // Readiness problems, by the section that fixes them.
  const problems = readiness.data?.problems ?? [];
  const problemsIn = (s: Section) => (s === "review" ? problems.length : problems.filter((p) => problemHome(p) === s).length);

  const props: SectionProps = { campaign, value, set, disabled: !canWrite, errors };

  return (
    <>
      <PageHeader
        back={{ href: mk.href("/campaigns"), label: "Email campaigns" }}
        icon={<EntityTile of="marketingCampaigns" />}
        title={value.name.trim() || campaign.name}
        meta={
          <span className="flex items-center gap-2">
            <CampaignStatusBadge status="draft" />
            {canWrite && <SaveState dirty={dirty} saving={save.isPending} />}
          </span>
        }
        description={`Draft · last saved ${f.relative(campaign.updatedAt)}`}
        actions={
          <>
            {canWrite && dirty && (
              <Button loading={save.isPending} onClick={() => void saveSections(dirtySections).catch(() => undefined)}>
                Save all
              </Button>
            )}
            {canSend && tab !== "review" && (
              <Button variant="primary" icon={<Send />} onClick={() => setTab("review")}>
                Review & send
              </Button>
            )}
            <CampaignMenu campaign={campaign} afterDelete={() => router.push(mk.href("/campaigns"))} />
          </>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(t) => {
          setReveal(false);
          setTab(t);
        }}
      >
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList aria-label="Campaign sections">
            {SECTIONS.map((s, i) => {
              const Icon = ICON[s];
              const unsaved = s !== "review" && dirtyIn(s);
              const open = problemsIn(s);
              return (
                <TabsTrigger key={s} value={s}>
                  <Icon aria-hidden />
                  <span>
                    <span className="mr-1 text-text-3 tabular-nums">{i + 1}.</span>
                    {SECTION_LABEL[s]}
                  </span>
                  {unsaved ? (
                    <span className="size-1.5 rounded-full bg-warn" title="Unsaved changes" aria-label="Unsaved changes" />
                  ) : open > 0 && readiness.data ? (
                    <span className="rounded-xs bg-bad-chip px-1.5 text-2xs text-bad-ink tabular-nums" title={`${open} to fix before sending`}>
                      {open}
                    </span>
                  ) : readiness.data && s !== "tracking" ? (
                    <CircleCheck aria-label="Done" className="text-ok-ink" />
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
        <TabsContent value="details">
          <DetailsSection {...props} />
          <SaveBar section="details" dirty={dirtyIn("details")} saving={save.isPending} onSave={() => void saveSections(["details"]).catch(() => undefined)} onDiscard={() => discard("details")} />
        </TabsContent>
        <TabsContent value="audience">
          <AudienceSection {...props} />
          <SaveBar section="audience" dirty={dirtyIn("audience")} saving={save.isPending} onSave={() => void saveSections(["audience"]).catch(() => undefined)} onDiscard={() => discard("audience")} />
        </TabsContent>
        <TabsContent value="content">
          <ContentSection
            {...props}
            applyDesign={(designId) => applyDesign.mutateAsync(designId)}
            applying={applyDesign.isPending}
            contentDirty={dirtyIn("content")}
            revealProblem={reveal}
          />
          <SaveBar section="content" dirty={dirtyIn("content")} saving={save.isPending} onSave={() => void saveSections(["content"]).catch(() => undefined)} onDiscard={() => discard("content")} />
        </TabsContent>
        <TabsContent value="tracking">
          <TrackingSection {...props} />
          <SaveBar section="tracking" dirty={dirtyIn("tracking")} saving={save.isPending} onSave={() => void saveSections(["tracking"]).catch(() => undefined)} onDiscard={() => discard("tracking")} />
        </TabsContent>
        <TabsContent value="review">
          <ReviewSection
            campaign={campaign}
            readiness={readiness}
            dirtySections={dirtySections}
            saving={save.isPending}
            onSaveAll={() => saveSections(dirtySections)}
            goTo={(s) => {
              setReveal(s === "content");
              setTab(s);
            }}
            onSent={accept}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}

function SaveState({ dirty, saving }: { dirty: boolean; saving: boolean }) {
  if (saving) return <span className="text-xs text-text-3">Saving…</span>;
  if (dirty)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warn-ink">
        <span aria-hidden className="size-1.5 rounded-full bg-warn" />
        Unsaved changes
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs text-text-3">
      <Check aria-hidden className="size-3.5 text-ok-ink" />
      All changes saved
    </span>
  );
}

/** Sticks to the bottom of the window while a section has unsaved changes. */
function SaveBar({ section, dirty, saving, onSave, onDiscard }: { section: EditableSection; dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void }) {
  if (!dirty) return null;
  return (
    <div className="sticky bottom-3 z-10 mt-4 flex justify-center">
      <div
        role="status"
        className={cn("flex items-center gap-3 rounded-xl border border-line-strong bg-popover py-2 pr-2 pl-4 shadow-sheet animate-pop-in")}
      >
        <span className="inline-flex items-center gap-2 text-sm text-text">
          <span aria-hidden className="size-1.5 rounded-full bg-warn" />
          Unsaved changes in {SECTION_LABEL[section]}
        </span>
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button size="sm" variant="primary" loading={saving} onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  );
}
