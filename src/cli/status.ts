import { loadConfig } from "../core/config.js";
import { getFreshToken, CredentialError } from "../core/credentials.js";
import { getInferenceToken } from "../core/inference-token.js";
import { fetchUsage } from "../core/usage.js";
import { AccountStore } from "../core/accounts.js";
import { eligibility } from "../core/router.js";
import { api, daemonAlive } from "./client.js";
import { c, bar, relMs, relTime, ago, pad } from "./render.js";
import type { AccountState } from "../core/types.js";

export interface StateLike {
  current: string | null;
  pinned: string | null;
  policy: { threshold: number; weeklyThreshold: number; pinned: string | null };
  accounts: Array<AccountState & { eligible?: boolean; ineligibleReason?: string | null; configDir?: string | null }>;
  events?: any[];
  sessions?: Record<string, number>;
  daemon: boolean;
  now: number;
  version?: string;
  db?: { requests: number; sizeMb: number } | null;
}

/** Fetch state from the daemon, or poll every account directly if the daemon is down. */
export async function getState(opts: { direct?: boolean } = {}): Promise<StateLike> {
  if (!opts.direct && (await daemonAlive())) {
    const s = await api("/api/state");
    return { ...s, daemon: true };
  }
  const cfg = loadConfig();
  const store = new AccountStore(cfg.accounts);
  await Promise.all(
    cfg.accounts.map(async (a) => {
      const st = store.get(a.name)!;
      if (a.disabled) return;
      st.hasInferenceToken = !!(await getInferenceToken(a.name));
      try {
        const creds = await getFreshToken(a.configDir);
        st.tokenExpiresAt = creds.expiresAt;
        st.tier = creds.rateLimitTier ?? null;
        st.subscriptionType = creds.subscriptionType ?? st.subscriptionType;
        const { usage } = await fetchUsage(creds.accessToken);
        store.setUsage(a.name, usage);
      } catch (err: any) {
        if (err instanceof CredentialError && err.code !== "held" && err.code !== "network") st.tokenOk = false;
        if (err instanceof CredentialError && err.needsLogin) st.needsLogin = true;
        store.setError(a.name, err.message);
      }
    }),
  );
  const policy = { threshold: cfg.threshold, weeklyThreshold: cfg.weeklyThreshold, pinned: cfg.pinned };
  const now = Date.now();
  return {
    current: null,
    pinned: cfg.pinned,
    policy,
    accounts: store.all().map((a) => {
      const e = eligibility(a, policy, null, now);
      return { ...a, eligible: e.eligible, ineligibleReason: e.reason, configDir: cfg.accounts.find((x) => x.name === a.name)?.configDir ?? null };
    }),
    daemon: false,
    now,
  };
}

function planLabel(a: { tier: string | null; subscriptionType: string | null }): string {
  const m = /max_(\d+)x/.exec(a.tier ?? "");
  if (m) return `Max (${m[1]}x)`;
  if (a.subscriptionType) return a.subscriptionType[0].toUpperCase() + a.subscriptionType.slice(1);
  return "";
}

function stateLabel(a: StateLike["accounts"][number], now: number): string {
  if (a.disabled) return c.dim("disabled");
  if (a.needsLogin && a.hasInferenceToken)
    return c.green("routing ok") + c.yellow(`  ·  no usage login (weekly and per-model numbers unavailable) → cm accounts login ${a.name}`);
  if (a.needsLogin) return c.red(`needs re-login → cm accounts login ${a.name}`);
  if (!a.tokenOk) return c.red("auth error");
  if (a.exhaustedUntil && a.exhaustedUntil > now) return c.red(`exhausted · resets in ${relMs(a.exhaustedUntil, now)}`);
  if (a.eligible === false && (a as any).eligibilityTier === 2) return c.yellow(`over ${a.ineligibleReason ?? "limit"} threshold`) + c.dim(" · fallback only");
  if (a.eligible === false) return c.red(`${a.ineligibleReason ?? "limit"} at 100%`);
  if (a.lastError && /rate-limited/.test(a.lastError)) return c.dim("ok · poll backoff");
  if (a.lastError) return c.yellow(`error: ${a.lastError.replace(/\s+/g, " ").slice(0, 60)}`);
  if (!a.usage) return c.dim("no data yet");
  return c.green("ok");
}

export function renderStatus(s: StateLike, opts: { now?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const th = s.policy.threshold;
  const wth = s.policy.weeklyThreshold;
  const width = 24;
  const lines: string[] = [];
  const row = (label: string, w: { utilization: number | null; resetsAt: string | null } | null | undefined, threshold: number) => {
    const b = w ? bar(w.utilization, width, threshold) : c.dim("░".repeat(width) + "      n/a");
    const reset = w?.resetsAt ? `Resets in ${relTime(w.resetsAt, now)}` : w && w.utilization === 0 ? "Not started" : "";
    return `  ${pad(label, 18)}${b}   ${c.dim(reset)}`;
  };
  for (const a of s.accounts) {
    const n = s.sessions?.[a.name] ?? 0;
    const isActive = n > 0 || (!s.sessions && a.name === s.current);
    const marker = isActive ? c.green("●") : a.name === s.pinned ? c.magenta("●") : c.dim("○");
    const title = isActive ? c.bold(a.name) : a.name;
    const tags = [
      n > 0 ? c.green(`${n} active session${n === 1 ? "" : "s"}`) : !s.sessions && a.name === s.current ? c.green("active") : "",
      a.name === s.pinned ? c.magenta("pinned") : "",
      a.hasInferenceToken ? c.dim("long-lived token") : "",
    ]
      .filter(Boolean)
      .join(" ");
    const bill = a.profile?.nextBillingAt
      ? c.dim(
          `renews ~${new Date(a.profile.nextBillingAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}${a.profile.subscriptionStatus && a.profile.subscriptionStatus !== "active" ? ` (${a.profile.subscriptionStatus})` : ""}`,
        )
      : "";
    const head = `${marker} ${title}  ${c.dim(a.email ?? "")}  ${c.cyan(planLabel(a))}  ${bill}  ${tags}`.replace(/\s+$/, "");
    const updated = a.usage ? `Last updated: ${ago(a.usage.fetchedAt, now)}${a.usage.source === "headers" ? " (live)" : ""}` : "";
    lines.push(head);
    lines.push(row("Current session", a.usage?.fiveHour, th));
    lines.push(row("All models (7d)", a.usage?.sevenDay, wth));
    for (const k of Object.keys(a.usage?.models ?? {}).sort()) {
      lines.push(row(`${k[0].toUpperCase()}${k.slice(1)} (7d)`, a.usage!.models[k], wth));
    }
    lines.push(`  ${c.dim(updated)}${updated ? "   " : ""}${stateLabel(a, now)}`);
    lines.push("");
  }
  if (!s.accounts.length) lines.push(c.dim("no accounts. run: cm accounts add <name>"), "");
  const src = s.daemon ? `daemon on :${(s as any).port ?? "?"}` : c.yellow("daemon not running (direct poll)");
  const total = s.sessions ? Object.values(s.sessions).reduce((a, b) => a + b, 0) : 0;
  const cur = s.sessions ? `${total} active session${total === 1 ? "" : "s"}` : s.current ? `active: ${c.bold(s.current)}` : "active: –";
  lines.push(
    c.dim(`${cur}  ·  switch at ${th}% session / ${wth}% weekly  ·  ${src}${s.db ? `  ·  ${s.db.requests} requests logged (${s.db.sizeMb} MB)` : ""}`),
  );
  return lines.join("\n");
}

export function renderEvents(events: any[], limit = 8): string {
  const recent = events.slice(-limit);
  if (!recent.length) return c.dim("no events yet");
  return recent
    .map((e) => {
      const t = new Date(e.at).toLocaleTimeString();
      switch (e.type) {
        case "switch":
          return `${c.dim(t)} ${e.reason === "relaxed" ? c.yellow("switch (no account within thresholds)") : e.reason === "perishable" ? c.cyan("switch (quota resets soon)") : c.cyan("switch")} ${e.session ? c.dim(`session ${e.session.slice(0, 8)} `) : ""}${e.from ?? "(none)"} → ${c.bold(e.to)} ${c.dim(`(${e.reason})`)}`;
        case "exhausted":
          return `${c.dim(t)} ${c.red("exhausted")} ${e.account} ${c.dim(`(${e.claim ?? "?"}, until ${relMs(e.until)})`)}`;
        case "all_exhausted":
          return `${c.dim(t)} ${c.red("ALL EXHAUSTED")} ${c.dim(`earliest reset ${relMs(e.earliestResetAt)}`)}`;
        case "assign":
          return `${c.dim(t)} ${c.dim("session")} ${e.session.slice(0, 8)} → ${c.bold(e.account)}${e.relaxed ? c.yellow(" (over threshold, best available)") : ""}`;
        case "limit":
          return e.kind === "reset"
            ? `${c.dim(t)} ${c.green("reset")} ${e.account} ${e.window} ${c.dim(`(+${Math.round(e.freed)}%)`)}`
            : `${c.dim(t)} ${e.kind === "recovered" ? c.green("recovered") : e.kind === "exhausted" ? c.red("exhausted") : c.yellow("approaching")} ${c.bold(e.family)} ${c.dim(`pooled ${Math.round(e.headroom)}%${e.nextResetAt ? `, next reset ${relTime(e.nextResetAt)}` : ""}`)}`;
        case "free_reset":
          return `${c.dim(t)} ${e.kind === "used" ? c.green("free reset used") : c.magenta("FREE RESET: use it now")} ${c.bold(e.account)} ${c.dim(e.detail)}`;
        case "model_fallback":
          return `${c.dim(t)} ${c.magenta("model fallback")} ${e.from} → ${c.bold(e.to)} ${c.dim(`session ${(e.session ?? "?").slice(0, 8)}, ${e.reason}`)}`;
        case "fallback":
          return `${c.dim(t)} ${c.red("FAIL-OPEN")} ${e.reason}; requests use the caller's own login`;
        case "error":
          return `${c.dim(t)} ${c.yellow("error")} ${e.account ?? ""} ${String(e.message).replace(/\s+/g, " ").slice(0, 110)}`;
        default:
          return `${c.dim(t)} ${e.type}`;
      }
    })
    .join("\n");
}
