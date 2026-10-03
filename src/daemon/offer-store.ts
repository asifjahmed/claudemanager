/** Loads offer definitions: bundled offers.json, a daily feed (cached on disk), and local config overrides. */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CM_HOME, type Config } from "../core/config.js";
import { parseFeed, mergeOffers, activeOffers, OfferSchema, type Offer } from "../core/offers.js";

const CACHE_PATH = join(CM_HOME, "offers-cache.json");

function bundledPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const cand of [join(here, "..", "..", "offers.json"), join(here, "..", "..", "..", "offers.json")]) if (existsSync(cand)) return cand;
  return join(here, "..", "..", "offers.json");
}

/** `CLAUDEMANAGER_OFFERS=off` disables promotions entirely (no bundled offers, no feed fetch). */
export const OFFERS_DISABLED = /^(off|0|false|no)$/i.test(process.env.CLAUDEMANAGER_OFFERS ?? "");

export class OfferStore {
  private bundled: Offer[] = [];
  private feed: Offer[] = [];
  private lastFetch = 0;
  private timer: NodeJS.Timeout | null = null;
  lastFeedError: string | null = null;
  constructor(
    private readonly config: () => Config,
    private readonly log: (m: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onChange?: () => void,
  ) {
    try {
      this.bundled = parseFeed(JSON.parse(readFileSync(bundledPath(), "utf8")));
    } catch (err: any) {
      log(`bundled offers.json unreadable: ${err?.message ?? err}`);
    }
    try {
      if (existsSync(CACHE_PATH)) {
        const c = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
        this.feed = parseFeed(c.feed);
        this.lastFetch = Number(c.at) || 0;
      }
    } catch {
      /* ignore a bad cache */
    }
  }

  /** all known definitions, later sources winning: bundled < feed < config.offers.local */
  all(): Offer[] {
    const local: Offer[] = [];
    for (const raw of this.config().offers.local) {
      const r = OfferSchema.safeParse(raw);
      if (r.success) local.push(r.data);
      else this.log(`ignoring invalid local offer: ${r.error.issues.map((i) => i.message).join("; ")}`);
    }
    return mergeOffers(this.bundled, this.feed, local);
  }

  active(now = Date.now()): Offer[] {
    if (OFFERS_DISABLED) return [];
    return activeOffers(this.all(), this.config().offers.disabled, now);
  }

  start(): void {
    if (this.timer || OFFERS_DISABLED) return;
    this.timer = setInterval(() => void this.maybeRefresh(), 15 * 60_000);
    this.timer.unref();
    void this.maybeRefresh();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async maybeRefresh(force = false): Promise<boolean> {
    const c = this.config().offers;
    if (!c.feedUrl) return false;
    if (!force && Date.now() - this.lastFetch < c.refreshHours * 3600_000) return false;
    this.lastFetch = Date.now();
    try {
      const res = await this.fetchImpl(c.feedUrl, {
        headers: { accept: "application/json", "user-agent": "claudemanager" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const offers = parseFeed(await res.json());
      const changed = JSON.stringify(offers) !== JSON.stringify(this.feed);
      this.feed = offers;
      this.lastFeedError = null;
      const tmp = `${CACHE_PATH}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ at: this.lastFetch, feed: { version: 1, offers } }), { mode: 0o600 });
      renameSync(tmp, CACHE_PATH);
      if (changed) {
        this.log(`offers feed updated: ${offers.map((o) => o.id).join(", ") || "none"}`);
        this.onChange?.();
      }
      return changed;
    } catch (err: any) {
      this.lastFeedError = err?.message ?? String(err);
      this.log(`offers feed fetch failed (${this.lastFeedError}); using bundled/cached definitions`);
      return false;
    }
  }
}
