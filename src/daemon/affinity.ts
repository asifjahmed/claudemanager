import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface SessionAffinity {
  account: string;
  assignedAt: number;
  lastUsedAt: number;
  lastSwitchAt: number | null;
  requests: number;
}

/** Session → account map. Persisted so a daemon restart does not move every session (each move re-writes its prompt cache). */
export class AffinityStore {
  private map = new Map<string, SessionAffinity>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly path: string | null,
    private readonly idleMs = 2 * 3600_000,
    private readonly max = 5000,
  ) {
    if (path && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, SessionAffinity>;
        const now = Date.now();
        for (const [k, v] of Object.entries(raw)) if (v && typeof v.account === "string" && now - (v.lastUsedAt ?? 0) < idleMs) this.map.set(k, v);
      } catch {
        /* start empty */
      }
    }
  }
  get(sessionId: string): SessionAffinity | undefined {
    return this.map.get(sessionId);
  }
  assign(sessionId: string, account: string, switched: boolean): SessionAffinity {
    const now = Date.now();
    const prev = this.map.get(sessionId);
    const next: SessionAffinity = {
      account,
      assignedAt: prev && prev.account === account ? prev.assignedAt : now,
      lastUsedAt: now,
      lastSwitchAt: switched ? now : (prev?.lastSwitchAt ?? null),
      requests: (prev?.requests ?? 0) + 1,
    };
    this.map.delete(sessionId); // re-insert keeps Map in LRU order
    this.map.set(sessionId, next);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    this.schedule();
    return next;
  }
  /** number of sessions per account that were active within `windowMs` */
  activeByAccount(windowMs = 10 * 60_000, now = Date.now()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const v of this.map.values()) if (now - v.lastUsedAt <= windowMs) out[v.account] = (out[v.account] ?? 0) + 1;
    return out;
  }
  /** sessions currently assigned to an account (active within windowMs) */
  sessionsOn(account: string, windowMs = 10 * 60_000, now = Date.now()): string[] {
    const out: string[] = [];
    for (const [k, v] of this.map) if (v.account === account && now - v.lastUsedAt <= windowMs) out.push(k);
    return out;
  }
  /** an account was renamed: keep sessions attached */
  renameAccount(from: string, to: string): void {
    for (const v of this.map.values()) if (v.account === from) v.account = to;
    this.schedule();
  }
  size(): number {
    return this.map.size;
  }
  evict(now = Date.now()): number {
    let n = 0;
    for (const [k, v] of this.map) {
      if (now - v.lastUsedAt > this.idleMs) {
        this.map.delete(k);
        n++;
      }
    }
    if (n) this.schedule();
    return n;
  }
  private schedule(): void {
    this.dirty = true;
    if (!this.path || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 2000);
    this.timer.unref();
  }
  flush(): void {
    if (!this.path || !this.dirty) return;
    this.dirty = false;
    try {
      const tmp = `${this.path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      /* best effort */
    }
  }
}
