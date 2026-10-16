"use client";

import { useRef, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { focusAt, spliceToken } from "@/components/templates/VariableMenu";
import { Button, IconButton } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Input";
import { AgentVariableMenu } from "./AgentVariableMenu";

/*
 * The pieces of the agent editor's script: a text box with its own "Insert
 * variable" menu, and the two list editors (qualifying questions, objection
 * handling). Field errors come from the API keyed by path ("questions.2",
 * "objections.0.response"), so each row looks its own up in `errors`.
 */

export type Objection = { objection: string; response: string };

/** A labelled textarea whose "Insert variable" menu drops the token at the caret. */
export function ScriptText({
  label,
  value,
  onChange,
  error,
  hint,
  required,
  rows = 3,
  maxLength,
  placeholder,
  readOnly,
  className,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const next = spliceToken(ref.current, value, token);
    onChange(next.value);
    focusAt(ref.current, next.caret);
  };
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className} labelAction={readOnly ? undefined : <AgentVariableMenu onPick={insert} />}>
      <Textarea ref={ref} rows={rows} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** Move item `i` by `by` (−1 up, +1 down). */
function moved<T>(list: T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j] as T, next[i] as T];
  return next;
}

function RowActions({ index, count, readOnly, onMove, onRemove, noun }: { index: number; count: number; readOnly?: boolean; onMove: (by: -1 | 1) => void; onRemove: () => void; noun: string }) {
  if (readOnly) return null;
  return (
    <div className="flex shrink-0 items-center">
      <IconButton size="sm" label={`Move ${noun} up`} icon={<ArrowUp />} disabled={index === 0} onClick={() => onMove(-1)} />
      <IconButton size="sm" label={`Move ${noun} down`} icon={<ArrowDown />} disabled={index === count - 1} onClick={() => onMove(1)} />
      <IconButton size="sm" variant="danger" label={`Remove ${noun}`} icon={<Trash2 />} onClick={onRemove} />
    </div>
  );
}

/** Qualifying questions the agent works in, in order. */
export function QuestionsEditor({
  value,
  onChange,
  errors,
  max = 10,
  readOnly,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  errors: Record<string, string>;
  max?: number;
  readOnly?: boolean;
}) {
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const last = useRef(0);
  const set = (i: number, text: string) => onChange(value.map((q, k) => (k === i ? text : q)));
  const insert = (token: string) => {
    const i = Math.min(last.current, value.length - 1);
    if (i < 0) return;
    const el = refs.current[i] ?? null;
    const next = spliceToken(el, value[i] ?? "", token);
    set(i, next.value);
    focusAt(el, next.caret);
  };
  const add = () => {
    onChange([...value, ""]);
    last.current = value.length;
    requestAnimationFrame(() => refs.current[value.length]?.focus());
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-2">Questions to ask</span>
        {!readOnly && value.length > 0 && <AgentVariableMenu onPick={insert} />}
      </div>
      {value.length === 0 && <p className="text-xs text-text-3">No questions. The agent follows the goal above without qualifying the person.</p>}
      <ol className="flex flex-col gap-2">
        {value.map((q, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-1.5 w-5 shrink-0 text-right text-xs text-text-3 tabular-nums">{i + 1}.</span>
            <Field error={errors[`questions.${i}`]} className="flex-1">
              <Textarea
                ref={(el) => {
                  refs.current[i] = el;
                }}
                rows={1}
                value={q}
                maxLength={300}
                aria-label={`Question ${i + 1}`}
                className="min-h-8"
                onFocus={() => (last.current = i)}
                onChange={(e) => set(i, e.target.value)}
                placeholder="What are you using for this right now?"
              />
            </Field>
            <RowActions index={i} count={value.length} readOnly={readOnly} noun="question" onMove={(by) => onChange(moved(value, i, by))} onRemove={() => onChange(value.filter((_, k) => k !== i))} />
          </li>
        ))}
      </ol>
      {errors.questions && <p className="text-xs text-bad-ink">{errors.questions}</p>}
      {!readOnly && (
        <div className="flex items-center gap-2">
          <Button size="sm" icon={<Plus />} onClick={add} disabled={value.length >= max}>
            Add question
          </Button>
          <span className="text-xs text-text-3">
            {value.length} of {max}
          </span>
        </div>
      )}
    </div>
  );
}

/** What the person might say, and how the agent answers. */
export function ObjectionsEditor({
  value,
  onChange,
  errors,
  max = 15,
  readOnly,
}: {
  value: Objection[];
  onChange: (next: Objection[]) => void;
  errors: Record<string, string>;
  max?: number;
  readOnly?: boolean;
}) {
  const refs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const last = useRef<{ i: number; part: keyof Objection }>({ i: 0, part: "response" });
  const set = (i: number, part: keyof Objection, text: string) => onChange(value.map((o, k) => (k === i ? { ...o, [part]: text } : o)));
  const insert = (token: string) => {
    const { part } = last.current;
    const i = Math.min(last.current.i, value.length - 1);
    if (i < 0) return;
    const el = refs.current[`${i}.${part}`] ?? null;
    const next = spliceToken(el, value[i]?.[part] ?? "", token);
    set(i, part, next.value);
    focusAt(el, next.caret);
  };
  const add = () => {
    onChange([...value, { objection: "", response: "" }]);
    last.current = { i: value.length, part: "objection" };
    requestAnimationFrame(() => refs.current[`${value.length}.objection`]?.focus());
  };
  const bind = (i: number, part: keyof Objection) => ({
    ref: (el: HTMLTextAreaElement | null) => {
      refs.current[`${i}.${part}`] = el;
    },
    onFocus: () => (last.current = { i, part }),
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-text-2">If they say…</span>
        {!readOnly && value.length > 0 && <AgentVariableMenu onPick={insert} />}
      </div>
      {value.length === 0 && <p className="text-xs text-text-3">No prepared answers. The agent answers objections from the facts in About.</p>}
      <ul className="flex flex-col gap-2">
        {value.map((o, i) => (
          <li key={i} className="flex items-start gap-2 rounded-md border border-line bg-s-2 p-2.5">
            <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <Field label="They say" error={errors[`objections.${i}.objection`]}>
                <Textarea {...bind(i, "objection")} rows={2} value={o.objection} maxLength={300} onChange={(e) => set(i, "objection", e.target.value)} placeholder="I'm busy right now" />
              </Field>
              <Field label="The agent" error={errors[`objections.${i}.response`]}>
                <Textarea
                  {...bind(i, "response")}
                  rows={2}
                  value={o.response}
                  maxLength={800}
                  onChange={(e) => set(i, "response", e.target.value)}
                  placeholder="Ask when would suit them better, note it, and end the call."
                />
              </Field>
            </div>
            <RowActions index={i} count={value.length} readOnly={readOnly} noun="answer" onMove={(by) => onChange(moved(value, i, by))} onRemove={() => onChange(value.filter((_, k) => k !== i))} />
          </li>
        ))}
      </ul>
      {errors.objections && <p className="text-xs text-bad-ink">{errors.objections}</p>}
      {!readOnly && (
        <div className="flex items-center gap-2">
          <Button size="sm" icon={<Plus />} onClick={add} disabled={value.length >= max}>
            Add an answer
          </Button>
          <span className="text-xs text-text-3">
            {value.length} of {max}
          </span>
        </div>
      )}
    </div>
  );
}
