"use client";

/*
 * The CSV import wizard: choose a file → map its columns → start. The file
 * is read in the browser and sent as text; the API parses it (preview), then
 * stores the rows and processes them on a worker, so the person lands on the
 * import's own page to watch it run.
 */

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowLeft, Check, ChevronRight, Columns3, FileSpreadsheet, FileUp, PenLine, Play, Rows3, Settings2, SkipForward, X } from "lucide-react";
import { IMPORT_FIELDS } from "@growthdesk/shared";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Field, FormError } from "@/components/ui/Field";
import { Input, NativeSelect } from "@/components/ui/Input";
import { EntityTile } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { formatBytes, formatNumber } from "@/lib/format";
import { useApiMutation, useApiQuery } from "@/lib/query";
import { useWorkspace } from "@/lib/session";
import type { CustomFieldDefinition, TagRow } from "@/lib/types/crm-settings";
import { IMPORT_MAX_CSV_CHARS, IMPORT_MAX_ROWS, type ImportPreview, type ImportStartResult } from "@/lib/types/imports";
import { IMPORT_FIELD_HINTS, IMPORT_FIELD_LABELS, IMPORT_IDENTITY_FIELDS, importFieldLabel } from "./labels";
import { Table, Td, Th } from "./Table";

type Loaded = { fileName: string; size: number; csv: string; preview: ImportPreview };

type StartBody = {
  fileName: string;
  csv: string;
  mapping: Record<string, string>;
  tags: string[];
  onDuplicate: "update" | "skip";
  leadSource?: string;
  defaultCountry?: string;
};

const STEPS = ["Choose a file", "Map columns", "Import"] as const;
/** IMPORT_MAX_CSV_CHARS as people read it (formatBytes would say 14 MB, being binary). */
const LIMIT_LABEL = "15 MB";

function Steps({ current }: { current: 0 | 1 }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center gap-1.5" aria-current={active ? "step" : undefined}>
            {i > 0 && <ChevronRight aria-hidden className="mr-0.5 size-3.5 text-text-3 opacity-60" />}
            <span
              aria-hidden
              className={cn(
                "flex size-4.5 items-center justify-center rounded-full text-2xs font-semibold tabular-nums",
                done ? "bg-ok text-white" : active ? "bg-solid text-on-solid" : "border border-line-strong text-text-3",
              )}
            >
              {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
            </span>
            <span className={active ? "font-medium text-text" : "text-text-3"}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function ImportWizard() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  return loaded ? <MapStep loaded={loaded} onBack={() => setLoaded(null)} /> : <FileStep onLoaded={setLoaded} />;
}

// ─── Step 1: the file ───────────────────────────────────────────────────────

function FileStep({ onLoaded }: { onLoaded: (l: Loaded) => void }) {
  const ws = useWorkspace();
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const preview = useApiMutation<ImportPreview, { csv: string }>({ path: ws.path("/imports/preview"), errorToast: false });

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setLocalError(null);
    preview.reset();
    const limit = LIMIT_LABEL;
    if (file.size === 0) return setLocalError("That file is empty.");
    if (file.size > IMPORT_MAX_CSV_CHARS) return setLocalError(`That file is ${(file.size / 1_000_000).toFixed(1)} MB; the limit is ${limit}. Split it and import the parts.`);
    setReading(file.name);
    let csv: string;
    try {
      csv = await file.text();
    } catch {
      setReading(null);
      return setLocalError("The browser could not read that file.");
    }
    if (csv.length > IMPORT_MAX_CSV_CHARS) {
      setReading(null);
      return setLocalError(`That file is too large; the limit is ${limit}. Split it and import the parts.`);
    }
    preview.mutate(
      { csv },
      {
        onSuccess: (p) => onLoaded({ fileName: file.name, size: file.size, csv, preview: p }),
        onSettled: () => setReading(null),
      },
    );
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void choose(e.dataTransfer.files?.[0]);
  };

  const busy = reading !== null || preview.isPending;
  const error = localError ?? (preview.isError ? preview.error.message : null);

  return (
    <Card>
      <CardHeader icon={<FileUp />} title="Import contacts from CSV" actions={<Steps current={0} />} />
      <CardBody className="flex flex-col gap-3">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-12 text-center transition-colors",
            dragging ? "border-accent bg-tint-pick" : "border-line-strong bg-s-1 hover:bg-hover focus-within:border-accent",
            busy && "pointer-events-none opacity-70",
          )}
        >
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              e.target.value = ""; // so choosing the same file again still fires
            }}
          />
          {busy ? (
            <>
              <Spinner size="lg" />
              <span className="text-sm text-text">Reading {reading ?? "file"}…</span>
            </>
          ) : (
            <>
              <EntityTile of="imports" size="xl" className="mb-1" />
              <span className="text-sm font-medium text-text">Drop a CSV file here, or click to choose one</span>
              <span className="text-xs text-text-3">
                The first row must hold the column names. Up to {LIMIT_LABEL} and {formatNumber(IMPORT_MAX_ROWS)} rows.
              </span>
            </>
          )}
        </label>
        <FormError error={error} />
      </CardBody>
    </Card>
  );
}

// ─── Step 2: mapping and options ────────────────────────────────────────────

function MapStep({ loaded, onBack }: { loaded: Loaded; onBack: () => void }) {
  const ws = useWorkspace();
  const router = useRouter();
  const { preview } = loaded;
  const canRead = ws.can("contacts.read");

  const customFields = useApiQuery<CustomFieldDefinition[]>(ws.key("custom-fields"), canRead ? ws.path("/custom-fields") : null, {
    query: { entity: "contact" },
  });
  const tagList = useApiQuery<TagRow[]>(ws.key("tags"), canRead ? ws.path("/tags") : null);
  const custom = customFields.data ?? [];
  const customLabels = useMemo(() => Object.fromEntries(custom.map((c) => [c.key, c.label])), [custom]);

  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.fromEntries(preview.headers.map((h) => [h, preview.suggested[h] ?? ""])),
  );
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [onDuplicate, setOnDuplicate] = useState<"update" | "skip">("update");
  const [leadSource, setLeadSource] = useState("");
  const [defaultCountry, setDefaultCountry] = useState("");

  const start = useApiMutation<ImportStartResult, StartBody>({
    path: ws.path("/imports"),
    invalidate: [ws.key("imports")],
    success: (d) => `Import started: ${formatNumber(d.totalRows)} rows`,
    errorToast: false,
    onSuccess: (d) => router.push(ws.href(`/imports/${d.id}`)),
  });

  // Which column each destination is taken by, so a destination is used once (a second column would overwrite the first).
  const takenBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const [h, t] of Object.entries(mapping)) if (t) m.set(t, h);
    return m;
  }, [mapping]);

  const targets = Object.values(mapping).filter(Boolean);
  const hasIdentity = targets.some((t) => (IMPORT_IDENTITY_FIELDS as readonly string[]).includes(t));
  const mappedCount = targets.length;
  const tooMany = preview.totalRows > IMPORT_MAX_ROWS;
  const noRows = preview.totalRows === 0;
  const countryInvalid = defaultCountry.trim() !== "" && !/^[A-Za-z]{2}$/.test(defaultCountry.trim());
  const workspaceCountry = typeof ws.settings.defaultCountry === "string" && /^[A-Z]{2}$/.test(ws.settings.defaultCountry) ? ws.settings.defaultCountry : null;

  const addTags = (raw: string) => {
    const next = raw
      .split(/[,;]/)
      .map((t) => t.trim().slice(0, 50))
      .filter(Boolean);
    if (!next.length) return;
    setTags((cur) => [...new Set([...cur, ...next])].slice(0, 20));
    setTagDraft("");
  };
  const onTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTags(tagDraft);
    } else if (e.key === "Backspace" && !tagDraft && tags.length) {
      setTags((cur) => cur.slice(0, -1));
    }
  };

  const fields = start.error?.fields ?? {};
  const tagsError = fields.tags ?? Object.entries(fields).find(([k]) => k.startsWith("tags."))?.[1];
  const shownFieldError = Boolean(fields.leadSource || fields.defaultCountry || tagsError);
  const blocked = !hasIdentity || tooMany || noRows || countryInvalid;

  const submit = () => {
    if (blocked) return;
    const pending = tagDraft.trim() ? [...new Set([...tags, ...tagDraft.split(/[,;]/).map((t) => t.trim().slice(0, 50)).filter(Boolean)])].slice(0, 20) : tags;
    start.mutate({
      fileName: loaded.fileName.slice(0, 200),
      csv: loaded.csv,
      mapping,
      tags: pending,
      onDuplicate,
      leadSource: leadSource.trim() || undefined,
      defaultCountry: defaultCountry.trim() ? defaultCountry.trim().toUpperCase() : undefined,
    });
  };

  const samplesFor = (h: string) =>
    preview.sample
      .map((r) => r[h])
      .filter(Boolean)
      .slice(0, 3);

  const dupId = useId();

  return (
    <Card>
      <CardHeader
        icon={<FileSpreadsheet />}
        title={<span className="block truncate">{loaded.fileName}</span>}
        description={`${formatBytes(loaded.size)} · ${formatNumber(preview.totalRows)} ${preview.totalRows === 1 ? "row" : "rows"} · ${mappedCount} of ${preview.headers.length} columns mapped`}
        actions={<Steps current={1} />}
      />

      <CardBody className="flex flex-col gap-6">
        {tooMany && (
          <Callout tone="bad" title="Too many rows for one import">
            This file has {formatNumber(preview.totalRows)} rows; one import can hold up to {formatNumber(IMPORT_MAX_ROWS)}. Split the file and import the parts.
          </Callout>
        )}
        {noRows && (
          <Callout tone="bad" title="No contacts in this file">
            The file has a header row but no rows under it.
          </Callout>
        )}

        {/* Column mapping */}
        <section className="flex flex-col gap-2">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-hi">
              <Columns3 aria-hidden className="size-4 text-text-3" />
              Columns
            </h3>
            <p className="mt-0.5 text-xs text-text-3">
              Choose where each column goes. Columns set to &ldquo;Don&rsquo;t import&rdquo; are ignored. Map at least an email, a phone or a name.
            </p>
          </div>
          <div className="overflow-hidden rounded-md border border-line">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(200px,1fr)] gap-4 border-b border-line bg-s-2 px-3 py-2 text-xs font-medium text-text-3 sm:grid">
              <span>Column in file</span>
              <span>Sample values</span>
              <span>Import as</span>
            </div>
            <ul className="divide-y divide-line">
              {preview.headers.map((h) => {
                const samples = samplesFor(h);
                const target = mapping[h] ?? "";
                const hint = target && !target.startsWith("custom.") ? IMPORT_FIELD_HINTS[target as keyof typeof IMPORT_FIELD_HINTS] : undefined;
                return (
                  <li key={h} className="grid grid-cols-1 gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(200px,1fr)] sm:items-center sm:gap-4">
                    <span className="truncate text-sm font-medium text-text" title={h}>
                      {h}
                    </span>
                    <span className="truncate text-xs text-text-3" title={samples.join(" · ")}>
                      {samples.length ? samples.join(" · ") : "No values in the sample"}
                    </span>
                    <div className="min-w-0">
                      <NativeSelect
                        size="sm"
                        aria-label={`Import "${h}" as`}
                        value={target}
                        onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}
                        placeholder="Don't import"
                      >
                        <optgroup label="Contact fields">
                          {IMPORT_FIELDS.map((f) => {
                            const other = takenBy.get(f);
                            return (
                              <option key={f} value={f} disabled={Boolean(other && other !== h)}>
                                {IMPORT_FIELD_LABELS[f]}
                                {other && other !== h ? ` (from “${other}”)` : ""}
                              </option>
                            );
                          })}
                        </optgroup>
                        {custom.length > 0 && (
                          <optgroup label="Custom fields">
                            {custom.map((c) => {
                              const value = `custom.${c.key}`;
                              const other = takenBy.get(value);
                              return (
                                <option key={c.id} value={value} disabled={Boolean(other && other !== h)}>
                                  {c.label}
                                  {other && other !== h ? ` (from “${other}”)` : ""}
                                </option>
                              );
                            })}
                          </optgroup>
                        )}
                      </NativeSelect>
                      {hint && <p className="mt-1 text-2xs text-text-3">{hint}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          {!hasIdentity && (
            <Callout tone="warn">Map at least one of Email, Phone, Full name, First name or Last name — a contact needs one of them.</Callout>
          )}
        </section>

        {/* Sample rows, as they will be read */}
        {preview.sample.length > 0 && (
          <section className="flex flex-col gap-2">
            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-hi">
                <Rows3 aria-hidden className="size-4 text-text-3" />
                Sample rows
              </h3>
              <p className="mt-0.5 text-xs text-text-3">
                The first {preview.sample.length} of {formatNumber(preview.totalRows)} rows, with the field each column goes to.
              </p>
            </div>
            <div className="rounded-md border border-line">
              <Table>
                <thead>
                  <tr>
                    {preview.headers.map((h) => (
                      <Th key={h} className={cn("align-bottom", !mapping[h] && "opacity-50")}>
                        <span className="block text-text">{h}</span>
                        <span className={cn("block font-normal", mapping[h] ? "text-accent-ink" : "text-text-3")}>{importFieldLabel(mapping[h] ?? "", customLabels)}</span>
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((row, i) => (
                    <tr key={i}>
                      {preview.headers.map((h) => (
                        <Td key={h} className={cn("max-w-56 truncate text-xs", mapping[h] ? "text-text" : "text-text-3")} title={row[h]}>
                          {row[h] || <span className="text-text-3">—</span>}
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </section>
        )}

        {/* Options */}
        <section className="flex flex-col gap-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-hi">
            <Settings2 aria-hidden className="size-4 text-text-3" />
            Options
          </h3>

          <fieldset className="flex flex-col gap-2" aria-describedby={`${dupId}-hint`}>
            <legend className="mb-1.5 text-xs font-medium text-text-2">When a contact already exists</legend>
            <p id={`${dupId}-hint`} className="-mt-1 mb-0.5 text-xs text-text-3">
              Rows are matched to existing contacts by email address, then by phone number.
            </p>
            {(
              [
                {
                  value: "update",
                  label: "Fill in blanks",
                  icon: PenLine,
                  description: "Add values to fields that are empty on the existing contact. Values already there are never overwritten.",
                },
                { value: "skip", label: "Leave it alone", icon: SkipForward, description: "Skip the row and keep the existing contact exactly as it is." },
              ] as const
            ).map((o) => (
              <label
                key={o.value}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
                  onDuplicate === o.value ? "border-accent bg-tint-pick" : "border-line hover:bg-hover",
                )}
              >
                <input
                  type="radio"
                  name={`${dupId}-dup`}
                  value={o.value}
                  checked={onDuplicate === o.value}
                  onChange={() => setOnDuplicate(o.value)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span>
                  <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                    <o.icon aria-hidden className="size-3.5 text-text-3" />
                    {o.label}
                  </span>
                  <span className="block text-xs text-text-3">{o.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <Field
            label="Tag every imported contact"
            hint={`Press Enter or comma to add. Up to 20 tags; new ones are created. ${tags.length}/20`}
            error={tagsError}
          >
            <div className="flex flex-col gap-2">
              {tags.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Tags to add">
                  {tags.map((t) => (
                    <li key={t} className="inline-flex h-6 items-center gap-1 rounded-xs bg-mute-chip pr-0.5 pl-2 text-xs text-text">
                      {t}
                      <IconButton size="sm" className="!size-5" label={`Remove ${t}`} icon={<X />} onClick={() => setTags((cur) => cur.filter((x) => x !== t))} />
                    </li>
                  ))}
                </ul>
              )}
              <Input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={onTagKey}
                onBlur={() => addTags(tagDraft)}
                placeholder={tags.length >= 20 ? "Tag limit reached" : "e.g. webinar-oct"}
                disabled={tags.length >= 20}
                maxLength={50}
                list={tagList.data?.length ? `${dupId}-tags` : undefined}
              />
              {tagList.data && tagList.data.length > 0 && (
                <datalist id={`${dupId}-tags`}>
                  {tagList.data.map((t) => (
                    <option key={t.id} value={t.name} />
                  ))}
                </datalist>
              )}
            </div>
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Lead source" hint="Set on contacts whose row has no lead source of its own." error={fields.leadSource}>
              <Input value={leadSource} onChange={(e) => setLeadSource(e.target.value)} maxLength={100} placeholder="e.g. Trade show 2026" />
            </Field>
            <Field
              label="Country for phone numbers"
              hint={
                workspaceCountry
                  ? `Two-letter code used to read numbers without a +country prefix. Leave blank to use the workspace default (${workspaceCountry}).`
                  : "Two-letter code (e.g. US, GB) used to read numbers without a +country prefix."
              }
              error={countryInvalid ? "Use a two-letter country code, like US or GB." : fields.defaultCountry}
            >
              <Input
                value={defaultCountry}
                onChange={(e) => setDefaultCountry(e.target.value.toUpperCase())}
                maxLength={2}
                placeholder={workspaceCountry ?? "US"}
                className="uppercase"
                autoComplete="off"
              />
            </Field>
          </div>
        </section>

        {start.isError && !shownFieldError && <FormError error={start.error.message} />}
      </CardBody>

      <CardFooter className="justify-between">
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack} disabled={start.isPending}>
          Choose another file
        </Button>
        <Button variant="primary" icon={<Play />} loading={start.isPending} disabled={blocked} onClick={submit}>
          Start import
        </Button>
      </CardFooter>
    </Card>
  );
}
