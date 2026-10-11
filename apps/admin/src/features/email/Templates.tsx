"use client";

import Link from "next/link";
import { ChevronRight, FileText } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { QueryState } from "@/components/ui/ErrorState";
import { Page, PageHeader, Section } from "@/components/ui/PageHeader";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useApiQuery } from "@/lib/query";
import { useFormat } from "@/lib/session";
import { PlatformTile, platformKey } from "@/features/common/platform";
import { CATEGORY_LABEL } from "./common";
import type { TemplateListItem } from "./types";

/** /email/templates — the system emails, grouped by what they are about. Each opens in the editor. */
export function Templates() {
  const f = useFormat();
  const list = useApiQuery<TemplateListItem[]>(platformKey("email-templates"), "/admin/email/templates");
  return (
    <Page width="capped">
      <PageHeader
        icon={<PlatformTile of="email" />}
        title="Email templates"
        description="The system emails the platform sends. Edit the wording and layout; every change is a new version you can roll back, and “Reset to default” returns to the built-in text."
      />
      <QueryState query={list} loading={<SkeletonText lines={10} />}>
        {(items) => {
          const groups = Object.keys(CATEGORY_LABEL)
            .map((c) => ({ category: c, items: items.filter((i) => i.category === c) }))
            .filter((g) => g.items.length);
          return (
            <div className="flex flex-col gap-6">
              {groups.map((g) => (
                <Section key={g.category} title={CATEGORY_LABEL[g.category] ?? g.category}>
                  <Card className="divide-y divide-line overflow-hidden">
                    {g.items.map((t) => (
                      <Link key={t.key} href={`/email/templates/${t.key}`} className="group flex items-center gap-3 px-4 py-3 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-s-2 text-text-2 [&_svg]:size-4">
                          <FileText aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-text-hi">{t.label}</span>
                            {t.customised ? (
                              <Badge tone="live" quiet>
                                Customised · v{t.activeVersion?.version}
                              </Badge>
                            ) : (
                              <Badge tone="mute" quiet>
                                Default
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 font-mono text-2xs text-text-3">{t.key}</div>
                        </div>
                        <div className="hidden text-right text-xs text-text-3 sm:block">
                          {t.updatedAt ? <div title={f.dateTime(t.updatedAt)}>Updated {f.relative(t.updatedAt)}</div> : <div>Never edited</div>}
                          {t.versionCount > 0 && (
                            <div>
                              {t.versionCount} version{t.versionCount === 1 ? "" : "s"}
                            </div>
                          )}
                        </div>
                        <ChevronRight aria-hidden className="size-4 shrink-0 text-text-3 transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    ))}
                  </Card>
                </Section>
              ))}
            </div>
          );
        }}
      </QueryState>
    </Page>
  );
}
