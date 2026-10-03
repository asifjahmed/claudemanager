import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { CmEvent, RequestSummary, Usage } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  latency_ms INTEGER,
  account TEXT,
  model TEXT,
  path TEXT,
  session_id TEXT,
  account_uuid TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER,
  error TEXT,
  switched_from TEXT,
  retried INTEGER NOT NULL DEFAULT 0,
  rl_5h_util REAL, rl_5h_reset TEXT, rl_7d_util REAL, rl_7d_reset TEXT, rl_status TEXT, rl_claim TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  stop_reason TEXT,
  est_cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_requests_started ON requests(started_at);
CREATE INDEX IF NOT EXISTS idx_requests_account ON requests(account);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
CREATE TABLE IF NOT EXISTS request_bodies (
  request_id INTEGER PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  system TEXT,
  messages_gz BLOB,
  tools_gz BLOB,
  params TEXT,
  last_user_text TEXT,
  mode TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS responses (
  request_id INTEGER PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  content_gz BLOB,
  text_preview TEXT,
  raw_error TEXT
);
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  account TEXT NOT NULL,
  five_hour_util REAL, five_hour_reset TEXT,
  seven_day_util REAL, seven_day_reset TEXT,
  models TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_account_at ON usage_snapshots(account, at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  account TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
`;

export interface RequestStart {
  startedAt: number;
  model: string | null;
  path: string;
  sessionId: string | null;
  accountUuid: string | null;
  stream: boolean;
  modelFallbackFrom?: string | null;
}

export interface RequestFinish {
  finishedAt: number;
  account: string | null;
  statusCode: number | null;
  error: string | null;
  switchedFrom: string | null;
  retried: boolean;
  rl: {
    fiveHourUtil: number | null;
    fiveHourReset: string | null;
    sevenDayUtil: number | null;
    sevenDayReset: string | null;
    status: string | null;
    claim: string | null;
  };
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  stopReason: string | null;
  estCostUsd: number | null;
  overheadMs?: number | null;
  ttfbMs?: number | null;
}

export interface RequestFilter {
  account?: string;
  model?: string;
  session?: string;
  q?: string;
  since?: number;
  before?: number;
  limit?: number;
  offset?: number;
}

export interface RequestDetail extends RequestSummary {
  path: string | null;
  accountUuid: string | null;
  rl: RequestFinish["rl"] | null;
  body: { system: string | null; messages: unknown; tools: unknown; params: unknown; lastUserText: string | null; mode: string } | null;
  response: { content: unknown; textPreview: string | null; rawError: string | null } | null;
}

function gz(v: unknown): Buffer | null {
  if (v === undefined || v === null) return null;
  return gzipSync(Buffer.from(JSON.stringify(v)));
}
function ungz(b: unknown): unknown {
  if (!b) return null;
  try {
    return JSON.parse(gunzipSync(b as Buffer).toString("utf8"));
  } catch {
    return null;
  }
}

const MIGRATIONS = [
  "ALTER TABLE requests ADD COLUMN overhead_ms INTEGER",
  "ALTER TABLE requests ADD COLUMN ttfb_ms INTEGER",
  "ALTER TABLE requests ADD COLUMN model_fallback_from TEXT",
];

export class Db {
  readonly db: DatabaseSync;
  constructor(
    readonly path: string,
    opts: { readOnly?: boolean; busyTimeoutMs?: number } = {},
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { readOnly: !!opts.readOnly });
    this.db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 2000};`);
    if (!opts.readOnly) {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
      this.db.exec(SCHEMA);
      for (const m of MIGRATIONS) {
        try {
          this.db.exec(m);
        } catch (err: any) {
          if (!/duplicate column/i.test(String(err?.message))) throw err;
        }
      }
    }
  }

  /** highest request id, so a writer can allocate ids without a round trip */
  maxRequestId(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM requests").get() as any;
    return Number(r.m);
  }

  close(): void {
    this.db.close();
  }

  insertRequest(r: RequestStart, id?: number): number {
    if (id !== undefined) {
      this.db
        .prepare("INSERT INTO requests (id, started_at, model, path, session_id, account_uuid, stream, model_fallback_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, r.startedAt, r.model, r.path, r.sessionId, r.accountUuid, r.stream ? 1 : 0, r.modelFallbackFrom ?? null);
      return id;
    }
    const st = this.db.prepare("INSERT INTO requests (started_at, model, path, session_id, account_uuid, stream) VALUES (?, ?, ?, ?, ?, ?)");
    const res = st.run(r.startedAt, r.model, r.path, r.sessionId, r.accountUuid, r.stream ? 1 : 0);
    return Number(res.lastInsertRowid);
  }

  finishRequest(id: number, f: RequestFinish): void {
    this.db
      .prepare(
        `UPDATE requests SET finished_at=?, latency_ms=?, account=?, status_code=?, error=?, switched_from=?, retried=?,
         rl_5h_util=?, rl_5h_reset=?, rl_7d_util=?, rl_7d_reset=?, rl_status=?, rl_claim=?,
         input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=?, stop_reason=?, est_cost_usd=?, overhead_ms=?, ttfb_ms=? WHERE id=?`,
      )
      .run(
        f.finishedAt,
        null,
        f.account,
        f.statusCode,
        f.error,
        f.switchedFrom,
        f.retried ? 1 : 0,
        f.rl.fiveHourUtil,
        f.rl.fiveHourReset,
        f.rl.sevenDayUtil,
        f.rl.sevenDayReset,
        f.rl.status,
        f.rl.claim,
        f.inputTokens,
        f.outputTokens,
        f.cacheReadTokens,
        f.cacheWriteTokens,
        f.stopReason,
        f.estCostUsd,
        f.overheadMs ?? null,
        f.ttfbMs ?? null,
        id,
      );
    this.db.prepare("UPDATE requests SET latency_ms = finished_at - started_at WHERE id=?").run(id);
  }

  insertBody(
    id: number,
    body: { system: string | null; messages: unknown; tools: unknown; params: unknown; lastUserText: string | null },
    mode: "full" | "lastTurn",
  ): void {
    this.db
      .prepare("INSERT OR REPLACE INTO request_bodies (request_id, system, messages_gz, tools_gz, params, last_user_text, mode) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, body.system, gz(body.messages), gz(body.tools), body.params === null ? null : JSON.stringify(body.params), body.lastUserText, mode);
  }

  insertResponse(id: number, content: unknown, textPreview: string | null, rawError: string | null): void {
    this.db
      .prepare("INSERT OR REPLACE INTO responses (request_id, content_gz, text_preview, raw_error) VALUES (?, ?, ?, ?)")
      .run(id, gz(content), textPreview, rawError);
  }

  insertSnapshot(account: string, u: Usage): void {
    this.db
      .prepare(
        "INSERT INTO usage_snapshots (at, account, five_hour_util, five_hour_reset, seven_day_util, seven_day_reset, models, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(u.fetchedAt, account, u.fiveHour.utilization, u.fiveHour.resetsAt, u.sevenDay.utilization, u.sevenDay.resetsAt, JSON.stringify(u.models), u.source);
  }

  insertEvent(ev: CmEvent): void {
    const account = "account" in ev ? (ev.account ?? null) : ev.type === "switch" ? ev.to : null;
    const { type, at, ...rest } = ev as any;
    this.db.prepare("INSERT INTO events (at, type, account, data) VALUES (?, ?, ?, ?)").run(at, type, account, JSON.stringify(rest));
  }

  recentEvents(limit = 100): Array<{ id: number; at: number; type: string; account: string | null; data: unknown }> {
    const rows = this.db.prepare("SELECT id, at, type, account, data FROM events ORDER BY id DESC LIMIT ?").all(limit) as any[];
    return rows.reverse().map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
  }

  private rowToSummary(r: any): RequestSummary {
    return {
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      latencyMs: r.latency_ms,
      account: r.account,
      model: r.model,
      sessionId: r.session_id,
      statusCode: r.status_code,
      stream: !!r.stream,
      retried: !!r.retried,
      switchedFrom: r.switched_from,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      stopReason: r.stop_reason,
      error: r.error,
      estCostUsd: r.est_cost_usd,
      overheadMs: r.overhead_ms ?? null,
      ttfbMs: r.ttfb_ms ?? null,
      modelFallbackFrom: r.model_fallback_from ?? null,
      lastUserText: r.last_user_text ? String(r.last_user_text).slice(0, 200) : null,
    };
  }

  listRequests(f: RequestFilter = {}): RequestSummary[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.account) {
      where.push("r.account = ?");
      args.push(f.account);
    }
    if (f.model) {
      where.push("r.model LIKE ?");
      args.push(`%${f.model}%`);
    }
    if (f.session) {
      where.push("r.session_id = ?");
      args.push(f.session);
    }
    if (f.since) {
      where.push("r.started_at >= ?");
      args.push(f.since);
    }
    if (f.before) {
      where.push("r.started_at < ?");
      args.push(f.before);
    }
    if (f.q) {
      where.push("(b.last_user_text LIKE ? OR p.text_preview LIKE ? OR b.system LIKE ?)");
      args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
    }
    const sql = `SELECT r.*, b.last_user_text FROM requests r
      LEFT JOIN request_bodies b ON b.request_id = r.id
      LEFT JOIN responses p ON p.request_id = r.id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY r.id DESC LIMIT ? OFFSET ?`;
    args.push(Math.min(f.limit ?? 100, 1000), f.offset ?? 0);
    return (this.db.prepare(sql).all(...(args as any[])) as any[]).map((r) => this.rowToSummary(r));
  }

  getRequest(id: number): RequestDetail | null {
    const r = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as any;
    if (!r) return null;
    const b = this.db.prepare("SELECT * FROM request_bodies WHERE request_id = ?").get(id) as any;
    const p = this.db.prepare("SELECT * FROM responses WHERE request_id = ?").get(id) as any;
    return {
      ...this.rowToSummary(r),
      path: r.path,
      accountUuid: r.account_uuid,
      rl:
        r.rl_status || r.rl_5h_util !== null
          ? {
              fiveHourUtil: r.rl_5h_util,
              fiveHourReset: r.rl_5h_reset,
              sevenDayUtil: r.rl_7d_util,
              sevenDayReset: r.rl_7d_reset,
              status: r.rl_status,
              claim: r.rl_claim,
            }
          : null,
      body: b
        ? {
            system: b.system,
            messages: ungz(b.messages_gz),
            tools: ungz(b.tools_gz),
            params: b.params ? JSON.parse(b.params) : null,
            lastUserText: b.last_user_text,
            mode: b.mode,
          }
        : null,
      response: p ? { content: ungz(p.content_gz), textPreview: p.text_preview, rawError: p.raw_error } : null,
    };
  }

  listSessions(limit = 100): Array<{
    sessionId: string;
    firstSeen: number;
    lastSeen: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    accounts: string;
    models: string;
    estCostUsd: number;
  }> {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, MIN(started_at) AS firstSeen, MAX(started_at) AS lastSeen, COUNT(*) AS requests,
          COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
          GROUP_CONCAT(DISTINCT account) AS accounts, GROUP_CONCAT(DISTINCT model) AS models, COALESCE(SUM(est_cost_usd),0) AS estCostUsd
         FROM requests WHERE session_id IS NOT NULL GROUP BY session_id ORDER BY lastSeen DESC LIMIT ?`,
      )
      .all(limit) as any[];
  }

  stats(by: "account" | "model" | "day", sinceMs?: number): Array<Record<string, unknown>> {
    const key = by === "day" ? "strftime('%Y-%m-%d', started_at/1000, 'unixepoch', 'localtime')" : by;
    const where = sinceMs ? "WHERE started_at >= ?" : "";
    const args = sinceMs ? [sinceMs] : [];
    return this.db
      .prepare(
        `SELECT ${key} AS key, COUNT(*) AS requests,
          SUM(CASE WHEN status_code >= 400 OR error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
          SUM(retried) AS retried,
          COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
          COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,
          COALESCE(SUM(est_cost_usd),0) AS estCostUsd, AVG(latency_ms) AS avgLatencyMs
         FROM requests ${where} GROUP BY key ORDER BY key DESC`,
      )
      .all(...(args as any[])) as any[];
  }

  usageHistory(
    account: string | undefined,
    hours = 24,
  ): Array<{
    at: number;
    account: string;
    fiveHourUtil: number | null;
    sevenDayUtil: number | null;
    models: Record<string, { utilization: number | null; resetsAt?: string | null }>;
  }> {
    const since = Date.now() - hours * 3600_000;
    const rows = account
      ? this.db
          .prepare("SELECT at, account, five_hour_util, seven_day_util, models FROM usage_snapshots WHERE account = ? AND at >= ? ORDER BY at")
          .all(account, since)
      : this.db.prepare("SELECT at, account, five_hour_util, seven_day_util, models FROM usage_snapshots WHERE at >= ? ORDER BY at").all(since);
    return (rows as any[]).map((r) => ({
      at: r.at,
      account: r.account,
      fiveHourUtil: r.five_hour_util,
      sevenDayUtil: r.seven_day_util,
      models: r.models ? JSON.parse(r.models) : {},
    }));
  }

  /** Count events of a type since a time; `dataContains` restricts to rows whose JSON payload contains the substring. */
  countEvents(type: string, sinceMs: number, dataContains?: string): number {
    const r = dataContains
      ? (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ? AND at >= ? AND data LIKE ?").get(type, sinceMs, `%${dataContains}%`) as any)
      : (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ? AND at >= ?").get(type, sinceMs) as any);
    return r?.n ?? 0;
  }

  /** Per-session totals over a window, with the first prompt and peak context, for attribution. */
  sessionUsage(
    sinceMs: number,
    limit = 200,
  ): Array<{
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
  }> {
    return this.db
      .prepare(
        `SELECT r.session_id AS sessionId, MIN(r.started_at) AS firstSeen, MAX(r.started_at) AS lastSeen, COUNT(*) AS requests,
          COALESCE(SUM(r.input_tokens),0) AS inputTokens, COALESCE(SUM(r.output_tokens),0) AS outputTokens,
          COALESCE(SUM(r.cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(r.cache_write_tokens),0) AS cacheWriteTokens,
          COALESCE(SUM(r.est_cost_usd),0) AS estCostUsd, GROUP_CONCAT(DISTINCT r.account) AS accounts, GROUP_CONCAT(DISTINCT r.model) AS models,
          (SELECT b.last_user_text FROM requests r2 JOIN request_bodies b ON b.request_id = r2.id WHERE r2.session_id = r.session_id ORDER BY r2.id ASC LIMIT 1) AS firstPrompt,
          MAX(COALESCE(r.input_tokens,0)+COALESCE(r.cache_read_tokens,0)+COALESCE(r.cache_write_tokens,0)) AS maxContext
         FROM requests r WHERE r.session_id IS NOT NULL AND r.started_at >= ? GROUP BY r.session_id ORDER BY estCostUsd DESC LIMIT ?`,
      )
      .all(sinceMs, limit) as any[];
  }

  /** Cost per session per model family over a window (family derived in code from the model id). */
  sessionModelCosts(sinceMs: number): Array<{ sessionId: string; model: string | null; estCostUsd: number }> {
    return this.db
      .prepare(
        "SELECT session_id AS sessionId, model, COALESCE(SUM(est_cost_usd),0) AS estCostUsd FROM requests WHERE session_id IS NOT NULL AND started_at >= ? GROUP BY session_id, model",
      )
      .all(sinceMs) as any[];
  }

  /** Turn rows for one session (context growth). */
  sessionTurns(
    sessionId: string,
  ): Array<{
    id: number;
    startedAt: number;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    latencyMs: number | null;
    statusCode: number | null;
  }> {
    return this.db
      .prepare(
        "SELECT id, started_at AS startedAt, model, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens, latency_ms AS latencyMs, status_code AS statusCode FROM requests WHERE session_id = ? ORDER BY id ASC",
      )
      .all(sessionId) as any[];
  }

  /** The latest stored prompt body for a session, or null. */
  latestBody(sessionId: string): { system: string | null; messages: unknown; tools: unknown } | null {
    const r = this.db
      .prepare("SELECT r.id FROM requests r JOIN request_bodies b ON b.request_id = r.id WHERE r.session_id = ? ORDER BY r.id DESC LIMIT 1")
      .get(sessionId) as any;
    if (!r) return null;
    const d = this.getRequest(r.id);
    return d?.body ? { system: d.body.system, messages: d.body.messages, tools: d.body.tools } : null;
  }

  /** Pages actually in use (the file itself never shrinks without VACUUM; freed pages are reused). */
  liveSizeMb(): number {
    if (this.path === ":memory:") return 0;
    const pc = (this.db.prepare("PRAGMA page_count").get() as any).page_count;
    const fl = (this.db.prepare("PRAGMA freelist_count").get() as any).freelist_count;
    const ps = (this.db.prepare("PRAGMA page_size").get() as any).page_size;
    return ((pc - fl) * ps) / (1024 * 1024);
  }

  /**
   * Delete old rows and, if the live data is still over the cap, the oldest bodies in batches.
   * Never VACUUMs: that would take an exclusive lock on a multi-GB file for many seconds. Freed pages are reused.
   */
  prune(retentionDays: number, maxDbMb: number): { deletedRequests: number; deletedBodies: number } {
    let deletedRequests = 0;
    let deletedBodies = 0;
    if (retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 86400_000;
      deletedRequests = Number(this.db.prepare("DELETE FROM requests WHERE started_at < ?").run(cutoff).changes);
      this.db.prepare("DELETE FROM usage_snapshots WHERE at < ?").run(cutoff);
      this.db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
    }
    let tries = 0;
    while (tries++ < 50 && this.liveSizeMb() > maxDbMb) {
      const r = this.db
        .prepare("DELETE FROM request_bodies WHERE request_id IN (SELECT request_id FROM request_bodies ORDER BY request_id ASC LIMIT 500)")
        .run();
      this.db.prepare("DELETE FROM responses WHERE request_id IN (SELECT request_id FROM responses ORDER BY request_id ASC LIMIT 500)").run();
      deletedBodies += Number(r.changes);
      if (Number(r.changes) === 0) break;
    }
    return { deletedRequests, deletedBodies };
  }

  purge(beforeMs?: number, vacuum = false): number {
    const r = beforeMs ? this.db.prepare("DELETE FROM requests WHERE started_at < ?").run(beforeMs) : this.db.prepare("DELETE FROM requests").run();
    if (vacuum) this.db.exec("VACUUM");
    return Number(r.changes);
  }

  vacuum(): void {
    this.db.exec("VACUUM");
  }

  sizeMb(): number {
    try {
      return statSync(this.path).size / (1024 * 1024);
    } catch {
      return 0;
    }
  }

  counts(): { requests: number; sizeMb: number; liveMb: number } {
    const c = this.db.prepare("SELECT COUNT(*) AS n FROM requests").get() as any;
    return { requests: c.n, sizeMb: Math.round(this.sizeMb() * 10) / 10, liveMb: Math.round(this.liveSizeMb() * 10) / 10 };
  }
}
