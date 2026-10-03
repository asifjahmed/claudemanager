/**
 * Context-growth inspector for one session: how the prompt grew turn by turn, where the jumps came from,
 * and what the largest tool results in the latest prompt are. Pure over data the request log already holds.
 */
export interface TurnRow {
  id: number;
  startedAt: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  latencyMs: number | null;
  statusCode: number | null;
}

export interface Turn extends TurnRow {
  /** prompt tokens the model saw: uncached input + cache read + cache write */
  context: number;
  /** growth versus the previous turn */
  delta: number;
}

export interface ToolResultSize {
  toolUseId: string;
  tool: string | null;
  chars: number;
  preview: string;
}

export interface ContextReport {
  turns: Turn[];
  firstContext: number;
  lastContext: number;
  peakContext: number;
  /** turns with the largest growth */
  biggestJumps: Turn[];
  /** cache write tokens over the session: what was (re)built rather than reused */
  cacheWriteTotal: number;
  cacheReadTotal: number;
  /** from the latest stored prompt */
  latest: {
    systemChars: number;
    toolsCount: number;
    toolsChars: number;
    messages: number;
    largestToolResults: ToolResultSize[];
    totalToolResultChars: number;
  } | null;
}

export function contextReport(rows: TurnRow[], latestBody: { system: string | null; messages: unknown; tools: unknown } | null): ContextReport {
  const sorted = [...rows].filter((r) => r.statusCode === 200 || r.statusCode === null).sort((a, b) => a.startedAt - b.startedAt);
  let prev = 0;
  const turns: Turn[] = sorted.map((r) => {
    const context = (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
    const t = { ...r, context, delta: context - prev };
    prev = context;
    return t;
  });
  const biggestJumps = [...turns]
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5)
    .filter((t) => t.delta > 0);
  let latest: ContextReport["latest"] = null;
  if (latestBody) {
    const msgs = Array.isArray(latestBody.messages) ? (latestBody.messages as any[]) : [];
    const toolNames = new Map<string, string>();
    const results: ToolResultSize[] = [];
    for (const m of msgs) {
      const content = Array.isArray(m?.content) ? m.content : [];
      for (const c of content) {
        if (c?.type === "tool_use" && c.id) toolNames.set(c.id, c.name ?? null);
        if (c?.type === "tool_result") {
          const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
          results.push({ toolUseId: c.tool_use_id ?? "", tool: null, chars: text.length, preview: text.slice(0, 120) });
        }
      }
    }
    for (const r of results) r.tool = toolNames.get(r.toolUseId) ?? null;
    const tools = Array.isArray(latestBody.tools) ? (latestBody.tools as any[]) : [];
    latest = {
      systemChars: latestBody.system ? latestBody.system.length : 0,
      toolsCount: tools.length,
      toolsChars: JSON.stringify(tools).length,
      messages: msgs.length,
      largestToolResults: [...results].sort((a, b) => b.chars - a.chars).slice(0, 8),
      totalToolResultChars: results.reduce((t, r) => t + r.chars, 0),
    };
  }
  return {
    turns,
    firstContext: turns[0]?.context ?? 0,
    lastContext: turns[turns.length - 1]?.context ?? 0,
    peakContext: turns.reduce((m, t) => Math.max(m, t.context), 0),
    biggestJumps,
    cacheWriteTotal: turns.reduce((t, r) => t + (r.cacheWriteTokens ?? 0), 0),
    cacheReadTotal: turns.reduce((t, r) => t + (r.cacheReadTokens ?? 0), 0),
    latest,
  };
}
