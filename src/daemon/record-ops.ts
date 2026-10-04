/**
 * The recording work itself: parse a request body, assemble a response, write both to SQLite.
 * Runs inside the DB worker thread in production; the same functions run inline in tests.
 */
import type { Db, RequestFinish } from "../core/db.js";
import type { CmEvent, RequestSummary, Usage } from "../core/types.js";
import { modelFamily, parseUserIdMetadata } from "../core/claude-internals.js";

import type { Config } from "../core/config.js";
export type BodyMode = Config["log"]["bodies"];
export type Prices = Config["prices"];

export interface StartMsg {
  op: "start";
  id: number;
  startedAt: number;
  path: string;
  model: string | null;
  stream: boolean;
  sessionId: string | null;
  accountUuid: string | null;
  mode: BodyMode;
  /** raw request JSON, transferred */
  raw: ArrayBuffer | null;
  modelFallbackFrom: string | null;
}
export interface FinishMsg {
  op: "finish";
  id: number;
  startedAt: number;
  finishedAt: number;
  stream: boolean;
  mode: BodyMode;
  model: string | null;
  account: string | null;
  statusCode: number | null;
  error: string | null;
  switchedFrom: string | null;
  retried: boolean;
  overheadMs: number | null;
  ttfbMs: number | null;
  rl: RequestFinish["rl"];
  prices: Prices;
  /** raw response bytes (SSE or JSON), transferred; null when nothing was captured */
  raw: ArrayBuffer | null;
  /** echoed back so the main thread can publish the request event */
  sessionId: string | null;
  modelFallbackFrom: string | null;
}
export interface SnapshotMsg {
  op: "snapshot";
  account: string;
  usage: Usage;
}
export interface EventMsg {
  op: "event";
  event: CmEvent;
}
export interface PruneMsg {
  op: "prune";
  retentionDays: number;
  maxDbMb: number;
}
export interface FlushMsg {
  op: "flush";
  seq: number;
}
export type WriteMsg = StartMsg | FinishMsg | SnapshotMsg | EventMsg | PruneMsg | FlushMsg;

export type ReplyMsg =
  | { op: "recorded"; summary: RequestSummary }
  | { op: "pruned"; deletedRequests: number; deletedBodies: number }
  | { op: "flushed"; seq: number }
  | { op: "error"; message: string };

export interface ParsedRequestBody {
  model: string | null;
  stream: boolean;
  system: string | null;
  messages: unknown;
  tools: unknown;
  params: Record<string, unknown>;
  lastUserText: string | null;
  sessionId: string | null;
  accountUuid: string | null;
}

/** Claude Code sends its session id as a request header; metadata.user_id is the fallback. */
export function sessionIdFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const v = headers["x-claude-code-session-id"];
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^[0-9a-f-]{36}$/i.test(s) ? s : null;
}

export function parseRequestBody(json: any, headers: Record<string, string | string[] | undefined> = {}): ParsedRequestBody {
  const messages = Array.isArray(json?.messages) ? json.messages : null;
  let lastUserText: string | null = null;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "user") continue;
      lastUserText = contentToText(m.content);
      if (lastUserText) break;
    }
  }
  const { model, stream, system, messages: _m, tools, ...params } = json ?? {};
  const meta = parseUserIdMetadata(params?.metadata?.user_id);
  const sessionId = sessionIdFromHeaders(headers) ?? meta.sessionId;
  return {
    model: typeof model === "string" ? model : null,
    stream: !!stream,
    system: system == null ? null : typeof system === "string" ? system : contentToText(system),
    messages,
    tools: Array.isArray(tools) ? tools : null,
    params,
    lastUserText,
    sessionId,
    accountUuid: meta.accountUuid,
  };
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === "string") parts.push(c);
    else if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c?.type === "tool_result") {
      const t = contentToText(c.content);
      if (t) parts.push(`[tool_result] ${t}`);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

/** Accumulates a streamed or plain /v1/messages response into a content array + usage. */
export class ResponseAccumulator {
  private buf = "";
  private blocks: any[] = [];
  private jsonText: string[] = [];
  usage: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null } = {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
  };
  stopReason: string | null = null;
  error: string | null = null;
  bytes = 0;
  constructor(
    private readonly stream: boolean,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) return;
    if (!this.stream) {
      this.jsonText.push(chunk.toString("utf8"));
      return;
    }
    this.buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const frame = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: string): void {
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) data += line.slice(5).trimStart();
    }
    if (!data) return;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    switch (ev?.type) {
      case "message_start": {
        const u = ev.message?.usage ?? {};
        this.usage.input = u.input_tokens ?? this.usage.input;
        this.usage.cacheRead = u.cache_read_input_tokens ?? this.usage.cacheRead;
        this.usage.cacheWrite = u.cache_creation_input_tokens ?? this.usage.cacheWrite;
        this.usage.output = u.output_tokens ?? this.usage.output;
        break;
      }
      case "content_block_start": {
        const b = { ...(ev.content_block ?? {}) };
        if (b.type === "tool_use") b._json = "";
        if (b.type === "text") b.text = b.text ?? "";
        if (b.type === "thinking") b.thinking = b.thinking ?? "";
        this.blocks[ev.index] = b;
        break;
      }
      case "content_block_delta": {
        const b = this.blocks[ev.index];
        if (!b) break;
        const d = ev.delta ?? {};
        if (d.type === "text_delta") b.text = (b.text ?? "") + (d.text ?? "");
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + (d.thinking ?? "");
        else if (d.type === "input_json_delta") b._json = (b._json ?? "") + (d.partial_json ?? "");
        else if (d.type === "signature_delta") b.signature = d.signature;
        break;
      }
      case "content_block_stop": {
        const b = this.blocks[ev.index];
        if (b && typeof b._json === "string") {
          try {
            b.input = b._json ? JSON.parse(b._json) : {};
          } catch {
            b.input_raw = b._json;
          }
          delete b._json;
        }
        break;
      }
      case "message_delta": {
        this.stopReason = ev.delta?.stop_reason ?? this.stopReason;
        const u = ev.usage ?? {};
        if (typeof u.output_tokens === "number") this.usage.output = u.output_tokens;
        if (typeof u.input_tokens === "number") this.usage.input = u.input_tokens;
        if (typeof u.cache_read_input_tokens === "number") this.usage.cacheRead = u.cache_read_input_tokens;
        if (typeof u.cache_creation_input_tokens === "number") this.usage.cacheWrite = u.cache_creation_input_tokens;
        break;
      }
      case "error": {
        this.error = JSON.stringify(ev.error ?? ev);
        break;
      }
    }
  }

  finish(): { content: unknown; textPreview: string | null; rawError: string | null } {
    if (!this.stream) {
      const text = this.jsonText.join("");
      try {
        const j = JSON.parse(text);
        if (j?.type === "error" || j?.error) {
          this.error = JSON.stringify(j.error ?? j);
          return { content: null, textPreview: null, rawError: this.error };
        }
        const u = j.usage ?? {};
        this.usage = {
          input: u.input_tokens ?? null,
          output: u.output_tokens ?? null,
          cacheRead: u.cache_read_input_tokens ?? null,
          cacheWrite: u.cache_creation_input_tokens ?? null,
        };
        this.stopReason = j.stop_reason ?? null;
        this.blocks = Array.isArray(j.content) ? j.content : [];
      } catch {
        return { content: null, textPreview: null, rawError: text.slice(0, 2000) || null };
      }
    } else if (this.buf.trim()) {
      this.handleFrame(this.buf);
      this.buf = "";
    }
    const content = this.blocks.filter(Boolean);
    const preview = content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .slice(0, 4000);
    return { content, textPreview: preview || null, rawError: this.error };
  }
}

export function estimateCost(prices: Prices, model: string | null, u: ResponseAccumulator["usage"]): number | null {
  const fam = modelFamily(model ?? undefined);
  if (!fam) return null;
  const p = prices[fam];
  if (!p) return null;
  const m = 1_000_000;
  return ((u.input ?? 0) * p.input + (u.output ?? 0) * p.output + (u.cacheRead ?? 0) * p.cacheRead + (u.cacheWrite ?? 0) * p.cacheWrite) / m;
}

function lastTurn(messages: unknown): unknown {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return messages.slice(i);
  return messages.slice(-1);
}

/** Apply one write message to the database. Returns a reply for the main thread when there is one. */
export function applyWrite(db: Db, msg: WriteMsg, lastUserTextById: Map<number, string | null>): ReplyMsg | null {
  switch (msg.op) {
    case "start": {
      db.insertRequest(
        {
          startedAt: msg.startedAt,
          model: msg.model,
          path: msg.path,
          sessionId: msg.sessionId,
          accountUuid: msg.accountUuid,
          stream: msg.stream,
          modelFallbackFrom: msg.modelFallbackFrom,
        },
        msg.id,
      );
      if (msg.mode !== "none" && msg.raw) {
        let json: any;
        try {
          json = JSON.parse(Buffer.from(msg.raw).toString("utf8"));
        } catch {
          json = null;
        }
        const body = parseRequestBody(json ?? {});
        lastUserTextById.set(msg.id, body.lastUserText ? body.lastUserText.slice(0, 200) : null);
        db.insertBody(
          msg.id,
          {
            system: body.system,
            messages: msg.mode === "full" ? body.messages : lastTurn(body.messages),
            tools: body.tools,
            params: body.params,
            lastUserText: body.lastUserText,
          },
          msg.mode,
        );
      }
      return null;
    }
    case "finish": {
      const acc = new ResponseAccumulator(msg.stream);
      if (msg.raw) acc.push(Buffer.from(msg.raw));
      const out = acc.finish();
      const cost = estimateCost(msg.prices, msg.model, acc.usage);
      const err = msg.error ?? out.rawError ?? null;
      db.finishRequest(msg.id, {
        finishedAt: msg.finishedAt,
        account: msg.account,
        statusCode: msg.statusCode,
        error: err ? err.slice(0, 2000) : null,
        switchedFrom: msg.switchedFrom,
        retried: msg.retried,
        rl: msg.rl,
        inputTokens: acc.usage.input,
        outputTokens: acc.usage.output,
        cacheReadTokens: acc.usage.cacheRead,
        cacheWriteTokens: acc.usage.cacheWrite,
        stopReason: acc.stopReason,
        estCostUsd: cost,
        overheadMs: msg.overheadMs,
        ttfbMs: msg.ttfbMs,
      });
      if (msg.mode !== "none") db.insertResponse(msg.id, out.content, out.textPreview, out.rawError);
      const lastUserText = lastUserTextById.get(msg.id) ?? null;
      lastUserTextById.delete(msg.id);
      return {
        op: "recorded",
        summary: {
          id: msg.id,
          startedAt: msg.startedAt,
          finishedAt: msg.finishedAt,
          latencyMs: msg.finishedAt - msg.startedAt,
          account: msg.account,
          model: msg.model,
          sessionId: msg.sessionId,
          statusCode: msg.statusCode,
          stream: msg.stream,
          retried: msg.retried,
          switchedFrom: msg.switchedFrom,
          inputTokens: acc.usage.input,
          outputTokens: acc.usage.output,
          cacheReadTokens: acc.usage.cacheRead,
          cacheWriteTokens: acc.usage.cacheWrite,
          stopReason: acc.stopReason,
          error: err ? err.slice(0, 200) : null,
          estCostUsd: cost,
          lastUserText,
          overheadMs: msg.overheadMs,
          ttfbMs: msg.ttfbMs,
          modelFallbackFrom: msg.modelFallbackFrom,
        },
      };
    }
    case "snapshot":
      db.insertSnapshot(msg.account, msg.usage);
      return null;
    case "event":
      db.insertEvent(msg.event);
      return null;
    case "prune": {
      const r = db.prune(msg.retentionDays, msg.maxDbMb);
      return { op: "pruned", ...r };
    }
    case "flush":
      return { op: "flushed", seq: msg.seq };
  }
}
