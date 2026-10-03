/**
 * The one-time free session reset Anthropic offered per account (usable until a deadline): it zeroes the account's
 * 5-hour and weekly windows immediately without changing the natural reset schedule.
 *
 * A free reset is worth exactly the quota you would otherwise have been blocked from using before the natural
 * reset: gain = min(utilization wiped, demand until the natural reset that would not have fit). So it is worth
 * the most when an account is nearly full and its natural reset is still far away, and worth nothing when it
 * resets naturally tomorrow. The planner projects each unused account forward at the observed burn and names the
 * moment (and the date) when the gain peaks before the deadline. "Concentrate" routing fills one account at a
 * time so that moment arrives early and the gain is a full window.
 */
export interface FreeResetAccount {
  account: string;
  /** highest of the weekly windows (all-models, per-model) — the one the reset would free the most of */
  weeklyUtil: number | null;
  /** which window that is */
  bindingWindow: string;
  weeklyResetsAt: string | null;
  fiveHourUtil: number | null;
  /** this account's own weekly burn, account-% per hour */
  ownBurnPerHour: number | null;
  /** ISO times the reset was used on this account */
  used: string[];
  disabled: boolean;
}

export interface FreeResetInput {
  offerId: string;
  usesPerAccount: number;
  accounts: FreeResetAccount[];
  deadline: string;
  /** pooled weekly burn, account-% per hour: what one account would receive if all traffic were concentrated on it */
  pooledBurnPerHour: number | null;
  concentrate: boolean;
  minUtil: number;
  minHoursBeforeNaturalReset: number;
  now?: number;
}

export interface FreeResetPlan {
  account: string;
  status: "used" | "reset-now" | "scheduled" | "low-value" | "expired" | "unknown";
  used: string[];
  usesLeft: number;
  weeklyUtil: number | null;
  bindingWindow: string;
  weeklyResetsAt: string | null;
  /** gain if reset right now, account-% of a week */
  gainNow: number | null;
  /** projected best moment before the deadline */
  bestAt: string | null;
  gainAtBest: number | null;
  /** utilization expected at that moment */
  utilAtBest: number | null;
  /** hours that will remain before the natural reset at that moment */
  hoursBeforeNaturalAtBest: number | null;
  reason: string;
}

export interface FreeResetResult {
  offerId: string;
  deadline: string;
  /** every enabled account has used all its resets, or the deadline passed: nothing left to plan */
  complete: boolean;
  hoursToDeadline: number;
  concentrate: boolean;
  /** the account concentrate-routing should fill next (unused, furthest natural reset), or null */
  drainTarget: string | null;
  plans: FreeResetPlan[];
  summary: string;
}

const H = 3600_000;
const WEEK_H = 7 * 24;

/** extra quota usable before the natural reset if the window is wiped at utilization u with t hours left at rate b */
function gain(u: number, hoursLeft: number, burn: number | null): number {
  if (burn === null || burn <= 0) return 0;
  const demand = burn * hoursLeft;
  const wouldFit = 100 - u;
  return Math.max(0, Math.min(u, demand - wouldFit));
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString();
}

export function planFreeResets(input: FreeResetInput): FreeResetResult {
  const now = input.now ?? Date.now();
  const deadlineMs = Date.parse(input.deadline);
  const hoursToDeadline = (deadlineMs - now) / H;
  const plans: FreeResetPlan[] = [];
  for (const a of input.accounts) {
    const usesLeft = Math.max(0, input.usesPerAccount - a.used.length);
    const base: Omit<FreeResetPlan, "status" | "reason"> = {
      account: a.account,
      used: a.used,
      usesLeft,
      weeklyUtil: a.weeklyUtil,
      bindingWindow: a.bindingWindow,
      weeklyResetsAt: a.weeklyResetsAt,
      gainNow: null,
      bestAt: null,
      gainAtBest: null,
      utilAtBest: null,
      hoursBeforeNaturalAtBest: null,
    };
    if (usesLeft === 0) {
      plans.push({ ...base, status: "used", reason: `used ${a.used[a.used.length - 1]?.slice(0, 10) ?? ""}` });
      continue;
    }
    if (hoursToDeadline <= 0) {
      plans.push({ ...base, status: "expired", reason: "the offer deadline has passed" });
      continue;
    }
    if (a.weeklyUtil === null || !a.weeklyResetsAt) {
      plans.push({ ...base, status: "unknown", reason: "no usage data for this account yet" });
      continue;
    }
    // the burn this account will see: everything, if concentrating on it; otherwise its own recent pace
    const burn = input.concentrate && input.pooledBurnPerHour !== null ? input.pooledBurnPerHour : (a.ownBurnPerHour ?? input.pooledBurnPerHour ?? null);
    const naturalMs = Date.parse(a.weeklyResetsAt);
    const hoursToNatural = Math.max(0, (naturalMs - now) / H);
    const gainNow = gain(a.weeklyUtil, hoursToNatural, burn);
    base.gainNow = gainNow;

    // walk forward hour by hour to the deadline through natural resets; track the best moment
    let best = { at: now, gainv: gainNow, util: a.weeklyUtil, left: hoursToNatural };
    let u = a.weeklyUtil;
    let nextNatural = naturalMs;
    const horizon = Math.min(deadlineMs, now + 6 * WEEK_H * H);
    if (burn && burn > 0) {
      for (let t = now + H; t <= horizon; t += H) {
        if (t >= nextNatural) {
          u = 0;
          nextNatural += WEEK_H * H;
        }
        u = Math.min(100, u + burn);
        const left = (nextNatural - t) / H;
        const g = gain(u, left, burn);
        if (g > best.gainv + 0.5) best = { at: t, gainv: g, util: u, left };
        // once the window is full and the natural reset is still far, later moments cannot beat this one
        if (u >= 100 && left >= input.minHoursBeforeNaturalReset && g >= best.gainv) break;
      }
    }
    base.bestAt = fmtDate(best.at);
    base.gainAtBest = best.gainv;
    base.utilAtBest = best.util;
    base.hoursBeforeNaturalAtBest = best.left;

    const readyNow = a.weeklyUtil >= input.minUtil && hoursToNatural >= input.minHoursBeforeNaturalReset;
    if (readyNow) {
      plans.push({
        ...base,
        status: "reset-now",
        reason: `${a.bindingWindow} at ${Math.round(a.weeklyUtil)}% with ${Math.round((hoursToNatural / 24) * 10) / 10} days before its natural reset: resetting now frees ~${Math.round(gainNow)}% of a week you could not otherwise use`,
      });
    } else if (best.gainv >= 25 && best.at > now) {
      const d = Math.round(((best.at - now) / H / 24) * 10) / 10;
      plans.push({
        ...base,
        status: "scheduled",
        reason: `reset around ${base.bestAt.slice(0, 16).replace("T", " ")} UTC (${d} d from now), when ${a.bindingWindow} reaches ~${Math.round(best.util)}% with ${Math.round((best.left / 24) * 10) / 10} days still to go: worth ~${Math.round(best.gainv)}% of a week${input.concentrate ? "" : " at this account's own pace; concentrating traffic on it gets there sooner"}`,
      });
    } else if (gainNow > 0) {
      plans.push({
        ...base,
        status: "low-value",
        reason: `worth only ~${Math.round(gainNow)}% now and no better moment is projected before the deadline; use it before ${input.deadline.slice(0, 10)} rather than lose it`,
      });
    } else {
      plans.push({
        ...base,
        status: "low-value",
        reason: `at the current pace this account never fills before a natural reset, so the free reset gains nothing; use it right before the deadline anyway, or concentrate traffic on it`,
      });
    }
  }
  // drain target: an unused account, prefer one already well along (finish what was started), else the one whose natural reset is furthest away
  const candidates = input.accounts.filter((a) => a.used.length < input.usesPerAccount && !a.disabled && a.weeklyResetsAt);
  const started = candidates
    .filter((a) => (a.weeklyUtil ?? 0) >= 40 && (Date.parse(a.weeklyResetsAt!) - now) / H >= input.minHoursBeforeNaturalReset)
    .sort((x, y) => (y.weeklyUtil ?? 0) - (x.weeklyUtil ?? 0));
  const drainTarget = started[0]?.account ?? candidates.sort((x, y) => Date.parse(y.weeklyResetsAt!) - Date.parse(x.weeklyResetsAt!))[0]?.account ?? null;
  const now_ = plans.filter((p) => p.status === "reset-now").map((p) => p.account);
  const enabledPlans = plans.filter((p) => !input.accounts.find((a) => a.account === p.account)?.disabled);
  const used = enabledPlans.filter((p) => p.status === "used").length;
  const complete = hoursToDeadline <= 0 || (enabledPlans.length > 0 && enabledPlans.every((p) => p.status === "used"));
  const summary = complete
    ? hoursToDeadline <= 0
      ? "offer ended"
      : "all resets used"
    : now_.length
      ? `Reset ${now_.join(", ")} now.`
      : `${used}/${enabledPlans.length} used · ${Math.round(hoursToDeadline / 24)} days to the deadline${drainTarget && input.concentrate ? ` · filling ${drainTarget} first` : ""}`;
  return {
    offerId: input.offerId,
    deadline: input.deadline,
    hoursToDeadline,
    complete,
    concentrate: input.concentrate,
    drainTarget: input.concentrate && !complete ? drainTarget : null,
    plans,
    summary,
  };
}

/**
 * Detect a free reset from usage updates: the weekly window dropped sharply while its natural reset time was still
 * in the future (a natural reset also moves resets_at forward; a free one does not).
 */
export class FreeResetDetector {
  private last = new Map<string, { util: number | null; resetsAt: string | null }>();
  update(account: string, weeklyUtil: number | null, weeklyResetsAt: string | null, now = Date.now()): boolean {
    const prev = this.last.get(account);
    this.last.set(account, { util: weeklyUtil, resetsAt: weeklyResetsAt });
    if (!prev || prev.util === null || weeklyUtil === null || !prev.resetsAt) return false;
    const dropped = weeklyUtil < prev.util - 30;
    const naturalStillAhead = Date.parse(prev.resetsAt) - now > 30 * 60_000;
    const scheduleUnchanged = !weeklyResetsAt || Math.abs(Date.parse(weeklyResetsAt) - Date.parse(prev.resetsAt)) < 6 * H;
    return dropped && naturalStillAhead && scheduleUnchanged;
  }
}
