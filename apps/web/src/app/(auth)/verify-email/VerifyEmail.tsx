"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { AuthCard } from "@/components/account/AuthFrame";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { messageOf, post } from "@/lib/api";

type State = { kind: "working" } | { kind: "done" } | { kind: "failed"; message: string };

export function VerifyEmail({ token }: { token: string }) {
  const [state, setState] = useState<State>(token ? { kind: "working" } : { kind: "failed", message: "This link is missing its token." });
  // Strict mode runs effects twice in dev; a token can only be used once.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    post("/auth/verify-email", { token }, { noAuthRedirect: true })
      .then(() => setState({ kind: "done" }))
      .catch((e) => setState({ kind: "failed", message: messageOf(e) }));
  }, [token]);

  return (
    <AuthCard title="Confirm your email">
      {state.kind === "working" && (
        <p className="flex items-center justify-center gap-2 text-sm text-text-2">
          <LoaderCircle aria-hidden className="size-4 animate-spin text-text-3" />
          Checking your link…
        </p>
      )}
      {state.kind === "done" && <Callout tone="ok" title="Email confirmed">You can set up your workspace now.</Callout>}
      {state.kind === "failed" && <Callout tone="bad">{state.message}</Callout>}
      {state.kind !== "working" && (
        <Button href="/" variant="primary" className="w-full">
          Continue
        </Button>
      )}
    </AuthCard>
  );
}
