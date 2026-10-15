import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy } from "@nestjs/common";
import type { Response } from "express";
import { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../config/config.js";

/*
 * Live updates over Server-Sent Events, fanned out through Redis pub/sub so an
 * event published by any process (an API instance, or the worker filing an
 * inbound email) reaches every API instance holding a stream.
 *
 * Topics:
 *   ws:<workspaceId>     the inbox — "something changed in this conversation"
 *   visitor:<visitorId>  a website live-chat visitor — new messages, agent typing
 *
 * Events are hints, not the record: the inbox refetches what changed, and the
 * widget refetches its thread after a reconnect. Losing one (Redis down, a
 * dropped stream) costs latency, never data — the clients still poll slowly.
 *
 * Publishing never throws: a send must not fail because Redis blinked.
 */

export type RealtimeEvent = { type: string; [key: string]: unknown };
type Listener = (event: RealtimeEvent) => void;

/** A comment line every 25 s keeps proxies (and Next's /api hop) from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly log = new Logger("realtime");
  private readonly prefix: string;
  private pub: Redis | null = null;
  private sub: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.prefix = `${config.NODE_ENV === "test" ? "gd-test" : "gd"}:rt:`;
  }

  private connection() {
    const r = new Redis(this.config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1, connectTimeout: 2000 });
    r.on("error", () => undefined);
    return r;
  }

  async publish(topic: string, event: RealtimeEvent): Promise<void> {
    try {
      this.pub ??= this.connection();
      await this.pub.publish(this.prefix + topic, JSON.stringify(event));
    } catch (e) {
      this.log.warn(`could not publish ${event.type} to ${topic}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** "Conversation changed" for everyone watching the workspace's inbox. */
  conversationChanged(workspaceId: string, conversationId: string, reason: string) {
    return this.publish(`ws:${workspaceId}`, { type: "conversation", conversationId, reason });
  }

  private subscriber(): Redis {
    if (this.sub) return this.sub;
    const sub = this.connection();
    sub.on("message", (channel: string, raw: string) => {
      const topic = channel.slice(this.prefix.length);
      const set = this.listeners.get(topic);
      if (!set?.size) return;
      let event: RealtimeEvent;
      try {
        event = JSON.parse(raw) as RealtimeEvent;
      } catch {
        return;
      }
      for (const fn of set) fn(event);
    });
    this.sub = sub;
    return sub;
  }

  subscribe(topic: string, fn: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
      this.subscriber()
        .subscribe(this.prefix + topic)
        .catch((e) => this.log.warn(`could not subscribe to ${topic}: ${e instanceof Error ? e.message : String(e)}`));
    }
    set.add(fn);
    return () => {
      const s = this.listeners.get(topic);
      if (!s) return;
      s.delete(fn);
      if (!s.size) {
        this.listeners.delete(topic);
        this.sub?.unsubscribe(this.prefix + topic).catch(() => undefined);
      }
    };
  }

  /**
   * Turns an Express response into an SSE stream of the given topics until the
   * client goes away. `filter` may drop or reshape events per connection.
   */
  stream(res: Response, topics: string[], opts: { filter?: (e: RealtimeEvent) => RealtimeEvent | null; headers?: Record<string, string> } = {}) {
    res.status(200);
    res.set({
      "content-type": "text/event-stream; charset=utf-8",
      // no-transform: compression middleware (Next's included) must not buffer the stream.
      "cache-control": "no-cache, no-store, no-transform",
      connection: "keep-alive",
      // nginx / Traefik: do not buffer.
      "x-accel-buffering": "no",
      ...opts.headers,
    });
    res.flushHeaders();
    const write = (chunk: string) => {
      if (!res.writableEnded) res.write(chunk);
    };
    write(`retry: 3000\n: connected\n\n`);
    const send = (e: RealtimeEvent) => {
      const out = opts.filter ? opts.filter(e) : e;
      if (out) write(`event: ${out.type}\ndata: ${JSON.stringify(out)}\n\n`);
    };
    const offs = topics.map((t) => this.subscribe(t, send));
    const beat = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);
    const close = () => {
      clearInterval(beat);
      for (const off of offs) off();
    };
    res.on("close", close);
    res.on("error", close);
  }

  async onModuleDestroy() {
    for (const r of [this.pub, this.sub]) {
      if (r) await r.quit().catch(() => r.disconnect());
    }
  }
}

@Global()
@Module({ providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
