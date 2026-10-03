/**
 * Quota attribution by session: which sessions (loops, agents, interactive) consumed the pool's quota.
 * Shares are by estimated cost, the same proxy used for the per-model runway; the measured pooled consumption
 * over the window (account-%) is split by those shares.
 */
export interface SessionUsageRow {
  sessionId: string;
  firstSeen: number;
  lastSeen: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
  accounts: string | null;
  models: string | null;
  firstPrompt: string | null;
  maxContext: number | null;
}

export interface SessionAttribution extends SessionUsageRow {
  /** share of the pool's consumption in the window, 0-1 */
  share: number;
  /** account-% of the shared weekly window attributed to this session */
  weeklyPct: number | null;
  /** account-% of 5-hour windows attributed to this session */
  sessionPct: number | null;
  /** per-family cost within the session, for the model mix */
  familyShare: Record<string, number>;
}

export interface AttributionInput {
  sessions: SessionUsageRow[];
  /** measured pooled consumption over the same window, account-% (null when unknown) */
  weeklyConsumed: number | null;
  sessionConsumed: number | null;
  /** cost per session per family, e.g. from a grouped query */
  familyCosts?: Record<string, Record<string, number>>;
}

export function attribute(input: AttributionInput): { sessions: SessionAttribution[]; totalCostUsd: number } {
  const total = input.sessions.reduce((t, s) => t + (s.estCostUsd ?? 0), 0);
  const sessions = input.sessions
    .map((s) => {
      const share = total > 0 ? (s.estCostUsd ?? 0) / total : 0;
      const fc = input.familyCosts?.[s.sessionId] ?? {};
      const fcTotal = Object.values(fc).reduce((a, b) => a + b, 0);
      return {
        ...s,
        share,
        weeklyPct: input.weeklyConsumed === null ? null : input.weeklyConsumed * share,
        sessionPct: input.sessionConsumed === null ? null : input.sessionConsumed * share,
        familyShare: Object.fromEntries(Object.entries(fc).map(([k, v]) => [k, fcTotal > 0 ? v / fcTotal : 0])),
      };
    })
    .sort((a, b) => b.share - a.share);
  return { sessions, totalCostUsd: total };
}
