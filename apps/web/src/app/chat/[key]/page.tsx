"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";

/*
 * The website live-chat widget, framed by /widget.js on a customer's site.
 *
 * It is a page of this app, so its calls go to our own /api/widget/<key>/...
 * with no cookies and no CORS. The visitor's token is kept by the loader in
 * the host site's own storage (first-party, so Safari does not drop it) and
 * handed in through the URL fragment, which never reaches a server; a new
 * token is posted back up for the loader to keep.
 *
 * Messages to the parent window (all { gd: "lc", ... }):
 *   up:   ready { position } (once the widget may show), resize { open }, token { token }
 *   down: open, close, toggle
 *
 * Styles are self-contained (lc-*) and light: the app's theme does not apply
 * on someone else's website.
 */

type Config = {
  key: string;
  enabled: boolean;
  name: string;
  title: string;
  greeting: string;
  replyTime: string;
  color: string;
  position: "right" | "left";
  preChat: "off" | "optional" | "required";
};
type Msg = { id: string; from: "visitor" | "agent"; body: string; author: string; at: string };
type Visitor = { name: string; email: string };

class WidgetError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function boot() {
  if (typeof window === "undefined") return { host: "", page: "", token: "", preview: false };
  const q = new URLSearchParams(window.location.search);
  const h = new URLSearchParams(window.location.hash.slice(1));
  return { host: q.get("host") ?? "", page: q.get("page") ?? "", token: h.get("t") ?? "", preview: q.get("preview") === "1" };
}

const post = (data: Record<string, unknown>) => {
  if (window.parent !== window) window.parent.postMessage({ gd: "lc", ...data }, "*");
};

export default function ChatWidget() {
  const { key } = useParams<{ key: string }>();
  const env = useMemo(boot, []);
  const [token, setToken] = useState(env.token);
  const [config, setConfig] = useState<Config | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [open, setOpen] = useState(env.preview);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [visitor, setVisitor] = useState<Visitor>({ name: "", email: "" });
  const [unread, setUnread] = useState(0);
  const [started, setStarted] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;

  const call = useCallback(
    async <T,>(path: string, init: { method?: string; body?: unknown } = {}, tok = token): Promise<T> => {
      const res = await fetch(`/api/widget/${encodeURIComponent(key)}${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(tok ? { "x-gd-visitor": tok } : {}),
          ...(env.host ? { "x-gd-host": env.host } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
        credentials: "omit",
      });
      const json = (await res.json().catch(() => null)) as { data?: T; error?: { code: string; message: string } } | null;
      if (!res.ok) throw new WidgetError(res.status, json?.error?.code ?? "error", json?.error?.message ?? "Something went wrong. Please try again.");
      return json?.data as T;
    },
    [key, token, env.host],
  );

  // Config first; a widget that is off or not allowed here shows nothing at all.
  useEffect(() => {
    call<Config>(`/config${env.preview ? "?preview=1" : ""}`)
      .then((c) => {
        setConfig(c);
        post({ type: "ready", position: c.position });
      })
      .catch((e: unknown) => setFatal(e instanceof Error ? e.message : "Unavailable"));
  }, [call, env.preview]);

  // A returning visitor: their thread, so a reply sent while they were away is waiting.
  useEffect(() => {
    if (!config || !token || started || env.preview) return;
    setStarted(true);
    call<{ visitor: Visitor; messages: Msg[] }>("/session", { method: "POST", body: { pageUrl: env.page || undefined } })
      .then((s) => {
        setVisitor(s.visitor);
        setMessages(s.messages);
      })
      .catch((e: unknown) => {
        // The token no longer works (widget recreated, data erased): start fresh next time.
        if (e instanceof WidgetError && e.status === 401) setToken("");
      });
  }, [config, token, started, call, env.page, env.preview]);

  const ensureSession = useCallback(
    async (extra: Partial<Visitor> = {}) => {
      if (token) return token;
      const s = await call<{ token: string | null; visitor: Visitor; messages: Msg[] }>("/session", { method: "POST", body: { pageUrl: env.page || undefined, ...extra } }, "");
      setStarted(true);
      setVisitor(s.visitor);
      setMessages(s.messages);
      if (s.token) {
        setToken(s.token);
        post({ type: "token", token: s.token });
        return s.token;
      }
      return "";
    },
    [token, call, env.page],
  );

  // Live: new messages over SSE while there is a conversation (or the panel is open).
  const hasThread = messages.length > 0;
  useEffect(() => {
    if (!token || env.preview || (!open && !hasThread) || typeof EventSource === "undefined") return;
    const qs = new URLSearchParams({ token, ...(env.host ? { host: env.host } : {}) });
    const es = new EventSource(`/api/widget/${encodeURIComponent(key)}/stream?${qs}`);
    es.addEventListener("message", (e: MessageEvent<string>) => {
      try {
        const { message } = JSON.parse(e.data) as { message: Msg };
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
        if (message.from === "agent" && !openRef.current) setUnread((n) => n + 1);
      } catch {
        // ignore a malformed event
      }
    });
    // After a reconnect, catch up on anything missed.
    es.addEventListener("open", () => {
      call<{ messages: Msg[] }>("/messages")
        .then((r) => setMessages(r.messages))
        .catch(() => undefined);
    });
    return () => es.close();
  }, [token, open, hasThread, key, env.host, env.preview, call]);

  const setPanel = useCallback((next: boolean) => {
    setOpen(next);
    if (next) setUnread(0);
    post({ type: "resize", open: next });
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { gd?: string; type?: string } | null;
      if (!d || d.gd !== "lc" || e.source !== window.parent) return;
      if (d.type === "open") setPanel(true);
      else if (d.type === "close") setPanel(false);
      else if (d.type === "toggle") setPanel(!openRef.current);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [setPanel]);

  if (fatal || !config) return <style>{BASE_CSS}</style>;

  const color = /^#[0-9a-f]{6}$/i.test(config.color) ? config.color : "#2563eb";
  return (
    <div className={`lc-root lc-${config.position}`} style={{ ["--lc" as string]: color }}>
      <style>{BASE_CSS}</style>
      {open && (
        <Panel
          config={config}
          preview={env.preview}
          messages={messages}
          visitor={visitor}
          onClose={env.preview ? undefined : () => setPanel(false)}
          onIdentify={async (v) => {
            const tok = await ensureSession(v);
            if (token && tok) {
              const r = await call<{ visitor: Visitor }>("/visitor", { method: "PATCH", body: v }, tok);
              setVisitor(r.visitor);
            }
          }}
          onSend={async (body) => {
            const tok = await ensureSession();
            const r = await call<{ message: Msg }>("/messages", { method: "POST", body: { body, pageUrl: env.page || undefined } }, tok);
            setMessages((prev) => (prev.some((m) => m.id === r.message.id) ? prev : [...prev, r.message]));
          }}
        />
      )}
      {!env.preview && (
        <button type="button" className="lc-launcher" aria-label={open ? "Close chat" : config.title || "Chat with us"} onClick={() => setPanel(!open)}>
          {open ? <CloseIcon /> : <ChatIcon />}
          {!open && unread > 0 && <span className="lc-badge">{unread > 9 ? "9+" : unread}</span>}
        </button>
      )}
    </div>
  );
}

function Panel({
  config,
  preview,
  messages,
  visitor,
  onClose,
  onIdentify,
  onSend,
}: {
  config: Config;
  preview: boolean;
  messages: Msg[];
  visitor: Visitor;
  onClose?: () => void;
  onIdentify: (v: Visitor) => Promise<void>;
  onSend: (body: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askDismissed, setAskDismissed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const needsDetails = config.preChat === "required" && !visitor.email;
  const askForEmail = config.preChat === "optional" && !visitor.email && !askDismissed && messages.some((m) => m.from === "visitor");

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending || preview) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="lc-panel" aria-label={config.title}>
      <header className="lc-head">
        <div className="lc-head-text">
          <strong>{config.title || "Chat with us"}</strong>
          {config.replyTime && <span>{config.replyTime}</span>}
        </div>
        {onClose && (
          <button type="button" className="lc-icon-btn" aria-label="Close chat" onClick={onClose}>
            <CloseIcon />
          </button>
        )}
      </header>

      {needsDetails ? (
        <DetailsForm
          intro={config.greeting || "Before we start, tell us who you are."}
          required
          disabled={preview}
          onSubmit={async (v) => {
            await onIdentify(v);
          }}
        />
      ) : (
        <>
          <div className="lc-list" ref={listRef} aria-live="polite">
            {config.greeting && (
              <div className="lc-msg lc-agent">
                <div className="lc-bubble">{config.greeting}</div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`lc-msg ${m.from === "agent" ? "lc-agent" : "lc-me"}`}>
                {m.from === "agent" && m.author && <div className="lc-author">{m.author}</div>}
                <div className="lc-bubble">{m.body}</div>
                <time className="lc-time" dateTime={m.at}>
                  {new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </time>
              </div>
            ))}
            {askForEmail && (
              <div className="lc-card">
                <DetailsForm
                  intro="Leave your email so we can reply even if you close this page."
                  disabled={preview}
                  onSkip={() => setAskDismissed(true)}
                  onSubmit={async (v) => {
                    await onIdentify(v);
                  }}
                />
              </div>
            )}
          </div>
          {error && <p className="lc-error">{error}</p>}
          <form className="lc-compose" onSubmit={submit}>
            <textarea
              rows={1}
              value={text}
              maxLength={5000}
              placeholder={preview ? "Preview: messages are not sent" : "Write a message…"}
              disabled={preview}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              aria-label="Message"
            />
            <button type="submit" className="lc-send" aria-label="Send" disabled={!text.trim() || sending || preview}>
              <SendIcon />
            </button>
          </form>
        </>
      )}
      <footer className="lc-foot">{config.name ? `${config.name} · ` : ""}Live chat</footer>
    </section>
  );
}

function DetailsForm({ intro, required, disabled, onSubmit, onSkip }: { intro: string; required?: boolean; disabled?: boolean; onSubmit: (v: Visitor) => Promise<void>; onSkip?: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="lc-details"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || disabled) return;
        setBusy(true);
        setError(null);
        try {
          await onSubmit({ name: name.trim(), email: email.trim() });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Please check your details.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>{intro}</p>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={120} required={required} disabled={disabled} aria-label="Your name" />
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" type="email" maxLength={254} required disabled={disabled} aria-label="Email address" />
      {error && <p className="lc-error">{error}</p>}
      <div className="lc-row">
        {onSkip && (
          <button type="button" className="lc-link" onClick={onSkip}>
            Not now
          </button>
        )}
        <button type="submit" className="lc-primary" disabled={busy || disabled}>
          {required ? "Start chat" : "Save"}
        </button>
      </div>
    </form>
  );
}

const ChatIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20l1.1-4.6A8.4 8.4 0 1 1 21 11.5z" />
  </svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m22 2-7 20-4-9-9-4z" />
    <path d="M22 2 11 13" />
  </svg>
);

const BASE_CSS = `
html, body { background: transparent !important; margin: 0; height: 100%; overflow: hidden; color-scheme: light; }
.lc-root { position: fixed; inset: 0; display: flex; flex-direction: column; justify-content: flex-end; gap: 12px; padding: 0 12px 12px;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; }
.lc-right { align-items: flex-end; } .lc-left { align-items: flex-start; }
.lc-launcher { position: relative; width: 56px; height: 56px; flex: none; border: 0; border-radius: 50%; background: var(--lc); color: #fff;
  display: grid; place-items: center; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.22); transition: transform .15s; }
.lc-launcher:hover { transform: scale(1.05); }
.lc-launcher:focus-visible, .lc-root button:focus-visible, .lc-root input:focus-visible, .lc-root textarea:focus-visible { outline: 2px solid var(--lc); outline-offset: 2px; }
.lc-badge { position: absolute; top: -2px; right: -2px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: #dc2626;
  color: #fff; font-size: 11px; font-weight: 700; display: grid; place-items: center; border: 2px solid #fff; box-sizing: border-box; }
.lc-panel { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; background: #fff; border-radius: 16px; overflow: hidden;
  box-shadow: 0 12px 40px rgba(0,0,0,.18); border: 1px solid rgba(0,0,0,.06); }
.lc-head { display: flex; align-items: center; gap: 8px; padding: 14px 14px 14px 16px; background: var(--lc); color: #fff; }
.lc-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.lc-head-text strong { font-size: 15px; } .lc-head-text span { font-size: 12px; opacity: .85; }
.lc-icon-btn { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 6px; border-radius: 8px; display: grid; place-items: center; }
.lc-icon-btn:hover { background: rgba(255,255,255,.18); }
.lc-list { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; background: #f8fafc; }
.lc-msg { display: flex; flex-direction: column; max-width: 82%; }
.lc-agent { align-self: flex-start; align-items: flex-start; } .lc-me { align-self: flex-end; align-items: flex-end; }
.lc-bubble { padding: 8px 12px; border-radius: 14px; white-space: pre-wrap; word-break: break-word; }
.lc-agent .lc-bubble { background: #fff; border: 1px solid #e5e7eb; border-bottom-left-radius: 4px; }
.lc-me .lc-bubble { background: var(--lc); color: #fff; border-bottom-right-radius: 4px; }
.lc-author { font-size: 11px; color: #6b7280; margin: 0 4px 2px; }
.lc-time { font-size: 10px; color: #9ca3af; margin: 2px 4px 0; }
.lc-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; }
.lc-details { display: flex; flex-direction: column; gap: 8px; padding: 16px; }
.lc-card .lc-details { padding: 0; }
.lc-details p { margin: 0; color: #374151; }
.lc-details input { border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 10px; font: inherit; }
.lc-row { display: flex; justify-content: flex-end; align-items: center; gap: 10px; }
.lc-primary { border: 0; background: var(--lc); color: #fff; font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 8px; cursor: pointer; }
.lc-primary:disabled { opacity: .6; cursor: default; }
.lc-link { border: 0; background: none; color: #6b7280; font: inherit; cursor: pointer; }
.lc-error { margin: 0; padding: 6px 14px; color: #b91c1c; font-size: 12px; }
.lc-compose { display: flex; align-items: flex-end; gap: 8px; padding: 10px; border-top: 1px solid #e5e7eb; background: #fff; }
.lc-compose textarea { flex: 1; resize: none; border: 1px solid #d1d5db; border-radius: 10px; padding: 9px 11px; font: inherit; max-height: 120px; field-sizing: content; }
.lc-send { width: 38px; height: 38px; flex: none; border: 0; border-radius: 10px; background: var(--lc); color: #fff; display: grid; place-items: center; cursor: pointer; }
.lc-send:disabled { opacity: .45; cursor: default; }
.lc-foot { text-align: center; font-size: 11px; color: #9ca3af; padding: 6px; background: #fff; }
`;
