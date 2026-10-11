"use client";

import { createContext, useContext, useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * A labelled form control with its hint or error.
 *
 *   <Field label="Email" error={errors.email} hint="We never share it.">
 *     <Input type="email" value={email} onChange={…} />
 *   </Field>
 *
 * Field generates the id and passes it — with aria-invalid and
 * aria-describedby — to the Input/Textarea/NativeSelect/Select/Combobox inside
 * through context, so the label, the control and the message are wired for
 * screen readers without any ids written by hand.
 */

type FieldContextValue = { id: string; describedBy?: string; invalid: boolean; required?: boolean };

const FieldContext = createContext<FieldContextValue | null>(null);

/** For custom controls: the id / aria props the surrounding Field wants applied. */
export function useFieldControl(props: { id?: string; invalid?: boolean; "aria-describedby"?: string } = {}) {
  const field = useContext(FieldContext);
  const invalid = props.invalid ?? field?.invalid ?? false;
  return {
    id: props.id ?? field?.id,
    "aria-invalid": invalid || undefined,
    "aria-describedby": [props["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") || undefined,
    "aria-required": field?.required || undefined,
  };
}

export type FieldProps = {
  label?: ReactNode;
  /** Shown under the control, replaced by `error` when there is one. */
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Something to the right of the label, e.g. a "Forgot password?" link. */
  labelAction?: ReactNode;
  /** Use your own id (otherwise one is generated). */
  id?: string;
  className?: string;
  children: ReactNode;
};

export function Field({ label, hint, error, required, labelAction, id, className, children }: FieldProps) {
  const auto = useId();
  const controlId = id ?? `f${auto.replace(/:/g, "")}`;
  const messageId = `${controlId}-msg`;
  const message = error || hint;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {(label || labelAction) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <label htmlFor={controlId} className="text-xs font-medium text-text-2">
              {label}
              {required && (
                <span aria-hidden className="ml-0.5 text-bad">
                  *
                </span>
              )}
            </label>
          )}
          {labelAction}
        </div>
      )}
      <FieldContext.Provider value={{ id: controlId, describedBy: message ? messageId : undefined, invalid: Boolean(error), required }}>
        {children}
      </FieldContext.Provider>
      {message && (
        <p id={messageId} className={cn("text-xs", error ? "text-bad-ink" : "text-text-3")}>
          {message}
        </p>
      )}
    </div>
  );
}

/** A form-level error (the API's message when no single field is to blame). */
export function FormError({ error, className }: { error?: ReactNode; className?: string }) {
  if (!error) return null;
  return (
    <div role="alert" className={cn("rounded-sm border border-bad-edge bg-bad-wash px-3 py-2 text-xs text-bad-ink", className)}>
      {error}
    </div>
  );
}
