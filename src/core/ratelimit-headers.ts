import { RL, type UnifiedStatus } from "./claude-internals.js";
import type { Usage, WindowUsage } from "./types.js";

export interface RateLimitInfo {
  fiveHour: WindowUsage | null;
  sevenDay: WindowUsage | null;
  status: UnifiedStatus | null;
  representativeClaim: string | null;
  resetAt: string | null;
  overageStatus: string | null;
  present: boolean;
}

type HeaderGetter = (name: string) => string | undefined;

function getter(headers: Record<string, string | string[] | undefined> | Headers): HeaderGetter {
  if (typeof (headers as Headers).get === "function") {
    return (n) => (headers as Headers).get(n) ?? undefined;
  }
  const h = headers as Record<string, string | string[] | undefined>;
  return (n) => {
    const v = h[n] ?? h[n.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
}

function unixToIso(v: string | undefined): string | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

function fractionToPercent(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 10;
}

export function parseRateLimitHeaders(headers: Record<string, string | string[] | undefined> | Headers): RateLimitInfo {
  const g = getter(headers);
  const fh = fractionToPercent(g(RL.fiveHourUtil));
  const sd = fractionToPercent(g(RL.sevenDayUtil));
  const status = (g(RL.status) as UnifiedStatus | undefined) ?? null;
  const present = fh !== null || sd !== null || status !== null;
  return {
    fiveHour: fh === null && !g(RL.fiveHourReset) ? null : { utilization: fh, resetsAt: unixToIso(g(RL.fiveHourReset)) },
    sevenDay: sd === null && !g(RL.sevenDayReset) ? null : { utilization: sd, resetsAt: unixToIso(g(RL.sevenDayReset)) },
    status,
    representativeClaim: g(RL.representativeClaim) ?? null,
    resetAt: unixToIso(g(RL.reset)),
    overageStatus: g(RL.overageStatus) ?? null,
    present,
  };
}

/** Merge live header data into a polled Usage snapshot (header data is fresher for 5h/7d). */
export function mergeHeaderUsage(prev: Usage | null, info: RateLimitInfo, now = Date.now()): Usage {
  const base: Usage = prev ?? {
    fiveHour: { utilization: null, resetsAt: null },
    sevenDay: { utilization: null, resetsAt: null },
    models: {},
    extra: {},
    fetchedAt: now,
    source: "headers",
  };
  return {
    ...base,
    fiveHour: info.fiveHour
      ? { utilization: info.fiveHour.utilization ?? base.fiveHour.utilization, resetsAt: info.fiveHour.resetsAt ?? base.fiveHour.resetsAt }
      : base.fiveHour,
    sevenDay: info.sevenDay
      ? { utilization: info.sevenDay.utilization ?? base.sevenDay.utilization, resetsAt: info.sevenDay.resetsAt ?? base.sevenDay.resetsAt }
      : base.sevenDay,
    fetchedAt: now,
    source: "headers",
  };
}
