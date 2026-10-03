import type { AccountConfig, AccountState, Usage } from "./types.js";

export function emptyState(cfg: AccountConfig): AccountState {
  return {
    name: cfg.name,
    email: cfg.email ?? null,
    orgName: cfg.orgName ?? null,
    tier: null,
    profile: null,
    subscriptionType: cfg.subscriptionType ?? null,
    disabled: !!cfg.disabled,
    usage: null,
    exhaustedUntil: null,
    tokenExpiresAt: null,
    tokenOk: true,
    needsLogin: false,
    hasInferenceToken: false,
    lastError: null,
    lastErrorAt: null,
    lastStatus: null,
    representativeClaim: null,
    lastUsedAt: null,
    requestCount: 0,
  };
}

/** In-memory per-account runtime state. Pure data holder; the poller and proxy mutate it. */
export class AccountStore {
  private states = new Map<string, AccountState>();

  constructor(accounts: AccountConfig[] = []) {
    this.sync(accounts);
  }

  /** Reconcile with config: add new, drop removed, update static fields, keep runtime state. */
  sync(accounts: AccountConfig[]): void {
    const names = new Set(accounts.map((a) => a.name));
    for (const name of this.states.keys()) if (!names.has(name)) this.states.delete(name);
    for (const a of accounts) {
      const existing = this.states.get(a.name);
      if (existing) {
        existing.email = a.email ?? existing.email;
        existing.orgName = a.orgName ?? existing.orgName;
        existing.disabled = !!a.disabled;
      } else {
        this.states.set(a.name, emptyState(a));
      }
    }
  }

  get(name: string): AccountState | undefined {
    return this.states.get(name);
  }
  all(): AccountState[] {
    return [...this.states.values()];
  }
  names(): string[] {
    return [...this.states.keys()];
  }

  setUsage(name: string, usage: Usage): void {
    const s = this.states.get(name);
    if (!s) return;
    s.usage = usage;
    // Only a poll snapshot (which carries every window) may clear an exhaustion mark; header merges lack per-model windows.
    if (
      s.exhaustedUntil &&
      usage.source === "poll" &&
      usage.fiveHour.utilization !== null &&
      usage.fiveHour.utilization < 100 &&
      usage.sevenDay.utilization !== null &&
      usage.sevenDay.utilization < 100 &&
      Object.values(usage.models).every((m) => m.utilization === null || m.utilization < 100)
    ) {
      s.exhaustedUntil = null;
    }
  }
  setError(name: string, message: string | null): void {
    const s = this.states.get(name);
    if (!s) return;
    s.lastError = message;
    s.lastErrorAt = message ? Date.now() : null;
  }
  markExhausted(name: string, untilMs: number | null, claim: string | null): void {
    const s = this.states.get(name);
    if (!s) return;
    s.exhaustedUntil = untilMs ?? Date.now() + 15 * 60_000;
    s.representativeClaim = claim;
    s.lastStatus = "rate_limited";
  }
  markUsed(name: string): void {
    const s = this.states.get(name);
    if (!s) return;
    s.lastUsedAt = Date.now();
    s.requestCount++;
  }
  clearExpiredExhaustion(now = Date.now()): void {
    for (const s of this.states.values()) if (s.exhaustedUntil && s.exhaustedUntil <= now) s.exhaustedUntil = null;
  }
}
