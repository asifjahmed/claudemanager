export interface WindowUsage {
  /** percent 0-100 (may exceed 100 for overage) or null when unknown */
  utilization: number | null;
  /** ISO-8601 or null */
  resetsAt: string | null;
}

export interface Usage {
  fiveHour: WindowUsage;
  sevenDay: WindowUsage;
  /** keyed by lowercased family name: fable, opus, sonnet, ... */
  models: Record<string, WindowUsage>;
  extra?: Record<string, WindowUsage>;
  fetchedAt: number;
  source: "poll" | "headers";
}

export interface AccountConfig {
  name: string;
  configDir: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  disabled?: boolean;
}

export interface AccountState {
  name: string;
  email: string | null;
  orgName: string | null;
  /** e.g. default_claude_max_20x */
  tier: string | null;
  /** from the profile endpoint, refreshed daily */
  profile: {
    subscriptionStatus: string | null;
    subscriptionCreatedAt: string | null;
    nextBillingAt: string | null;
    hasExtraUsage: boolean;
    fetchedAt: number;
  } | null;
  subscriptionType: string | null;
  disabled: boolean;
  usage: Usage | null;
  exhaustedUntil: number | null;
  tokenExpiresAt: number | null;
  tokenOk: boolean;
  /** the stored login is dead; only `cm accounts login <name>` fixes it */
  needsLogin: boolean;
  /** a long-lived `claude setup-token` token is stored for the traffic path */
  hasInferenceToken: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  lastStatus: string | null;
  representativeClaim: string | null;
  lastUsedAt: number | null;
  requestCount: number;
}

export interface Policy {
  threshold: number;
  weeklyThreshold: number;
  pinned: string | null;
  /** rank eligible accounts by soonest weekly reset first (spend perishable quota first) */
  preferSoonerReset?: boolean;
  /** proactively move to an account whose weekly window resets within this many hours */
  perishableHours?: number;
  /** send models without their own window (Sonnet/Opus/Haiku) to accounts whose scarce per-model windows (Fable) are most spent */
  modelAware?: boolean;
  /** fill this account first (free-reset concentrate mode); only while it is within thresholds */
  drainAccount?: string | null;
  /** assign each new session to a random within-threshold account instead of the ranked first */
  distribute?: boolean;
  /** injectable randomness for tests */
  random?: () => number;
  /** hysteresis: an assigned session stays until its account's 5-hour window reaches this (>= threshold) */
  ejectThreshold?: number;
  /** global gate for proactive (perishable) moves: when the pool last made one */
  lastProactiveMoveAt?: number | null;
}

export type RouteReason =
  "sticky" | "pinned" | "initial" | "threshold" | "exhausted" | "weekly" | "model_weekly" | "error" | "disabled" | "relaxed" | "perishable" | "manual";

export interface RouteDecision {
  account: string | null;
  switched: boolean;
  from: string | null;
  reason: RouteReason | "none_eligible";
  earliestResetAt: number | null;
  /** true when every account is over a switch threshold and the pick is the least-bad one */
  relaxed: boolean;
}

export type CmEvent =
  | { type: "usage"; at: number; account: string; usage: Usage }
  | { type: "switch"; at: number; from: string | null; to: string; reason: string; session?: string }
  | { type: "assign"; at: number; session: string; account: string; relaxed: boolean }
  | { type: "exhausted"; at: number; account: string; until: number | null; claim: string | null }
  | { type: "all_exhausted"; at: number; earliestResetAt: number | null; cause?: "limits" | "auth" | "disabled" | "none" }
  | { type: "error"; at: number; account: string | null; message: string }
  | { type: "fallback"; at: number; reason: string }
  | ({ type: "limit"; at: number } & import("./limits.js").LimitEvent)
  | { type: "free_reset"; at: number; account: string; kind: "used" | "recommended"; detail: string }
  | { type: "model_fallback"; at: number; session: string | null; account: string | null; from: string; to: string; reason: string }
  | { type: "request"; at: number; request: RequestSummary }
  | { type: "state"; at: number };

export interface RequestSummary {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  latencyMs: number | null;
  account: string | null;
  model: string | null;
  sessionId: string | null;
  statusCode: number | null;
  stream: boolean;
  retried: boolean;
  switchedFrom: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  stopReason: string | null;
  error: string | null;
  estCostUsd: number | null;
  lastUserText?: string | null;
  /** ms from request arrival to upstream dispatch (the proxy's own cost) */
  overheadMs?: number | null;
  /** ms from upstream dispatch to response headers */
  ttfbMs?: number | null;
  /** model the caller asked for when the proxy applied a model fallback */
  modelFallbackFrom?: string | null;
}
