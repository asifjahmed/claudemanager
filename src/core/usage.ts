import { USAGE_URL, OAUTH_BETA_HEADER, PROFILE_URL } from "./claude-internals.js";
import { VERSION } from "./version.js";
import type { Usage, WindowUsage } from "./types.js";

export class UsageError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
  }
}

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
interface RawUsage {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  seven_day_opus?: RawWindow | null;
  seven_day_sonnet?: RawWindow | null;
  seven_day_oauth_apps?: RawWindow | null;
  seven_day_cowork?: RawWindow | null;
  seven_day_overage_included?: RawWindow | null;
  model_scoped?: Array<{ display_name?: string; utilization?: number | null; resets_at?: string | null }> | null;
  /** Server limits[]: kind session | weekly_all | weekly_scoped (scope.model.display_name e.g. "Fable") */
  limits?: Array<{
    kind?: string;
    group?: string;
    percent?: number | null;
    severity?: string;
    resets_at?: string | null;
    scope?: { model?: { id?: string | null; display_name?: string | null } | null; surface?: string | null } | null;
    is_active?: boolean;
  }> | null;
  [k: string]: unknown;
}

function win(w: RawWindow | null | undefined): WindowUsage {
  return {
    utilization: typeof w?.utilization === "number" ? w.utilization : null,
    resetsAt: typeof w?.resets_at === "string" ? w.resets_at : null,
  };
}

export function normalizeUsage(raw: RawUsage, now = Date.now()): Usage {
  const models: Record<string, WindowUsage> = {};
  if (raw.seven_day_opus) models.opus = win(raw.seven_day_opus);
  if (raw.seven_day_sonnet) models.sonnet = win(raw.seven_day_sonnet);
  for (const m of raw.model_scoped ?? []) {
    if (!m?.display_name) continue;
    models[m.display_name.toLowerCase()] = win(m);
  }
  for (const l of raw.limits ?? []) {
    const name = l?.scope?.model?.display_name;
    if (l?.kind === "weekly_scoped" && name) {
      models[name.toLowerCase()] = {
        utilization: typeof l.percent === "number" ? l.percent : null,
        resetsAt: typeof l.resets_at === "string" ? l.resets_at : null,
      };
    }
  }
  const extra: Record<string, WindowUsage> = {};
  for (const k of ["seven_day_oauth_apps", "seven_day_cowork", "seven_day_overage_included"] as const) {
    if (raw[k]) extra[k] = win(raw[k] as RawWindow);
  }
  return {
    fiveHour: win(raw.five_hour),
    sevenDay: win(raw.seven_day),
    models,
    extra,
    fetchedAt: now,
    source: "poll",
  };
}

export async function fetchUsage(accessToken: string, fetchImpl: typeof fetch = fetch, url = USAGE_URL): Promise<{ usage: Usage; raw: unknown }> {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      Accept: "application/json",
      "User-Agent": `claudemanager/${VERSION}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.replace(/\s+/g, " ").slice(0, 120);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.error?.type ?? detail;
    } catch {
      /* keep raw */
    }
    throw new UsageError(`usage fetch failed: HTTP ${res.status} ${detail}`, res.status);
  }
  const raw = (await res.json()) as RawUsage;
  return { usage: normalizeUsage(raw), raw };
}

export interface Profile {
  email: string | null;
  orgName: string | null;
  subscriptionStatus: string | null;
  subscriptionCreatedAt: string | null;
  rateLimitTier: string | null;
  hasExtraUsage: boolean;
  /** derived: the next monthly anniversary of subscriptionCreatedAt (Stripe renews on that day); an estimate */
  nextBillingAt: string | null;
}

/** Next occurrence of the subscription's day-of-month, clamped to month length (Jan 31 → Feb 28). */
export function nextAnniversary(createdIso: string | null, now = Date.now()): string | null {
  if (!createdIso) return null;
  const created = new Date(createdIso);
  if (!Number.isFinite(created.getTime())) return null;
  const day = created.getUTCDate();
  const n = new Date(now);
  for (let k = 0; k < 3; k++) {
    const y = n.getUTCFullYear();
    const m = n.getUTCMonth() + k;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cand = new Date(Date.UTC(y, m, Math.min(day, last), created.getUTCHours(), created.getUTCMinutes()));
    if (cand.getTime() > now) return cand.toISOString();
  }
  return null;
}

export async function fetchProfile(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<Profile> {
  const res = await fetchImpl(PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      Accept: "application/json",
      "User-Agent": `claudemanager/${VERSION}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new UsageError(`profile fetch failed: HTTP ${res.status}`, res.status);
  const j: any = await res.json();
  const created = j?.organization?.subscription_created_at ?? null;
  return {
    email: j?.account?.email ?? null,
    orgName: j?.organization?.name ?? null,
    subscriptionStatus: j?.organization?.subscription_status ?? null,
    subscriptionCreatedAt: created,
    rateLimitTier: j?.organization?.rate_limit_tier ?? null,
    hasExtraUsage: !!j?.organization?.has_extra_usage_enabled,
    nextBillingAt: nextAnniversary(created),
  };
}
