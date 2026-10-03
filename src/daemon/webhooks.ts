/**
 * Webhook delivery for applications built on cm. Events are JSON POSTs, HMAC-signed when a secret is set,
 * retried three times with backoff. Delivery never blocks the proxy: everything here is fire-and-forget.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { Config } from "../core/config.js";
import type { EventBus } from "../core/events.js";
import type { CmEvent } from "../core/types.js";

export type WebhookName =
  | "limit.reset"
  | "limit.approaching"
  | "limit.exhausted"
  | "limit.recovered"
  | "pool.dry"
  | "routing.switch"
  | "routing.fallback"
  | "model.fallback"
  | "account.needs_login"
  | "freereset.recommended"
  | "freereset.used"
  | "ping";

const RETRY_MS = [1000, 5000, 25000];

/** Map an internal event to a webhook name + payload, or null when it is not for applications. */
export function toWebhook(ev: CmEvent): { event: WebhookName; data: Record<string, unknown> } | null {
  switch (ev.type) {
    case "limit": {
      const { type: _t, at: _a, kind, ...rest } = ev as any;
      return { event: `limit.${kind}` as WebhookName, data: rest };
    }
    case "all_exhausted":
      return ev.cause === "limits"
        ? { event: "pool.dry", data: { earliestResetAt: ev.earliestResetAt ? new Date(ev.earliestResetAt).toISOString() : null } }
        : null;
    case "switch":
      return { event: "routing.switch", data: { session: ev.session ?? null, from: ev.from, to: ev.to, reason: ev.reason } };
    case "fallback":
      return { event: "routing.fallback", data: { reason: ev.reason } };
    case "free_reset":
      return { event: ev.kind === "used" ? "freereset.used" : "freereset.recommended", data: { account: ev.account, detail: ev.detail } };
    case "model_fallback":
      return { event: "model.fallback", data: { session: ev.session, from: ev.from, to: ev.to, reason: ev.reason } };
    case "error":
      return ev.account && /cm accounts login/.test(ev.message) ? { event: "account.needs_login", data: { account: ev.account, message: ev.message } } : null;
    default:
      return null;
  }
}

export class WebhookDispatcher {
  constructor(
    private readonly config: () => Config,
    private readonly log: (m: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  subscribe(bus: EventBus): () => void {
    return bus.subscribe((ev) => {
      const w = toWebhook(ev);
      if (w) void this.dispatch(w.event, w.data, ev.at);
    });
  }

  async dispatch(event: WebhookName, data: Record<string, unknown>, at = Date.now()): Promise<void> {
    const hooks = this.config().webhooks.filter(
      (h) => !h.events.length || h.events.includes(event) || h.events.some((e) => e.endsWith(".*") && event.startsWith(e.slice(0, -1))),
    );
    await Promise.all(hooks.map((h) => this.deliver(h.url, h.secret, event, data, at)));
  }

  /** One delivery with retries. Resolves to the final HTTP status or null when every attempt failed. */
  async deliver(url: string, secret: string | undefined, event: WebhookName, data: Record<string, unknown>, at = Date.now()): Promise<number | null> {
    const id = randomUUID();
    const body = JSON.stringify({ id, event, at: new Date(at).toISOString(), data });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "claudemanager-webhook",
      "x-cm-event": event,
      "x-cm-delivery": id,
    };
    if (secret) headers["x-cm-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
      try {
        const res = await this.fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
        if (res.ok) return res.status;
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          this.log(`webhook ${event} -> ${url}: HTTP ${res.status}, not retrying`);
          return res.status;
        }
        this.log(`webhook ${event} -> ${url}: HTTP ${res.status} (attempt ${attempt + 1})`);
      } catch (err: any) {
        this.log(`webhook ${event} -> ${url}: ${err?.message ?? err} (attempt ${attempt + 1})`);
      }
      if (attempt < RETRY_MS.length) await new Promise((r) => setTimeout(r, RETRY_MS[attempt]));
    }
    return null;
  }
}
