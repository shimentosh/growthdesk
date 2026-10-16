import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard, AuthFrame } from "@/components/account/AuthFrame";
import { Callout } from "@/components/ui/Callout";
import { serverGet } from "@/lib/server-api";
import type { McpOAuthConsent } from "@/lib/types/mcp";
import { ConsentForm } from "./ConsentForm";

export const metadata: Metadata = { title: "Connect an app" };

/** What the API's GET /oauth/authorize sends here as ?error= when it cannot hand an error back to the app. */
const ERRORS: Record<string, string> = {
  invalid_client: "This app isn't registered with Growthdesk (or its registration was removed). Remove the connector in your app and add it again.",
  invalid_redirect_uri: "This app asked to return to an address it didn't register, so the request was stopped. Remove the connector in your app and add it again.",
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

function Problem({ message }: { message: string }) {
  return (
    <AuthCard title="Can't connect this app">
      <Callout tone="bad">{message}</Callout>
      <p className="text-center text-xs text-text-3">
        <Link href="/" className="font-medium text-accent-hi hover:underline">
          Go to Growthdesk
        </Link>
      </p>
    </AuthCard>
  );
}

/*
 * OAuth consent for MCP clients (claude.ai "Add custom connector", Claude Code,
 * Claude Desktop): the API's GET /oauth/authorize validated the app's request
 * and sent the browser here with it signed in ?request=. Signed out → sign in
 * and come back. The person picks the workspace and access level; the decision
 * is a session-authenticated POST (apps/api/src/mcp/oauth), which answers
 * with the app's redirect URI — a code, or access_denied.
 */
export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = one(params.error);
  const request = one(params.request);
  if (error || !request) {
    return (
      <AuthFrame width="md">
        <Problem message={ERRORS[error] ?? "This link is incomplete. Start connecting again from your app."} />
      </AuthFrame>
    );
  }

  const info = await serverGet<McpOAuthConsent>(`/mcp/oauth/consent?request=${encodeURIComponent(request)}`);
  if (!info.ok && info.status === 401) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/consent?request=${encodeURIComponent(request)}`)}`);
  }
  return (
    <AuthFrame width="md">{info.ok ? <ConsentForm request={request} info={info.data} /> : <Problem message={info.message} />}</AuthFrame>
  );
}
