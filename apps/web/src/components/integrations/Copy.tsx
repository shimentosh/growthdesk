"use client";

import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";

/** Writes to the clipboard and says so; a refused clipboard (http, permissions) is an error toast, not a silent no-op. */
export async function copyText(value: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(what);
    return true;
  } catch {
    toast.error("The browser did not allow copying. Select the text and copy it by hand.");
    return false;
  }
}

/** A small copy mark for a value shown elsewhere. */
export function CopyButton({ value, label = "Copy", copied = "Copied", size = "sm" }: { value: string; label?: string; copied?: string; size?: "sm" | "md" }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      size={size}
      label={label}
      icon={done ? <Check /> : <Copy />}
      onClick={async () => {
        if (await copyText(value, copied)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    />
  );
}

/**
 * A read-only value in monospace with a copy mark — URLs, DNS records,
 * tokens. Long values wrap rather than scroll, so the whole thing is visible
 * on a phone.
 */
export function CopyValue({ value, label, copied, className, children }: { value: string; label?: string; copied?: string; className?: string; children?: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 items-start gap-1 rounded-sm border border-line bg-well py-1 pr-1 pl-2.5", className)}>
      <code className="min-w-0 flex-1 py-1 font-mono text-xs break-all text-text">{children ?? value}</code>
      <CopyButton value={value} label={label ?? "Copy"} copied={copied} />
    </div>
  );
}
