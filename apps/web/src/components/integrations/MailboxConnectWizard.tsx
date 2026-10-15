"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ExternalLink, Eye, EyeOff, LogIn, Plug, Search } from "lucide-react";
import type { z } from "zod";
import { MAIL_PROVIDERS, MAIL_PROVIDER_ORDER, type MailDetection, type MailProviderId, type MailSecurityT, type SmtpMailboxInput } from "@growthdesk/shared";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { EntityTile } from "@/components/ui/icons";
import { Input, NativeSelect } from "@/components/ui/Input";
import { ApiError, get } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useApiMutation } from "@/lib/query";
import { useMe, useWorkspace, workspaceDetailKey } from "@/lib/session";
import type { Mailbox } from "@/lib/types/integrations";
import { DnsReport } from "./DnsReport";
import { useOAuthStart } from "./MailboxConnect";

type SmtpMailboxInputT = z.input<typeof SmtpMailboxInput>;

/** GET /mailboxes/detect: the provider behind an address, its servers, and which sign-in routes are configured. */
type Detected = MailDetection & { email: string; domain: string; mx: string[]; oauth: { gmail: boolean; microsoft: boolean } };

type Step = "address" | "signin" | "domain";
const STEPS: { id: Step; label: string }[] = [
  { id: "address", label: "Address" },
  { id: "signin", label: "Sign in" },
  { id: "domain", label: "Domain records" },
];

const SECURITY: { value: MailSecurityT; label: string }[] = [
  { value: "starttls", label: "STARTTLS" },
  { value: "ssl", label: "SSL / TLS" },
  { value: "none", label: "None (unencrypted)" },
];
const SMTP_PORT: Record<MailSecurityT, number> = { ssl: 465, starttls: 587, none: 25 };
const IMAP_PORT: Record<MailSecurityT, number> = { ssl: 993, starttls: 143, none: 143 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CAPS = [25, 40, 60];

type Servers = {
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: MailSecurityT;
  username: string;
  imapEnabled: boolean;
  imapHost: string;
  imapPort: string;
  imapSecurity: MailSecurityT;
};

const serversFrom = (d: Pick<MailDetection, "smtp" | "imap">, email: string): Servers => ({
  smtpHost: d.smtp.host,
  smtpPort: String(d.smtp.port),
  smtpSecurity: d.smtp.security,
  username: email,
  imapEnabled: true,
  imapHost: d.imap.host,
  imapPort: String(d.imap.port),
  imapSecurity: d.imap.security,
});

/**
 * Connect a sending mailbox without knowing your mail servers: type the
 * address, we recognise the provider (by domain, else by MX) and fill in the
 * servers, show how to get the password it accepts, then sign in to both
 * servers before saving (POST /mailboxes/smtp). Google and Microsoft offer
 * signing in instead when the installation has their OAuth client. The last
 * step reads the domain's SPF/DKIM/DMARC/MX and says what to publish — it
 * never blocks: the mailbox is already connected by then.
 */
export function MailboxConnectWizard({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const me = useMe();
  const oauth = useOAuthStart();
  const [step, setStep] = useState<Step>("address");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [providerId, setProviderId] = useState<MailProviderId>("smtp");
  const [servers, setServers] = useState<Servers>(() => serversFrom(MAIL_PROVIDERS.smtp, ""));
  const [showServers, setShowServers] = useState(false);
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [cap, setCap] = useState("40");
  const [connected, setConnected] = useState<Mailbox | null>(null);

  const provider = MAIL_PROVIDERS[providerId];
  const oauthReady = provider.oauth ? Boolean(detected?.oauth[provider.oauth]) : false;
  const isPlatformAdmin = me.data?.user.platformRole === "owner" || me.data?.user.platformRole === "admin";
  const setServer = <K extends keyof Servers>(k: K, v: Servers[K]) => setServers((s) => ({ ...s, [k]: v }));

  const connect = useApiMutation<Mailbox, SmtpMailboxInputT>({
    path: ws.path("/mailboxes/smtp"),
    invalidate: [ws.key("mailboxes"), ws.key("campaigns"), workspaceDetailKey(ws.id)],
    success: (box) => `${box.email} connected`,
    errorToast: false,
    onSuccess: (box) => {
      setConnected(box);
      setSecret("");
      setStep("domain");
    },
  });

  const reset = () => {
    setStep("address");
    setEmail("");
    setEmailError(null);
    setDetected(null);
    setProviderId("smtp");
    setServers(serversFrom(MAIL_PROVIDERS.smtp, ""));
    setShowServers(false);
    setSecret("");
    setReveal(false);
    setDisplayName("");
    setCap("40");
    setConnected(null);
    connect.reset();
  };
  const close = (next: boolean) => {
    if (!next) {
      if (connect.isPending) return;
      reset();
    }
    onOpenChange(next);
  };

  const lookUp = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    if (!EMAIL_RE.test(address)) {
      setEmailError("Enter the full address, e.g. you@yourcompany.com");
      return;
    }
    setDetecting(true);
    setEmailError(null);
    try {
      const d = await get<Detected>(ws.path(`/mailboxes/detect?email=${encodeURIComponent(address)}`));
      setDetected(d);
      setProviderId(d.provider);
      setServers(serversFrom(d, address));
      setShowServers(d.provider === "smtp");
      connect.reset();
      setStep("signin");
    } catch (err) {
      setEmailError(err instanceof ApiError ? err.message : "The address could not be looked up. Try again.");
    } finally {
      setDetecting(false);
    }
  };

  const pickProvider = (id: MailProviderId) => {
    setProviderId(id);
    // The detected servers stay when the person picks the provider we found (Zoho's region, say).
    const source = detected && detected.provider === id ? detected : MAIL_PROVIDERS[id];
    setServers((s) => ({ ...serversFrom(source, email.trim().toLowerCase()), username: s.username }));
    setShowServers(id === "smtp");
    connect.reset();
  };

  const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));
  // Google and Yahoo show app passwords in groups of four; the spaces are not part of it.
  const cleanSecret = provider.secretLength ? secret.replace(/\s+/g, "") : secret;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    connect.mutate({
      email: address,
      displayName: displayName.trim() || undefined,
      smtpHost: servers.smtpHost.trim(),
      smtpPort: num(servers.smtpPort),
      smtpSecurity: servers.smtpSecurity,
      smtpUser: servers.username.trim() || address,
      password: cleanSecret,
      imapEnabled: servers.imapEnabled,
      ...(servers.imapEnabled ? { imapHost: servers.imapHost.trim(), imapPort: num(servers.imapPort), imapSecurity: servers.imapSecurity } : {}),
      dailyLimit: num(cap),
    });
  };

  const fields = connect.error?.fields ?? {};
  const probe = fields.smtp || fields.imap ? connect.error?.message : null;
  const formError = connect.error && !connect.error.isPlanLimit && (probe || !Object.keys(fields).length) ? connect.error.message : null;
  // A server field the API rejected is inside the collapsed section: open it so the error shows.
  const serverError = Boolean(fields.smtpHost || fields.smtpPort || fields.smtpUser || fields.imapHost || fields.imapPort);
  const capNumber = num(cap);

  let body: ReactNode;
  let footer: ReactNode;

  if (step === "address") {
    body = (
      <form id="mailbox-address" onSubmit={lookUp} noValidate className="flex flex-col gap-4">
        <Field label="Email address to send from" required error={emailError} hint="We look up who hosts it and fill in the server settings for you.">
          <Input
            type="email"
            autoFocus
            autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(null);
            }}
            placeholder="you@yourcompany.com"
          />
        </Field>
        <p className="text-xs text-text-3">Gmail, Google Workspace, Microsoft 365, Zoho, Yahoo, iCloud, Fastmail, GoDaddy, Titan, Hostinger and Namecheap are recognised; any other provider works with its server names.</p>
      </form>
    );
    footer = (
      <>
        <Button onClick={() => close(false)}>Cancel</Button>
        <Button variant="primary" type="submit" form="mailbox-address" icon={<Search />} loading={detecting}>
          {detecting ? "Looking it up…" : "Continue"}
        </Button>
      </>
    );
  } else if (step === "signin") {
    const domain = detected?.domain ?? "";
    const found =
      detected?.via === "domain"
        ? `${domain} is ${provider.name}.`
        : detected?.via === "mx" && detected.provider === providerId
          ? `${domain}'s mail servers are at ${provider.name}.`
          : detected?.via === "none" && providerId === "smtp"
            ? `We could not tell who hosts ${domain} — pick the provider, or enter its servers below.`
            : null;
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-md border border-line bg-well px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-text-hi">{email.trim().toLowerCase()}</div>
            {found && <div className="mt-0.5 text-xs text-text-3">{found}</div>}
          </div>
          <NativeSelect
            size="sm"
            aria-label="Provider"
            className="w-full sm:w-60"
            value={providerId}
            onChange={(e) => pickProvider(e.target.value as MailProviderId)}
            options={MAIL_PROVIDER_ORDER.map((id) => ({ value: id, label: MAIL_PROVIDERS[id].name }))}
          />
        </div>

        {detected?.forwarder && providerId === "smtp" && (
          <Callout tone="warn" title={`${domain} only forwards mail (${detected.forwarder})`}>
            There is no mailbox at {detected.forwarder} to send from. Connect the mailbox your mail is forwarded to — for example Gmail with “Send mail as” set up for{" "}
            {email.trim().toLowerCase()}: pick Gmail above, then put that Gmail address as the username under Server settings.
          </Callout>
        )}

        {provider.oauth && oauthReady && (
          <div className="flex flex-col gap-2 rounded-md border border-accent/30 bg-tint-pick px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm">
              <div className="font-medium text-text-hi">Recommended: sign in with {provider.oauth === "gmail" ? "Google" : "Microsoft"}</div>
              <div className="text-xs text-text-2">No password to create — you approve access on {provider.oauth === "gmail" ? "Google" : "Microsoft"}&apos;s own page.</div>
            </div>
            <Button variant="primary" icon={<LogIn />} loading={oauth.pending === provider.oauth} onClick={() => provider.oauth && void oauth.start(provider.oauth)}>
              Sign in with {provider.oauth === "gmail" ? "Google" : "Microsoft"}
            </Button>
          </div>
        )}

        <form id="mailbox-signin" onSubmit={submit} noValidate className="flex flex-col gap-4">
          <FormError error={formError} />

          {provider.oauth && oauthReady && <div className="text-xs font-medium text-text-3 uppercase">Or use {provider.secretLabel.toLowerCase()}</div>}

          <div className="rounded-md border border-line px-3.5 py-3">
            <div className="mb-2 text-xs font-semibold text-text-hi">Where do I get the {provider.secretLabel.toLowerCase()}?</div>
            <ol className="flex flex-col gap-2">
              {provider.steps.map((s, i) => (
                <li key={i} className="flex gap-2.5 text-sm text-text-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-s-2 text-2xs font-semibold text-text-hi tabular-nums">{i + 1}</span>
                  <span className="min-w-0">
                    {s.text}
                    {s.href && (
                      <>
                        {" "}
                        <a href={s.href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 font-medium whitespace-nowrap text-accent-hi hover:underline">
                          {s.hrefLabel ?? "Open"}
                          <ExternalLink aria-hidden className="size-3" />
                        </a>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          {provider.note && <Callout tone={provider.note.tone}>{provider.note.text}</Callout>}

          {provider.oauth && !oauthReady && (
            <p className="text-xs text-text-3">
              One-click {provider.oauth === "gmail" ? "Google" : "Microsoft"} sign-in is not set up on this installation, so an app password is the way in.
              {isPlatformAdmin && (
                <>
                  {" "}
                  As a platform admin you can turn it on in the{" "}
                  <a href="/admin" target="_blank" rel="noreferrer" className="text-accent-hi hover:underline">
                    admin console
                  </a>{" "}
                  under Settings → Google and Microsoft sign-in.
                </>
              )}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={provider.secretLabel}
              required
              error={fields.password}
              className="sm:col-span-2"
              hint={provider.secretLength ? `${cleanSecret.length}/${provider.secretLength} characters — spaces are ignored.` : "Sent once and stored encrypted; it can be replaced later but never read back."}
            >
              <div className="relative">
                <Input
                  type={reveal ? "text" : "password"}
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={provider.secretPlaceholder}
                  className="pr-10 font-mono"
                />
                <button
                  type="button"
                  aria-label={reveal ? "Hide" : "Show"}
                  onClick={() => setReveal((r) => !r)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-xs p-1 text-text-3 hover:bg-hover hover:text-text"
                >
                  {reveal ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
                </button>
              </div>
            </Field>
            <Field label="Sender name" hint="Shown as the From name." error={fields.displayName}>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Jane from Acme" />
            </Field>
            <Field
              label="Daily send limit"
              error={fields.dailyLimit}
              hint={capNumber > 60 ? "Cold outreach sits at 20–50 a day per inbox. More than that on a new address gets mailboxes flagged." : "Per day from this mailbox; change it any time."}
            >
              <div className="flex gap-1.5">
                <Input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ""))} className="w-20" />
                {CAPS.map((c) => (
                  <Button key={c} size="sm" variant={capNumber === c ? "primary" : "secondary"} onClick={() => setCap(String(c))} className="h-9">
                    {c}
                  </Button>
                ))}
              </div>
            </Field>
          </div>

          <div className="rounded-md border border-line">
            <button
              type="button"
              aria-expanded={showServers || serverError}
              onClick={() => setShowServers((v) => !v)}
              className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text-hi">Server settings</span>
                <span className="block truncate font-mono text-xs text-text-3">
                  {servers.smtpHost ? `${servers.smtpHost}:${servers.smtpPort}` : "SMTP server not set"}
                  {servers.imapEnabled ? ` · ${servers.imapHost ? `${servers.imapHost}:${servers.imapPort}` : "IMAP server not set"}` : " · reply tracking off"}
                </span>
              </span>
              <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-text-3 transition-transform", (showServers || serverError) && "rotate-180")} />
            </button>
            {(showServers || serverError) && (
              <div className="flex flex-col gap-3 border-t border-line px-3.5 py-3">
                <div className="grid gap-3 sm:grid-cols-6">
                  <Field label="SMTP server" required error={fields.smtpHost} className="sm:col-span-3">
                    <Input value={servers.smtpHost} onChange={(e) => setServer("smtpHost", e.target.value)} placeholder="smtp.yourprovider.com" autoComplete="off" className="font-mono" />
                  </Field>
                  <Field label="Security" error={fields.smtpSecurity} className="sm:col-span-2">
                    <NativeSelect
                      value={servers.smtpSecurity}
                      options={SECURITY}
                      onChange={(e) => {
                        const s = e.target.value as MailSecurityT;
                        setServers((p) => ({ ...p, smtpSecurity: s, smtpPort: Object.values(SMTP_PORT).map(String).includes(p.smtpPort) ? String(SMTP_PORT[s]) : p.smtpPort }));
                      }}
                    />
                  </Field>
                  <Field label="Port" required error={fields.smtpPort} className="sm:col-span-1">
                    <Input inputMode="numeric" value={servers.smtpPort} onChange={(e) => setServer("smtpPort", e.target.value.replace(/\D/g, ""))} />
                  </Field>
                  <Field label="Username" hint="Usually the email address. Sending as an alias? The account you sign in to." error={fields.smtpUser} className="sm:col-span-6">
                    <Input value={servers.username} autoComplete="off" onChange={(e) => setServer("username", e.target.value)} />
                  </Field>
                </div>
                <Checkbox
                  checked={servers.imapEnabled}
                  onCheckedChange={(c) => setServer("imapEnabled", c)}
                  label="Track replies (IMAP)"
                  description="Reads the inbox so replies are filed against contacts and stop their sequences. Uses the same username and password."
                />
                {servers.imapEnabled && (
                  <div className="grid gap-3 sm:grid-cols-6">
                    <Field label="IMAP server" required error={fields.imapHost} className="sm:col-span-3">
                      <Input value={servers.imapHost} onChange={(e) => setServer("imapHost", e.target.value)} placeholder="imap.yourprovider.com" autoComplete="off" className="font-mono" />
                    </Field>
                    <Field label="Security" error={fields.imapSecurity} className="sm:col-span-2">
                      <NativeSelect
                        value={servers.imapSecurity}
                        options={SECURITY}
                        onChange={(e) => {
                          const s = e.target.value as MailSecurityT;
                          setServers((p) => ({ ...p, imapSecurity: s, imapPort: Object.values(IMAP_PORT).map(String).includes(p.imapPort) ? String(IMAP_PORT[s]) : p.imapPort }));
                        }}
                      />
                    </Field>
                    <Field label="Port" error={fields.imapPort} className="sm:col-span-1">
                      <Input inputMode="numeric" value={servers.imapPort} onChange={(e) => setServer("imapPort", e.target.value.replace(/\D/g, ""))} />
                    </Field>
                  </div>
                )}
              </div>
            )}
          </div>
        </form>
      </div>
    );
    footer = (
      <>
        <Button icon={<ArrowLeft />} onClick={() => setStep("address")} disabled={connect.isPending} className="mr-auto">
          Back
        </Button>
        <Button onClick={() => close(false)} disabled={connect.isPending}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" form="mailbox-signin" icon={<Plug />} loading={connect.isPending} disabled={!secret.trim()}>
          {connect.isPending ? "Signing in to the servers…" : "Connect mailbox"}
        </Button>
      </>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <Callout tone="ok" title={`${connected?.email ?? "The mailbox"} is connected`}>
          We signed in to its servers and it can send now. Whether that mail lands in the inbox depends on the records below — publish any that are missing where the domain&apos;s DNS is
          managed (your registrar or host, e.g. Cloudflare, GoDaddy, Namecheap). Nothing here blocks sending.
        </Callout>
        {connected && <DnsReport mailboxId={connected.id} />}
      </div>
    );
    footer = (
      <>
        {connected && (
          <Button href={ws.href(`/settings/mailboxes/${connected.id}`)} icon={<ArrowRight />} onClick={() => close(false)} className="mr-auto">
            Open mailbox
          </Button>
        )}
        <Button variant="primary" icon={<Check />} onClick={() => close(false)}>
          Done
        </Button>
      </>
    );
  }

  const at = STEPS.findIndex((s) => s.id === step);
  return (
    <Modal
      open={open}
      onOpenChange={close}
      size="lg"
      dismissOnOutside={false}
      icon={<EntityTile of="mailboxes" size="md" />}
      title="Connect a mailbox"
      description="The address outreach is sent from. We sign in to it for real before saving."
      footer={footer}
    >
      <ol className="mb-4 flex items-center gap-2 text-xs" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden className="h-px w-6 bg-line" />}
            <span
              aria-current={i === at ? "step" : undefined}
              className={cn("flex items-center gap-1.5", i === at ? "font-medium text-text-hi" : i < at ? "text-ok-ink" : "text-text-3")}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-2xs font-semibold",
                  i === at ? "bg-accent text-on-accent" : i < at ? "bg-ok-chip text-ok-ink" : "bg-s-2 text-text-3",
                )}
              >
                {i < at ? <Check aria-hidden className="size-3" /> : i + 1}
              </span>
              {s.label}
            </span>
          </li>
        ))}
      </ol>
      {body}
    </Modal>
  );
}
