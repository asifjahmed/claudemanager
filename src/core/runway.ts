/**
 * Runway: will the pool run out before the next reset adds headroom?
 *
 * No demand prediction, no routing simulation. For each window kind (session, weekly, per-model weekly) it takes
 * the pooled headroom across enabled accounts, the burn rate measured from usage snapshots, and the real reset
 * schedule, then walks forward: headroom drains at the burn rate and jumps up at every reset. The result is when
 * (if ever within 7 days) the pool would be empty at each pace, and what the next reset gives back.
 *
 * Units are "account-%": one percent of one account's window. Burn is measured as the sum of positive utilization
 * increments between consecutive snapshots (a reset shows up as a drop and is ignored), so consumption that happened
 * right before a reset inside one polling interval is missed; the burn estimate is therefore slightly low.
 */
import type { SnapshotRow } from "./capacity-snapshots.js";
import { modelFamily } from "./claude-internals.js";
export type { SnapshotRow };

export interface RunwayAccount {
  account: string;
  fiveHour: { utilization: number | null; resetsAt: string | null };
  sevenDay: { utilization: number | null; resetsAt: string | null };
  models: Record<string, { utilization: number | null; resetsAt?: string | null }>;
}

export interface RunwaySignals {
  /** last 7 days: sessions assigned or moved to an over-threshold account because nothing better existed */
  relaxedEvents: number;
  /** last 7 days: requests forwarded with the caller's own credentials because no account was usable */
  fallbackEvents: number;
  /** last 7 days: pool genuinely at its limits (not auth, not disabled) */
  dryEvents: number;
}

/** Per-model token/cost totals from the request log over one window (see Db.stats("model")). */
export interface ModelUsageRow {
  /** model id; Db.stats("model") returns it as `key` */
  model?: string | null;
  key?: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
}

export interface ModelRunway {
  /** full model id as requested, e.g. claude-fable-5-1 */
  model: string;
  family: string;
  requests24h: number;
  requests7d: number;
  /** share of the pool's consumption attributed to this family (by estimated cost), 0-1 */
  share24h: number | null;
  share7d: number | null;
  /** account-% per hour of the binding window attributed to this family */
  burnPerHour24h: number | null;
  burnPerHour7d: number | null;
  /** which window binds: the family's own weekly window when the server reports one, else the shared weekly */
  bindingWindow: string;
  headroom: number;
  eligibleAccounts: number;
  /** hours of binding-window headroom if only this family kept its recent pace (no resets) */
  hoursAtOwnPace24h: number | null;
  hoursAtOwnPace7d: number | null;
  nextReset: ResetEntry | null;
  tokens7d: { input: number; output: number; cacheRead: number; cacheWrite: number };
  estCostUsd7d: number;
}

export interface RunwayInput {
  snapshots: SnapshotRow[];
  accounts: RunwayAccount[];
  signals: RunwaySignals;
  /** request-log totals per model for the last 24 h and 7 d (optional; enables the per-model breakdown) */
  modelUsage24h?: ModelUsageRow[];
  modelUsage7d?: ModelUsageRow[];
  threshold: number;
  weeklyThreshold: number;
  now?: number;
}

export interface ResetEntry {
  account: string;
  at: number;
  /** account-% freed by this reset (its utilization at the time; we use the current value, which is conservative) */
  frees: number;
}

export interface WindowRunway {
  key: "session" | "weekly" | string;
  label: string;
  kind: "session" | "weekly" | "model";
  /** pooled account-% still usable before the windows are full */
  headroom: number;
  /** pooled capacity = accounts × 100 */
  capacity: number;
  /** per-account utilization for display */
  perAccount: Array<{ account: string; utilization: number | null; resetsAt: string | null }>;
  /** account-% per hour over the last 24 h and 7 d */
  burnPerHour24h: number | null;
  burnPerHour7d: number | null;
  /** hours until empty at each pace, walking forward through resets; null = not within the horizon or burn is 0 */
  emptyInHours24h: number | null;
  emptyInHours7d: number | null;
  nextReset: ResetEntry | null;
  resets: ResetEntry[];
  status: "ok" | "tight" | "critical" | "unknown";
  note: string;
}

export interface RunwayResult {
  now: number;
  horizonHours: number;
  coverageHours: number;
  windows: WindowRunway[];
  models: ModelRunway[];
  signals: RunwaySignals;
  verdict: "comfortable" | "close" | "tight" | "unknown";
  headline: string;
  detail: string;
}

const HORIZON_H = 7 * 24;

function increments(rows: SnapshotRow[], pick: (r: SnapshotRow) => number | null): Array<{ at: number; d: number }> {
  const byAcc = new Map<string, SnapshotRow[]>();
  for (const r of rows) (byAcc.get(r.account) ?? byAcc.set(r.account, []).get(r.account)!).push(r);
  const out: Array<{ at: number; d: number }> = [];
  for (const list of byAcc.values()) {
    list.sort((a, b) => a.at - b.at);
    let prev: number | null = null;
    for (const r of list) {
      const v = pick(r);
      if (v === null || !Number.isFinite(v)) continue;
      if (prev !== null && v > prev) out.push({ at: r.at, d: v - prev });
      prev = v;
    }
  }
  return out;
}

/** total account-% consumed across all accounts in the rows (sum of positive increments), or null without data */
export function consumedAccountPct(rows: SnapshotRow[], pick: (r: SnapshotRow) => number | null): number | null {
  if (rows.length < 2) return null;
  return increments(rows, pick).reduce((a, b) => a + b.d, 0);
}

/** account-% per hour consumed over the last `hours`, or null when there is no history in that span */
export function burnPerHourFor(rows: SnapshotRow[], pick: (r: SnapshotRow) => number | null, hours: number, now: number): number | null {
  return burnPerHour(rows, pick, hours, now);
}

function burnPerHour(rows: SnapshotRow[], pick: (r: SnapshotRow) => number | null, hours: number, now: number): number | null {
  const since = now - hours * 3600_000;
  const inWindow = rows.filter((r) => r.at >= since);
  if (inWindow.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of inWindow) {
    if (r.at < lo) lo = r.at;
    if (r.at > hi) hi = r.at;
  }
  const covered = (hi - lo) / 3600_000;
  if (covered < Math.min(1, hours / 4)) return null;
  const total = increments(inWindow, pick).reduce((a, b) => a + b.d, 0);
  return total / covered;
}

/** walk forward: drain at `burn` per hour, add back at each reset; hours until empty or null if not within the horizon */
function hoursUntilEmpty(headroom: number, burn: number | null, resets: ResetEntry[], now: number, capacity: number): number | null {
  if (burn === null || burn <= 0) return null;
  let h = headroom;
  let t = now;
  const sorted = [...resets].filter((r) => r.at > now).sort((a, b) => a.at - b.at);
  for (const r of sorted) {
    const dt = (r.at - t) / 3600_000;
    if (h - burn * dt <= 0) return (t - now) / 3600_000 + h / burn;
    h -= burn * dt;
    h = Math.min(capacity, h + r.frees);
    t = r.at;
  }
  const remaining = h / burn;
  const total = (t - now) / 3600_000 + remaining;
  return total <= HORIZON_H ? total : null;
}

function hrs(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export function analyzeRunway(input: RunwayInput): RunwayResult {
  const now = input.now ?? Date.now();
  const rows = input.snapshots.filter((r) => r.at >= now - HORIZON_H * 3600_000);
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const r of rows) {
    if (r.at < tMin) tMin = r.at;
    if (r.at > tMax) tMax = r.at;
  }
  const coverageHours = rows.length >= 2 ? (tMax - tMin) / 3600_000 : 0;
  const accounts = input.accounts;

  const build = (
    key: string,
    label: string,
    kind: WindowRunway["kind"],
    get: (a: RunwayAccount) => { utilization: number | null; resetsAt: string | null } | null,
    pick: (r: SnapshotRow) => number | null,
  ): WindowRunway => {
    const perAccount = accounts.map((a) => {
      const w = get(a);
      return { account: a.account, utilization: w?.utilization ?? null, resetsAt: w?.resetsAt ?? null };
    });
    const known = perAccount.filter((p) => p.utilization !== null);
    const capacity = accounts.length * 100;
    const headroom = perAccount.reduce((t, p) => t + Math.max(0, 100 - (p.utilization ?? 0)), 0);
    const resets: ResetEntry[] = perAccount
      .filter((p) => p.resetsAt && (p.utilization ?? 0) > 0)
      .map((p) => ({ account: p.account, at: Date.parse(p.resetsAt!), frees: Math.min(100, p.utilization ?? 0) }))
      .filter((r) => Number.isFinite(r.at) && r.at > now)
      .sort((a, b) => a.at - b.at);
    const burn24 = burnPerHour(rows, pick, 24, now);
    const burn7 = burnPerHour(rows, pick, HORIZON_H, now);
    // A 5-hour window is a rate limit, not a reservoir: every account's window refills completely every 5 h.
    // The pool runs out only if the pooled pace would fill all windows within one cycle; otherwise it is sustainable.
    const sessionEmpty = (burn: number | null): number | null => {
      if (burn === null || burn <= 0) return null;
      if (burn * 5 <= capacity) return null;
      return headroom / burn;
    };
    const empty24 = kind === "session" ? sessionEmpty(burn24) : hoursUntilEmpty(headroom, burn24, resets, now, capacity);
    const empty7 = kind === "session" ? sessionEmpty(burn7) : hoursUntilEmpty(headroom, burn7, resets, now, capacity);
    const nextReset = resets[0] ?? null;
    let status: WindowRunway["status"];
    let note: string;
    if (!known.length) {
      status = "unknown";
      note = "no usage data yet";
    } else if (burn24 === null && burn7 === null) {
      status = "unknown";
      note = "not enough history to measure a burn rate";
    } else {
      const empty = empty24 ?? empty7;
      const pace = empty24 !== null ? "24 h" : "7 d";
      if (empty === null) {
        status = "ok";
        note =
          kind === "session"
            ? `sustainable: the recent pace fills ${Math.round(((burn24 ?? burn7 ?? 0) * 5 * 100) / capacity)}% of the pooled 5-hour capacity per cycle`
            : `not running out within 7 days at the recent pace`;
      } else if (empty < 6 || (nextReset && empty < (nextReset.at - now) / 3600_000 && empty < 24)) {
        status = "critical";
        note = `empty in ${hrs(empty)} at the ${pace} pace${nextReset ? `; next reset (${nextReset.account}, +${Math.round(nextReset.frees)}%) in ${hrs((nextReset.at - now) / 3600_000)}` : ""}`;
      } else {
        status = "tight";
        note = `empty in ${hrs(empty)} at the ${pace} pace, resets included`;
      }
    }
    return {
      key,
      label,
      kind,
      headroom,
      capacity,
      perAccount,
      burnPerHour24h: burn24,
      burnPerHour7d: burn7,
      emptyInHours24h: empty24,
      emptyInHours7d: empty7,
      nextReset,
      resets,
      status,
      note,
    };
  };

  const windows: WindowRunway[] = [
    build(
      "session",
      "Session (5 h)",
      "session",
      (a) => a.fiveHour,
      (r) => r.fiveHourUtil,
    ),
    build(
      "weekly",
      "Weekly, all models",
      "weekly",
      (a) => a.sevenDay,
      (r) => r.sevenDayUtil,
    ),
  ];
  const modelKeys = new Set<string>();
  for (const a of accounts) for (const k of Object.keys(a.models ?? {})) modelKeys.add(k);
  for (const k of [...modelKeys].sort()) {
    windows.push(
      build(
        k,
        `Weekly, ${k[0].toUpperCase()}${k.slice(1)}`,
        "model",
        (a) => (a.models?.[k] ? { utilization: a.models[k].utilization, resetsAt: a.models[k].resetsAt ?? a.sevenDay.resetsAt } : null),
        (r) => r.models?.[k]?.utilization ?? null,
      ),
    );
  }

  // ---- per-model breakdown: attribute the measured burn to model ids by their estimated-cost share ----
  const byModel = (rows: ModelUsageRow[] | undefined) => {
    const m = new Map<string, { family: string; requests: number; cost: number; t: ModelRunway["tokens7d"] }>();
    for (const r of rows ?? []) {
      const id = (r.model ?? r.key) || "unknown";
      const e = m.get(id) ?? { family: modelFamily(id) ?? "other", requests: 0, cost: 0, t: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      e.requests += r.requests;
      e.cost += r.estCostUsd ?? 0;
      e.t.input += r.inputTokens ?? 0;
      e.t.output += r.outputTokens ?? 0;
      e.t.cacheRead += r.cacheReadTokens ?? 0;
      e.t.cacheWrite += r.cacheWriteTokens ?? 0;
      m.set(id, e);
    }
    return m;
  };
  const m24 = byModel(input.modelUsage24h);
  const m7 = byModel(input.modelUsage7d);
  const total = (m: Map<string, { cost: number }>) => [...m.values()].reduce((t, e) => t + e.cost, 0);
  const familyTotal = (m: Map<string, { family: string; cost: number }>, fam: string) =>
    [...m.values()].filter((e) => e.family === fam).reduce((t, e) => t + e.cost, 0);
  const cost24 = total(m24);
  const cost7 = total(m7);
  const weeklyWin = windows.find((w) => w.key === "weekly")!;
  const ids = new Set<string>([...m24.keys(), ...m7.keys()]);
  const models: ModelRunway[] = [...ids].sort().map((id) => {
    const fam = m7.get(id)?.family ?? m24.get(id)?.family ?? modelFamily(id) ?? "other";
    const own = windows.find((w) => w.kind === "model" && w.key === fam) ?? null;
    const binding = own ?? weeklyWin;
    const e24 = m24.get(id);
    const e7 = m7.get(id);
    const share24 = cost24 > 0 && e24 ? e24.cost / cost24 : null;
    const share7 = cost7 > 0 && e7 ? e7.cost / cost7 : null;
    // burn on the binding window: a family with its own window is measured there and split among its models by
    // cost share within the family; otherwise the shared weekly burn × this model's share of everything
    const within24 = own && e24 ? (familyTotal(m24, fam) > 0 ? e24.cost / familyTotal(m24, fam) : null) : null;
    const within7 = own && e7 ? (familyTotal(m7, fam) > 0 ? e7.cost / familyTotal(m7, fam) : null) : null;
    const burn24 = own
      ? own.burnPerHour24h !== null && within24 !== null
        ? own.burnPerHour24h * within24
        : null
      : share24 !== null && weeklyWin.burnPerHour24h !== null
        ? weeklyWin.burnPerHour24h * share24
        : null;
    const burn7 = own
      ? own.burnPerHour7d !== null && within7 !== null
        ? own.burnPerHour7d * within7
        : null
      : share7 !== null && weeklyWin.burnPerHour7d !== null
        ? weeklyWin.burnPerHour7d * share7
        : null;
    const eligible = accounts.filter((a) => {
      const w = own ? a.models[fam] : a.sevenDay;
      const util = w?.utilization ?? 0;
      return util < input.weeklyThreshold && (a.sevenDay.utilization ?? 0) < input.weeklyThreshold && (a.fiveHour.utilization ?? 0) < input.threshold;
    }).length;
    return {
      model: id,
      family: fam,
      requests24h: e24?.requests ?? 0,
      requests7d: e7?.requests ?? 0,
      share24h: share24,
      share7d: share7,
      burnPerHour24h: burn24,
      burnPerHour7d: burn7,
      bindingWindow: binding.label,
      headroom: binding.headroom,
      eligibleAccounts: eligible,
      hoursAtOwnPace24h: burn24 && burn24 > 0 ? binding.headroom / burn24 : null,
      hoursAtOwnPace7d: burn7 && burn7 > 0 ? binding.headroom / burn7 : null,
      nextReset: binding.nextReset,
      tokens7d: e7?.t ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      estCostUsd7d: e7?.cost ?? 0,
    };
  });

  const s = input.signals;
  const worst = windows.reduce<WindowRunway["status"]>(
    (w, x) =>
      x.status === "critical" || w === "critical"
        ? "critical"
        : x.status === "tight" || w === "tight"
          ? "tight"
          : x.status === "ok" || w === "ok"
            ? "ok"
            : "unknown",
    "unknown",
  );
  let verdict: RunwayResult["verdict"];
  let headline: string;
  let detail: string;
  if (worst === "unknown") {
    verdict = "unknown";
    headline = "Not enough data yet";
    detail = `${coverageHours.toFixed(1)} h of usage history. Runway needs a few hours of normal use.`;
  } else if (s.fallbackEvents > 0 || s.dryEvents > 0 || worst === "critical") {
    verdict = "tight";
    headline = worst === "critical" ? "Running out before the next reset" : "The pool ran dry this week";
    detail = `${s.dryEvents ? `${s.dryEvents} pool-dry event${s.dryEvents === 1 ? "" : "s"}` : ""}${s.fallbackEvents ? `${s.dryEvents ? ", " : ""}${s.fallbackEvents} fail-open request${s.fallbackEvents === 1 ? "" : "s"}` : ""}${s.dryEvents || s.fallbackEvents ? " in the last 7 days. " : ""}One more account, or routine work on lighter models, would give this pace room.`;
  } else if (s.relaxedEvents > 0 || worst === "tight") {
    verdict = "close";
    headline = "Close to the edge";
    detail = `${s.relaxedEvents ? `${s.relaxedEvents} session${s.relaxedEvents === 1 ? "" : "s"} had to use an over-threshold account in the last 7 days. ` : ""}Resets are keeping up, but there is little slack.`;
  } else {
    verdict = "comfortable";
    headline = "Resets are keeping up";
    detail = "No window runs out before its next reset at the recent pace, and no session needed a fallback this week.";
  }
  return { now, horizonHours: HORIZON_H, coverageHours, windows, models, signals: s, verdict, headline, detail };
}
