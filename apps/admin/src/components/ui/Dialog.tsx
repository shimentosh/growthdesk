"use client";

import { AlertDialog, Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { messageOf } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { Input } from "./Input";

/*
 * Modal dialogs (Radix): focus is trapped and returned, Escape and a click on
 * the scrim close, the page behind does not scroll. The body scrolls; the
 * header and footer stay put.
 *
 *   <Modal open={open} onOpenChange={setOpen} title="New tag"
 *          footer={<><Button onClick={…}>Cancel</Button><Button variant="primary" type="submit" form="tag-form">Create</Button></>}>
 *     <form id="tag-form" onSubmit={…}>…</form>
 *   </Modal>
 */

const SIZES = { sm: "max-w-[420px]", md: "max-w-[520px]", lg: "max-w-[680px]", xl: "max-w-[880px]" } as const;

export type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** A tile before the title, e.g. <EntityTile of="meetings" size="md" />. */
  icon?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /** Optional trigger element (otherwise control `open` yourself). */
  trigger?: ReactNode;
  /** Keep it open on an outside click (forms with unsaved input). Escape still closes. */
  dismissOnOutside?: boolean;
  className?: string;
  children?: ReactNode;
};

export function Modal({ open, onOpenChange, title, icon, description, footer, size = "md", trigger, dismissOnOutside = true, className, children }: ModalProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <D.Trigger asChild>{trigger}</D.Trigger>}
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim px-3 py-[6vh] backdrop-blur-[2px] animate-fade-in">
          <D.Content
            // Without a description, say so explicitly (Radix warns otherwise).
            {...(description ? {} : { "aria-describedby": undefined })}
            onPointerDownOutside={(e) => {
              if (!dismissOnOutside) e.preventDefault();
            }}
            className={cn(
              "relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-xl border border-line-strong bg-popover shadow-sheet animate-pop-in",
              SIZES[size],
              className,
            )}
          >
            <div className="flex shrink-0 items-start gap-3 border-b border-line bg-s-2 px-5 py-3.5">
              {icon && <div className="shrink-0">{icon}</div>}
              <div className="min-w-0 flex-1">
                <D.Title className="text-base font-semibold tracking-[-0.01em] text-text-hi">{title}</D.Title>
                {description && <D.Description className="mt-0.5 text-xs text-text-3">{description}</D.Description>}
              </div>
              <D.Close aria-label="Close" className="-mr-1.5 rounded-sm p-1 text-text-3 hover:bg-hover hover:text-text">
                <X aria-hidden className="size-4" />
              </D.Close>
            </div>
            {children !== undefined && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>}
            {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-well px-5 py-3">{footer}</div>}
          </D.Content>
        </D.Overlay>
      </D.Portal>
    </D.Root>
  );
}

/** The raw Radix primitives, for the rare dialog Modal cannot express. */
export const DialogPrimitive = D;

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Default "Delete" for danger, "Confirm" otherwise. */
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  /**
   * Runs on confirm. While its promise is pending the button spins; when it
   * resolves the dialog closes; when it rejects the dialog stays open and
   * shows the error.
   */
  onConfirm: () => unknown | Promise<unknown>;
  /** Require typing this text (e.g. the workspace name) before confirming. */
  confirmText?: string;
  children?: ReactNode;
};

/** "Are you sure?" — for anything destructive or hard to undo. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  onConfirm,
  confirmText,
  children,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  const change = (next: boolean) => {
    if (pending) return;
    if (!next) {
      setTyped("");
      setError(null);
    }
    onOpenChange(next);
  };

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setTyped("");
      onOpenChange(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(false);
    }
  };

  const blocked = confirmText !== undefined && typed.trim() !== confirmText;

  return (
    <AlertDialog.Root open={open} onOpenChange={change}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim px-3 py-[12vh] backdrop-blur-[2px] animate-fade-in">
          <AlertDialog.Content className="relative w-full max-w-[440px] overflow-hidden rounded-xl border border-line-strong bg-popover shadow-sheet animate-pop-in">
            <div className="px-5 pt-4 pb-3">
              <AlertDialog.Title className="text-base font-semibold text-text-hi">{title}</AlertDialog.Title>
              {description ? (
                <AlertDialog.Description className="mt-1.5 text-sm text-text-2">{description}</AlertDialog.Description>
              ) : (
                <AlertDialog.Description className="sr-only">Confirm or cancel this action.</AlertDialog.Description>
              )}
              {children && <div className="mt-3">{children}</div>}
              {confirmText !== undefined && (
                <label className="mt-3 block text-xs text-text-2">
                  Type <span className="font-semibold text-text">{confirmText}</span> to confirm
                  <Input className="mt-1.5" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
                </label>
              )}
              {error && (
                <p role="alert" className="mt-3 text-xs text-bad-ink">
                  {error}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-line bg-well px-5 py-3">
              <AlertDialog.Cancel asChild>
                <Button disabled={pending}>{cancelLabel}</Button>
              </AlertDialog.Cancel>
              {/* Not AlertDialog.Action: that closes immediately, before the work is done. */}
              <Button variant={tone === "danger" ? "danger" : "primary"} loading={pending} disabled={blocked} onClick={confirm}>
                {confirmLabel ?? (tone === "danger" ? "Delete" : "Confirm")}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Overlay>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
