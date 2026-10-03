/**
 * Advice for applications built on cm: given the pool's current state, what should a session do next?
 * Pure. Used for response headers on every proxied request, GET /api/advice, and the model-fallback policy.
 */
import type { AccountState, Policy } from "./types.js";
import { eligibility } from "./router.js";
import { modelFamily } from "./claude-internals.js";

export interface PoolFamily {
  family: string;
  /** pooled account-% left across enabled accounts on this family's binding window (per-model weekly, else weekly) */
  headroom: number;
  /** enabled accounts that can still serve this family within thresholds */
  eligibleAccounts: number;
  /** earliest reset that adds headroom for this family, ISO */
  nextResetAt: string | null;
  /** account-% that reset frees */
  nextResetFrees: number;
}

export interface Advice {
  action: "continue" | "switch-model" | "pause";
  /** when action is switch-model: the family with the most pooled headroom */
  switchTo: string | null;
  /** when action is pause: ISO time when headroom returns */
  pauseUntil: string | null;
  reasons: string[];
}

export interface AdviceResult {
  at: number;
  model: string | null;
  family: string | null;
  session: {
    id: string | null;
    account: string | null;
    sessionHeadroom: number | null;
    sessionResetsAt: string | null;
    weeklyHeadroom: number | null;
    weeklyResetsAt: string | null;
    modelHeadroom: number | null;
    modelResetsAt: string | null;
  };
  pool: {
    session: { headroom: number; nextResetAt: string | null; nextResetFrees: number };
    weekly: { headroom: number; nextResetAt: string | null; nextResetFrees: number };
    families: PoolFamily[];
  };
  advice: Advice;
}

export interface AdviceInput {
  accounts: AccountState[];
  policy: Policy;
  model: string | null;
  sessionId: string | null;
  /** the account the session is assigned to, if any */
  sessionAccount: string | null;
  /** pooled headroom (account-%) below which a model counts as "almost gone" */
  approachingHeadroom: number;
  now?: number;
}

const h = (u: number | null | undefined) => (u === null || u === undefined ? 100 : Math.max(0, 100 - u));

function earliest(entries: Array<{ resetsAt: string | null; util: number | null }>, now: number): { at: string | null; frees: number } {
  let best: { t: number; frees: number } | null = null;
  for (const e of entries) {
    if (!e.resetsAt || !(e.util ?? 0)) continue;
    const t = Date.parse(e.resetsAt);
    if (!Number.isFinite(t) || t <= now) continue;
    if (!best || t < best.t) best = { t, frees: Math.min(100, e.util ?? 0) };
  }
  return best ? { at: new Date(best.t).toISOString(), frees: best.frees } : { at: null, frees: 0 };
}

export function computeAdvice(input: AdviceInput): AdviceResult {
  const now = input.now ?? Date.now();
  const live = input.accounts.filter((a) => !a.disabled && (a.tokenOk || a.hasInferenceToken));
  const family = modelFamily(input.model ?? undefined);

  const poolSession = earliest(
    live.map((a) => ({ resetsAt: a.usage?.fiveHour.resetsAt ?? null, util: a.usage?.fiveHour.utilization ?? null })),
    now,
  );
  const poolWeekly = earliest(
    live.map((a) => ({ resetsAt: a.usage?.sevenDay.resetsAt ?? null, util: a.usage?.sevenDay.utilization ?? null })),
    now,
  );
  const pool = {
    session: { headroom: live.reduce((t, a) => t + h(a.usage?.fiveHour.utilization), 0), nextResetAt: poolSession.at, nextResetFrees: poolSession.frees },
    weekly: { headroom: live.reduce((t, a) => t + h(a.usage?.sevenDay.utilization), 0), nextResetAt: poolWeekly.at, nextResetFrees: poolWeekly.frees },
    families: [] as PoolFamily[],
  };

  const familyKeys = new Set<string>();
  for (const a of live) for (const k of Object.keys(a.usage?.models ?? {})) familyKeys.add(k);
  if (family) familyKeys.add(family);
  for (const f of [...familyKeys].sort()) {
    // binding window for the family: its own weekly window when the server reports one, else the all-models weekly
    const per = live.map((a) => {
      const m = a.usage?.models[f];
      const util = m ? m.utilization : (a.usage?.sevenDay.utilization ?? null);
      const resetsAt = m?.resetsAt ?? a.usage?.sevenDay.resetsAt ?? null;
      return { util, resetsAt, headroom: Math.min(h(util), h(a.usage?.sevenDay.utilization), h(a.usage?.fiveHour.utilization)) };
    });
    const e = earliest(per, now);
    pool.families.push({
      family: f,
      headroom: per.reduce((t, p) => t + p.headroom, 0),
      eligibleAccounts: live.filter((a) => eligibility(a, input.policy, f, now).eligible).length,
      nextResetAt: e.at,
      nextResetFrees: e.frees,
    });
  }

  const acct = input.sessionAccount ? (live.find((a) => a.name === input.sessionAccount) ?? null) : null;
  const u = acct?.usage ?? null;
  const session = {
    id: input.sessionId,
    account: acct?.name ?? null,
    sessionHeadroom: u ? h(u.fiveHour.utilization) : null,
    sessionResetsAt: u?.fiveHour.resetsAt ?? null,
    weeklyHeadroom: u ? h(u.sevenDay.utilization) : null,
    weeklyResetsAt: u?.sevenDay.resetsAt ?? null,
    modelHeadroom: u && family ? h(u.models[family]?.utilization ?? u.sevenDay.utilization) : null,
    modelResetsAt: (u && family ? (u.models[family]?.resetsAt ?? u.sevenDay.resetsAt) : null) ?? null,
  };

  const reasons: string[] = [];
  let advice: Advice = { action: "continue", switchTo: null, pauseUntil: null, reasons };
  const mine = family ? (pool.families.find((f) => f.family === family) ?? null) : null;
  const alternatives = pool.families.filter((f) => f.family !== family && f.eligibleAccounts > 0).sort((a, b) => b.headroom - a.headroom);
  if (!live.length) {
    reasons.push("no usable accounts");
  } else if (pool.session.headroom <= 0) {
    reasons.push("every account's 5-hour window is full");
    advice = { action: "pause", switchTo: null, pauseUntil: pool.session.nextResetAt, reasons };
  } else if (mine && mine.eligibleAccounts === 0 && mine.headroom <= 0) {
    reasons.push(`no account has ${family} headroom left`);
    advice = alternatives.length
      ? { action: "switch-model", switchTo: alternatives[0].family, pauseUntil: mine.nextResetAt, reasons }
      : { action: "pause", switchTo: null, pauseUntil: mine.nextResetAt, reasons };
  } else if (mine && mine.headroom <= input.approachingHeadroom) {
    reasons.push(`pooled ${family} headroom is down to ${Math.round(mine.headroom)}% of one account`);
    advice =
      alternatives.length && alternatives[0].headroom > mine.headroom
        ? { action: "switch-model", switchTo: alternatives[0].family, pauseUntil: mine.nextResetAt, reasons }
        : { action: "continue", switchTo: null, pauseUntil: null, reasons };
  } else if (pool.session.headroom <= input.approachingHeadroom) {
    reasons.push(`pooled 5-hour headroom is down to ${Math.round(pool.session.headroom)}%`);
  } else {
    reasons.push("headroom available");
  }
  return { at: now, model: input.model, family, session, pool, advice };
}

/** Compact header form of the advice, added to every proxied response. */
export function adviceHeaders(r: AdviceResult): Record<string, string> {
  const secs = (iso: string | null) => (iso ? String(Math.max(0, Math.round((Date.parse(iso) - r.at) / 1000))) : "");
  const out: Record<string, string> = {};
  if (r.session.account) out["x-cm-account"] = r.session.account;
  if (r.session.sessionHeadroom !== null) out["x-cm-session-headroom"] = `${Math.round(r.session.sessionHeadroom)};reset=${secs(r.session.sessionResetsAt)}`;
  if (r.session.weeklyHeadroom !== null) out["x-cm-weekly-headroom"] = `${Math.round(r.session.weeklyHeadroom)};reset=${secs(r.session.weeklyResetsAt)}`;
  if (r.session.modelHeadroom !== null && r.family)
    out["x-cm-model-headroom"] = `${r.family}=${Math.round(r.session.modelHeadroom)};reset=${secs(r.session.modelResetsAt)}`;
  out["x-cm-pool-session-headroom"] = `${Math.round(r.pool.session.headroom)};reset=${secs(r.pool.session.nextResetAt)}`;
  out["x-cm-pool-model-headroom"] = r.pool.families
    .map((f) => `${f.family}=${Math.round(f.headroom)};accounts=${f.eligibleAccounts};reset=${secs(f.nextResetAt)}`)
    .join(",");
  const a = r.advice;
  out["x-cm-advice"] = a.action === "switch-model" ? `switch-model;to=${a.switchTo}` : a.action === "pause" ? `pause;until=${a.pauseUntil ?? ""}` : "continue";
  return out;
}
