"use client";

import Link from "next/link";
import { Checkbox } from "@/components/ui/Checkbox";

/**
 * The required "I agree" tick on every form that creates an account. The API
 * refuses the sign-up without it (`acceptTerms`) and stores the time and the
 * published version on the user.
 */
export function TermsConsent({ checked, onCheckedChange, error }: { checked: boolean; onCheckedChange: (v: boolean) => void; error?: string }) {
  const link = "font-medium text-accent-hi hover:underline";
  return (
    <div className="flex flex-col gap-1">
      <Checkbox
        checked={checked}
        onCheckedChange={onCheckedChange}
        label={
          <>
            I agree to the{" "}
            <Link href="/terms" target="_blank" className={link}>
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" target="_blank" className={link}>
              Privacy Policy
            </Link>
          </>
        }
      />
      {error && <p className="pl-6 text-xs text-bad">{error}</p>}
    </div>
  );
}
