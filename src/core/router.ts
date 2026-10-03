import type { AccountState, Policy, RouteDecision, RouteReason } from "./types.js";

export interface RouteInput {
  accounts: AccountState[];
  policy: Policy;
  current: string | null;
  /** model family of the request (fable/opus/sonnet/...) or null */
  modelFamily: string | null;
  exclude?: Set<string>;
  now?: number;
  /** when the router last switched accounts; rate-limits proactive (perishable) switches */
  lastSwitchAt?: number | null;
}

/** ms until the weekly window that matters for this request resets; unknown (never used) counts as a full week away */
export function weeklyResetMs(a: AccountState, modelFamily: string | null, now: number): number {
  const u = a.usage;
  const iso = (modelFamily && u?.models[modelFamily]?.resetsAt) || u?.sevenDay.resetsAt || null;
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t) || t <= now) return 7 * 86400_000;
  return t - now;
}

function weeklyHeadroom(a: AccountState, modelFamily: string | null): number {
  const u = a.usage;
  const w = headroom(u?.sevenDay.utilization ?? null);
  const m = modelFamily && u?.models[modelFamily] ? headroom(u.models[modelFamily].utilization) : 100;
  return Math.min(w, m);
}

export interface Eligibility {
  /** 1 = within thresholds; 2 = over a switch threshold but still has room (fallback only); 0 = cannot serve */
  tier: 0 | 1 | 2;
  eligible: boolean;
  reason: RouteReason | null;
  /** smallest remaining headroom across the windows that apply to this request, in percent */
  minHeadroom: number;
}

export function headroom(util: number | null): number {
  return util === null ? 100 : Math.max(0, 100 - util);
}

/**
 * Thresholds decide when to *prefer* switching. They are not hard limits: an account over a threshold but under
 * 100% is still tier 2, used only when no tier-1 account exists, because serving from the last few percent beats
 * stalling. Only a server-confirmed exhaustion, a window at 100%, a dead token or a disabled flag is tier 0.
 */
export function eligibility(a: AccountState, policy: Policy, modelFamily: string | null, now: number, opts: { assigned?: boolean } = {}): Eligibility {
  const out = (tier: 0 | 1 | 2, reason: RouteReason | null, minHeadroom: number): Eligibility => ({ tier, eligible: tier === 1, reason, minHeadroom });
  if (a.disabled) return out(0, "disabled", 0);
  if (!a.tokenOk && !a.hasInferenceToken) return out(0, "error", 0);
  if (a.exhaustedUntil && a.exhaustedUntil > now) return out(0, "exhausted", 0);
  const u = a.usage;
  if (!u) return out(1, null, 100); // unknown usage: allow, headers will teach us fast
  // hysteresis: a session already on this account is ejected only at ejectThreshold; new sessions stop landing at threshold
  const sessionLimit = opts.assigned ? Math.max(policy.threshold, policy.ejectThreshold ?? policy.threshold) : policy.threshold;
  const windows: Array<{ util: number | null; threshold: number; reason: RouteReason }> = [
    { util: u.fiveHour.utilization, threshold: sessionLimit, reason: "threshold" },
    { util: u.sevenDay.utilization, threshold: policy.weeklyThreshold, reason: "weekly" },
  ];
  if (modelFamily && u.models[modelFamily])
    windows.push({ util: u.models[modelFamily].utilization, threshold: policy.weeklyThreshold, reason: "model_weekly" });
  let minHeadroom = 100;
  let over: RouteReason | null = null;
  for (const w of windows) {
    if (w.util === null) continue;
    minHeadroom = Math.min(minHeadroom, headroom(w.util));
    if (w.util >= 100) return out(0, w.reason, 0);
    if (w.util >= w.threshold && !over) over = w.reason;
  }
  return over ? out(2, over, minHeadroom) : out(1, null, minHeadroom);
}

function earliestReset(accounts: AccountState[], now: number): number | null {
  let best: number | null = null;
  for (const a of accounts) {
    const candidates: number[] = [];
    if (a.exhaustedUntil && a.exhaustedUntil > now) candidates.push(a.exhaustedUntil);
    const r = a.usage?.fiveHour.resetsAt;
    if (r) {
      const t = Date.parse(r);
      if (Number.isFinite(t) && t > now) candidates.push(t);
    }
    for (const t of candidates) if (best === null || t < best) best = t;
  }
  return best;
}

/** Session headroom below this is "about to switch anyway": such accounts rank last regardless of reset time. */
const MIN_USEFUL_SESSION_HEADROOM = 20;

interface Keyed {
  a: AccountState;
  session: number;
  usefulSession: 0 | 1;
  /** smallest per-model-window headroom, bucketed to 10%; null when the request's family has its own window */
  scarce: number | null;
  resetH: number;
  weekly: number;
}

function keyOf(a: AccountState, policy: Policy, modelFamily: string | null, now: number, familyHasOwnWindow: boolean): Keyed {
  const session = headroom(a.usage?.fiveHour.utilization ?? null);
  let scarce: number | null = null;
  if (policy.modelAware !== false && modelFamily && !familyHasOwnWindow) {
    const own = Object.values(a.usage?.models ?? {});
    if (own.length) scarce = Math.floor(Math.min(...own.map((w) => headroom(w.utilization))) / 10);
  }
  return {
    a,
    session,
    usefulSession: session >= MIN_USEFUL_SESSION_HEADROOM ? 0 : 1,
    scarce,
    resetH: policy.preferSoonerReset !== false ? Math.floor(weeklyResetMs(a, modelFamily, now) / 3600_000) : 0,
    weekly: weeklyHeadroom(a, modelFamily),
  };
}

/**
 * Ranking with precomputed keys (one pass over accounts, then an O(A log A) sort):
 * useful session headroom → drain target → model-aware (spent scarce windows first for models without their own
 * window) → soonest weekly reset → most session headroom → most weekly headroom → name.
 */
function makeRank(policy: Policy, modelFamily: string | null, now: number, accounts: AccountState[]) {
  const prefer = policy.preferSoonerReset !== false;
  const modelAware = policy.modelAware !== false;
  const familyHasOwnWindow = !!modelFamily && accounts.some((x) => x.usage?.models[modelFamily] !== undefined);
  const keys = new Map<string, Keyed>();
  for (const a of accounts) keys.set(a.name, keyOf(a, policy, modelFamily, now, familyHasOwnWindow));
  return (x: AccountState, y: AccountState): number => {
    const a = keys.get(x.name)!;
    const b = keys.get(y.name)!;
    if ((prefer || modelAware) && a.usefulSession !== b.usefulSession) return a.usefulSession - b.usefulSession;
    if (policy.drainAccount) {
      const da = x.name === policy.drainAccount ? 0 : 1;
      const db = y.name === policy.drainAccount ? 0 : 1;
      if (da !== db) return da - db;
    }
    if (modelAware && a.scarce !== null && b.scarce !== null && a.scarce !== b.scarce) return a.scarce - b.scarce;
    if (prefer && a.resetH !== b.resetH) return a.resetH - b.resetH;
    if (b.session !== a.session) return b.session - a.session;
    if (b.weekly !== a.weekly) return b.weekly - a.weekly;
    return x.name.localeCompare(y.name);
  };
}

const PROACTIVE_MIN_INTERVAL_MS = 30 * 60_000;
/** at most one proactive (perishable) move across the whole pool per this interval: never a herd */
const PROACTIVE_GLOBAL_GAP_MS = 30_000;
const PROACTIVE_MIN_WEEKLY_HEADROOM = 15;
const PROACTIVE_MIN_SESSION_HEADROOM = 30;
const PROACTIVE_MIN_GAIN_MS = 6 * 3600_000;

/**
 * Pure routing policy.
 * 1. a pinned account wins while it is within thresholds
 * 2. sticky: keep `current` while it is within thresholds (except the guarded "perishable" move)
 * 3. otherwise the within-threshold account ranked first: soonest weekly reset (when preferSoonerReset),
 *    then most 5h headroom, then most weekly headroom, then name
 * 4. if nothing is within thresholds, the account with the most room on its tightest window (relaxed)
 * 5. otherwise none (the proxy fails open)
 */
export function pickAccount(input: RouteInput): RouteDecision {
  const now = input.now ?? Date.now();
  const exclude = input.exclude ?? new Set<string>();
  const elig = new Map<string, Eligibility>();
  for (const a of input.accounts) {
    elig.set(
      a.name,
      exclude.has(a.name)
        ? { tier: 0, eligible: false, reason: "exhausted", minHeadroom: 0 }
        : eligibility(a, input.policy, input.modelFamily, now, { assigned: a.name === input.current }),
    );
  }
  const tierOf = (n: string | null) => (n ? (elig.get(n)?.tier ?? 0) : 0);

  const { pinned } = input.policy;
  if (pinned && tierOf(pinned) === 1) {
    return {
      account: pinned,
      switched: input.current !== pinned,
      from: input.current,
      reason: input.current === pinned ? "sticky" : "pinned",
      earliestResetAt: null,
      relaxed: false,
    };
  }
  const rank = makeRank(input.policy, input.modelFamily, now, input.accounts);
  let tier1 = input.accounts.filter((a) => tierOf(a.name) === 1).sort(rank);
  // distribute: a random within-threshold account for each new session (the drain target still comes first)
  if (input.policy.distribute && tier1.length > 1 && tierOf(input.current) !== 1) {
    const drain = input.policy.drainAccount && tier1.find((a) => a.name === input.policy.drainAccount);
    if (!drain) {
      const r = (input.policy.random ?? Math.random)();
      const pick = tier1[Math.min(tier1.length - 1, Math.floor(r * tier1.length))];
      tier1 = [pick, ...tier1.filter((a) => a !== pick)];
    }
  }
  if (tierOf(input.current) === 1) {
    // Sticky, with one exception: another eligible account's weekly quota is about to expire unused.
    const perishableH = input.policy.perishableHours ?? 24;
    const cur = input.accounts.find((a) => a.name === input.current)!;
    const cand = tier1.find((a) => a.name !== input.current);
    const recentlySwitched =
      (input.lastSwitchAt != null && now - input.lastSwitchAt < PROACTIVE_MIN_INTERVAL_MS) ||
      (input.policy.lastProactiveMoveAt != null && now - input.policy.lastProactiveMoveAt < PROACTIVE_GLOBAL_GAP_MS);
    if (
      input.policy.preferSoonerReset !== false &&
      perishableH > 0 &&
      cand &&
      !recentlySwitched &&
      weeklyResetMs(cand, input.modelFamily, now) <= perishableH * 3600_000 &&
      weeklyResetMs(cur, input.modelFamily, now) - weeklyResetMs(cand, input.modelFamily, now) >= PROACTIVE_MIN_GAIN_MS &&
      weeklyHeadroom(cand, input.modelFamily) >= PROACTIVE_MIN_WEEKLY_HEADROOM &&
      headroom(cand.usage?.fiveHour.utilization ?? null) >= PROACTIVE_MIN_SESSION_HEADROOM
    ) {
      return { account: cand.name, switched: true, from: input.current, reason: "perishable", earliestResetAt: null, relaxed: false };
    }
    return { account: input.current, switched: false, from: input.current, reason: "sticky", earliestResetAt: null, relaxed: false };
  }
  if (tier1.length) {
    const to = tier1[0].name;
    const reason: RouteReason = input.current ? (elig.get(input.current)?.reason ?? "threshold") : "initial";
    return { account: to, switched: input.current !== to, from: input.current, reason, earliestResetAt: null, relaxed: false };
  }
  // Nothing within thresholds. Rather than stall, serve from whichever account has the most room left
  // on its tightest window. Stay on the current one if it is among them and no other has clearly more room.
  const tier2 = input.accounts
    .filter((a) => tierOf(a.name) === 2)
    .sort((a, b) => elig.get(b.name)!.minHeadroom - elig.get(a.name)!.minHeadroom || a.name.localeCompare(b.name));
  if (tier2.length) {
    const cur = input.current && tierOf(input.current) === 2 ? input.current : null;
    const best = tier2[0].name;
    const to = cur && elig.get(cur)!.minHeadroom >= elig.get(best)!.minHeadroom - 2 ? cur : best;
    return {
      account: to,
      switched: input.current !== to,
      from: input.current,
      reason: to === input.current ? "sticky" : "relaxed",
      earliestResetAt: null,
      relaxed: true,
    };
  }
  return { account: null, switched: false, from: input.current, reason: "none_eligible", earliestResetAt: earliestReset(input.accounts, now), relaxed: false };
}
