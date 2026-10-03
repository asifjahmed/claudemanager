import type { Config } from "../core/config.js";
import type { AccountStore } from "../core/accounts.js";
import type { EventBus } from "../core/events.js";
import type { Recorder } from "./recorder.js";
import { getFreshToken, CredentialError } from "../core/credentials.js";
import { getInferenceToken } from "../core/inference-token.js";
import { fetchUsage, fetchProfile, nextAnniversary, UsageError } from "../core/usage.js";

export interface PollerDeps {
  config: () => Config;
  store: AccountStore;
  bus: EventBus;
  recorder: Recorder | null;
  current: () => string | null;
  log: (msg: string) => void;
  fetchImpl?: typeof fetch;
  /** tests: override token acquisition */
  getCreds?: (
    configDir: string,
    opts: { allowRefresh: boolean; minTtlMs: number },
  ) => Promise<{ accessToken: string; expiresAt: number; rateLimitTier?: string | null; subscriptionType?: string }>;
}

const TICK_MS = 5_000;
/** A tick arriving this late means the machine slept (or was suspended). */
const SLEEP_GAP_MS = 3 * TICK_MS;
/** Consecutive on-time ticks required before any token refresh: ~30 s continuously awake. DarkWake blips never get there. */
const AWAKE_TICKS_REQUIRED = 6;
/** The poller refreshes early, while the old access token still works, so a failed attempt costs nothing. */
const EARLY_REFRESH_MS = 30 * 60_000;

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private lastPolled = new Map<string, number>();
  private inFlight = new Set<string>();
  private lastPrune = 0;
  private lastTick = Date.now();
  /** starts "awake": a daemon start is a deliberate, awake moment (the preflight still guards the network) */
  private awakeTicks = AWAKE_TICKS_REQUIRED;
  /** usage-endpoint 429 backoff: account -> { until, strikes } */
  private backoff = new Map<string, { until: number; strikes: number }>();

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** true once the machine has been continuously awake long enough to trust the network */
  get stableAwake(): boolean {
    return this.awakeTicks >= AWAKE_TICKS_REQUIRED;
  }

  private async tick(): Promise<void> {
    const cfg = this.deps.config();
    const now = Date.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    if (gap > SLEEP_GAP_MS) {
      this.deps.log(
        `timer gap ${Math.round(gap / 1000)}s: system slept; holding polls and token refreshes until awake for ${(AWAKE_TICKS_REQUIRED * TICK_MS) / 1000}s`,
      );
      this.awakeTicks = 0;
    } else {
      this.awakeTicks++;
    }
    if (!this.stableAwake) return;
    const current = this.deps.current();
    for (const a of cfg.accounts) {
      if (a.disabled) continue;
      const interval = (a.name === current ? cfg.activePollIntervalSec : cfg.pollIntervalSec) * 1000;
      const last = this.lastPolled.get(a.name) ?? 0;
      const bo = this.backoff.get(a.name);
      if (bo && bo.until > now) continue;
      if (now - last >= interval) void this.pollOne(a.name);
    }
    if (this.deps.recorder && now - this.lastPrune > 3600_000) {
      this.lastPrune = now;
      this.deps.recorder.prune(cfg.log.retentionDays, cfg.log.maxDbMb); // runs in the db worker
    }
  }

  /** Forget poll backoff (usage 429s, dead-login rechecks) so the next poll runs now. */
  resetBackoff(name?: string): void {
    if (name) this.backoff.delete(name);
    else this.backoff.clear();
  }

  async pollAll(): Promise<void> {
    await Promise.all(
      this.deps
        .config()
        .accounts.filter((a) => !a.disabled)
        .map((a) => this.pollOne(a.name)),
    );
  }

  async pollOne(name: string, opts: { ignoreBackoff?: boolean } = {}): Promise<void> {
    if (this.inFlight.has(name)) return;
    const bo = this.backoff.get(name);
    if (!opts.ignoreBackoff && bo && bo.until > Date.now()) return;
    const acct = this.deps.config().accounts.find((a) => a.name === name);
    const state = this.deps.store.get(name);
    if (!acct || !state) return;
    this.inFlight.add(name);
    this.lastPolled.set(name, Date.now());
    try {
      state.hasInferenceToken = !!(await getInferenceToken(name));
      const creds = this.deps.getCreds
        ? await this.deps.getCreds(acct.configDir, { allowRefresh: this.stableAwake, minTtlMs: EARLY_REFRESH_MS })
        : await getFreshToken(acct.configDir, {
            fetchImpl: this.deps.fetchImpl,
            allowRefresh: this.stableAwake,
            minTtlMs: EARLY_REFRESH_MS,
            log: this.deps.log,
          });
      state.tokenExpiresAt = creds.expiresAt;
      state.tokenOk = true;
      state.needsLogin = false;
      state.tier = creds.rateLimitTier ?? state.tier;
      state.subscriptionType = creds.subscriptionType ?? state.subscriptionType;
      const pollStartedAt = Date.now();
      const { usage } = await fetchUsage(creds.accessToken, this.deps.fetchImpl);
      // live headers seen since this poll started are fresher for the 5h/7d windows; keep them, take the rest from the poll
      const cur = state.usage;
      if (cur && cur.source === "headers" && cur.fetchedAt > pollStartedAt) {
        usage.fiveHour = cur.fiveHour;
        usage.sevenDay = cur.sevenDay;
      }
      this.deps.store.setUsage(name, usage);
      // profile (subscription status, derived next billing date): once a day per account, never on the hot path
      if (!state.profile || Date.now() - state.profile.fetchedAt > 24 * 3600_000) {
        try {
          const p = await fetchProfile(creds.accessToken, this.deps.fetchImpl);
          state.profile = {
            subscriptionStatus: p.subscriptionStatus,
            subscriptionCreatedAt: p.subscriptionCreatedAt,
            nextBillingAt: p.nextBillingAt,
            hasExtraUsage: p.hasExtraUsage,
            fetchedAt: Date.now(),
          };
          state.tier = p.rateLimitTier ?? state.tier;
        } catch (err: any) {
          this.deps.log(`profile ${name}: ${err?.message ?? err}`);
          state.profile = { subscriptionStatus: null, subscriptionCreatedAt: null, nextBillingAt: null, hasExtraUsage: false, fetchedAt: Date.now() };
        }
      } else if (state.profile.subscriptionCreatedAt) {
        state.profile.nextBillingAt = nextAnniversary(state.profile.subscriptionCreatedAt);
      }
      this.deps.store.setError(name, null);
      this.backoff.delete(name);
      this.deps.recorder?.snapshot(name, usage);
      this.deps.bus.publish({ type: "usage", at: Date.now(), account: name, usage });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (err instanceof UsageError && err.status === 429) {
        // The usage endpoint has its own (undocumented) rate limit. Back off: 2, 4, 8 ... up to 30 minutes.
        const strikes = (this.backoff.get(name)?.strikes ?? 0) + 1;
        const delay = Math.min(30 * 60_000, 2 * 60_000 * 2 ** (strikes - 1));
        this.backoff.set(name, { until: Date.now() + delay, strikes });
        const note = `usage poll rate-limited; retrying in ${Math.round(delay / 60_000)}m (live headers still update this account)`;
        this.deps.store.setError(name, note);
        if (strikes === 1) this.deps.bus.publish({ type: "error", at: Date.now(), account: name, message: note });
        this.deps.log(`poll ${name}: 429 from usage endpoint, backing off ${Math.round(delay / 60_000)}m`);
        return;
      }
      if (err instanceof CredentialError && err.needsLogin) {
        // Dead login. Say so once, clearly, and stop hammering the token endpoint: recheck every 10 minutes.
        const first = !state.needsLogin;
        state.tokenOk = false;
        state.needsLogin = true;
        const note = `${msg} — run: cm accounts login ${name}`;
        this.deps.store.setError(name, note);
        this.backoff.set(name, { until: Date.now() + 10 * 60_000, strikes: 0 });
        if (first) {
          this.deps.bus.publish({ type: "error", at: Date.now(), account: name, message: note });
          this.deps.log(`poll ${name}: ${note}`);
        }
        return;
      }
      if (err instanceof CredentialError && (err.code === "held" || err.code === "network")) {
        // Transient: the login is presumably fine, we just must not (or could not) refresh right now.
        this.deps.store.setError(name, msg);
        this.deps.log(`poll ${name}: ${msg}`);
        return;
      }
      if (err instanceof CredentialError) state.tokenOk = false;
      this.deps.store.setError(name, msg);
      this.deps.bus.publish({ type: "error", at: Date.now(), account: name, message: msg });
      this.deps.log(`poll ${name} failed: ${msg}`);
    } finally {
      this.inFlight.delete(name);
    }
  }
}
