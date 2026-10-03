/**
 * Edge-triggered limit events from the stream of usage updates:
 *   reset       — an account's window reset (utilization dropped sharply, or its reset time passed and moved on)
 *   approaching — pooled headroom for a model family fell below the configured level
 *   exhausted   — pooled headroom for a model family hit zero
 *   recovered   — pooled headroom for a family climbed back above the level after approaching/exhausted
 * Pure state machine; the daemon feeds it every usage update and publishes what it returns.
 */
import type { AccountState, Usage } from "./types.js";

export type LimitEvent =
  | { kind: "reset"; account: string; window: "session" | "weekly" | string; freed: number; resetsAt: string | null }
  | { kind: "approaching" | "exhausted" | "recovered"; family: string; headroom: number; nextResetAt: string | null };

interface WindowMemo {
  util: number | null;
  resetsAt: string | null;
}

const h = (u: number | null | undefined) => (u === null || u === undefined ? 100 : Math.max(0, 100 - u));

export class LimitTracker {
  private windows = new Map<string, WindowMemo>(); // key account|window
  private familyState = new Map<string, "ok" | "approaching" | "exhausted">();
  constructor(private readonly approachingHeadroom: number) {}

  /** Call with the account's new usage and the full current pool; returns events to publish. */
  update(account: string, usage: Usage, pool: AccountState[], now = Date.now()): LimitEvent[] {
    const out: LimitEvent[] = [];
    const check = (window: string, util: number | null, resetsAt: string | null) => {
      const key = `${account}|${window}`;
      const prev = this.windows.get(key);
      this.windows.set(key, { util, resetsAt });
      if (!prev || prev.util === null || util === null) return;
      const dropped = util < prev.util - 10;
      const rolled = !!prev.resetsAt && !!resetsAt && prev.resetsAt !== resetsAt && Date.parse(prev.resetsAt) <= now && util <= prev.util;
      if (dropped || rolled) out.push({ kind: "reset", account, window, freed: Math.max(0, prev.util - util), resetsAt });
    };
    check("session", usage.fiveHour.utilization, usage.fiveHour.resetsAt);
    check("weekly", usage.sevenDay.utilization, usage.sevenDay.resetsAt);
    for (const [k, w] of Object.entries(usage.models)) check(k, w.utilization, w.resetsAt);

    // pooled per family (binding window: per-model weekly when known, else weekly), edge-triggered
    const live = pool.filter((a) => !a.disabled && (a.tokenOk || a.hasInferenceToken));
    const families = new Set<string>();
    for (const a of live) for (const k of Object.keys(a.usage?.models ?? {})) families.add(k);
    for (const f of families) {
      let headroom = 0;
      let next: number | null = null;
      for (const a of live) {
        const m = a.usage?.models[f];
        const util = m ? m.utilization : (a.usage?.sevenDay.utilization ?? null);
        headroom += Math.min(h(util), h(a.usage?.sevenDay.utilization), h(a.usage?.fiveHour.utilization));
        const iso = m?.resetsAt ?? a.usage?.sevenDay.resetsAt ?? null;
        const t = iso ? Date.parse(iso) : NaN;
        if ((util ?? 0) > 0 && Number.isFinite(t) && t > now && (next === null || t < next)) next = t;
      }
      const state: "ok" | "approaching" | "exhausted" = headroom <= 0 ? "exhausted" : headroom <= this.approachingHeadroom ? "approaching" : "ok";
      const prev = this.familyState.get(f) ?? "ok";
      if (state !== prev) {
        this.familyState.set(f, state);
        if (state === "ok" && prev !== "ok") out.push({ kind: "recovered", family: f, headroom, nextResetAt: null });
        else if (state !== "ok") out.push({ kind: state, family: f, headroom, nextResetAt: next ? new Date(next).toISOString() : null });
      }
    }
    return out;
  }
}
