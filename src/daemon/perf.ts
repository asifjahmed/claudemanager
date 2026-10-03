import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/** Event-loop lag and per-request proxy overhead over a rolling one-minute window. */
export class PerfMonitor {
  private h: IntervalHistogram;
  private overheads: number[] = [];
  private ttfbs: number[] = [];
  private since = Date.now();
  private last: {
    loopP50Ms: number;
    loopP99Ms: number;
    loopMaxMs: number;
    overheadP50Ms: number | null;
    overheadP99Ms: number | null;
    ttfbP50Ms: number | null;
    requests: number;
  } | null = null;
  constructor() {
    this.h = monitorEventLoopDelay({ resolution: 20 });
    this.h.enable();
    const t = setInterval(() => this.roll(), 60_000);
    t.unref();
  }
  record(overheadMs: number | null, ttfbMs: number | null): void {
    if (overheadMs !== null) this.overheads.push(overheadMs);
    if (ttfbMs !== null) this.ttfbs.push(ttfbMs);
  }
  private pct(arr: number[], p: number): number | null {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  }
  private roll(): void {
    this.last = this.snapshot();
    this.h.reset();
    this.overheads = [];
    this.ttfbs = [];
    this.since = Date.now();
  }
  snapshot() {
    return {
      loopP50Ms: Math.round(this.h.percentile(50) / 1e6),
      loopP99Ms: Math.round(this.h.percentile(99) / 1e6),
      loopMaxMs: Math.round(this.h.max / 1e6),
      overheadP50Ms: this.pct(this.overheads, 0.5),
      overheadP99Ms: this.pct(this.overheads, 0.99),
      ttfbP50Ms: this.pct(this.ttfbs, 0.5),
      requests: this.overheads.length,
    };
  }
  /** current window plus the previous completed minute */
  report() {
    return { current: { ...this.snapshot(), windowSec: Math.round((Date.now() - this.since) / 1000) }, lastMinute: this.last };
  }
}
