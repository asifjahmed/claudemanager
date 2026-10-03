/**
 * Recorder: the proxy's hot path only hands raw buffers to a writer. All parsing, compression and SQLite work
 * happens in a worker thread (production) or inline (tests, or when the worker cannot start).
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { Db } from "../core/db.js";
import type { Config } from "../core/config.js";
import type { EventBus } from "../core/events.js";
import type { RateLimitInfo } from "../core/ratelimit-headers.js";
import type { CmEvent, Usage } from "../core/types.js";
import { applyWrite, type ReplyMsg, type WriteMsg, type ParsedRequestBody } from "./record-ops.js";
export { parseRequestBody, ResponseAccumulator } from "./record-ops.js";

export interface DbWriter {
  post(msg: WriteMsg, transfer?: ArrayBuffer[]): void;
  /** messages posted but not yet applied by the worker; used to shed body capture under load */
  backlog(): number;
  /** resolves once every message posted so far has been applied */
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly mode: "worker" | "inline" | "inline (worker crashed)";
  nextRequestId(): number;
}

type ReplyHandler = (r: ReplyMsg) => void;

export class WorkerWriter implements DbWriter {
  readonly mode = "worker" as const;
  private worker: Worker;
  private seq = 0;
  private waiters = new Map<number, () => void>();
  private nextId = 0;
  private dead = false;
  private posted = 0;
  private applied = 0;
  /** the main thread's connection, used to keep recording inline if the worker dies */
  fallbackDb: Db | null = null;
  readonly ready: Promise<void>;
  constructor(
    path: string,
    private readonly onReply: ReplyHandler,
    private readonly log: (m: string) => void,
    private readonly onFallback?: (w: DbWriter) => void,
  ) {
    const here = fileURLToPath(import.meta.url);
    const entry = here.replace(/recorder\.(js|ts)$/, "db-worker.$1");
    this.worker = new Worker(entry, { workerData: { path } });
    this.worker.on("exit", (code) => this.fail(`db worker exited with code ${code}`));
    this.ready = new Promise((resolve, reject) => {
      this.worker.once("error", reject);
      this.worker.on("message", (m: any) => {
        if (m?.op === "ready") {
          this.nextId = Number(m.maxRequestId) || 0;
          resolve();
          return;
        }
        if (m?.op === "flushed") {
          const w = this.waiters.get(m.seq);
          if (w) {
            this.waiters.delete(m.seq);
            w();
          }
          return;
        }
        if (m?.op === "applied") {
          this.applied = Math.max(this.applied, Number(m.n) || 0);
          return;
        }
        if (m?.op === "error") log(`db worker: ${m.message}`);
        onReply(m as ReplyMsg);
      });
      this.worker.on("error", (err) => this.fail(`db worker crashed: ${err?.stack ?? err}`));
    });
  }
  private closing = false;
  /** Switch the daemon to inline recording; pending flush waiters are released. */
  private fail(why: string): void {
    if (this.dead || this.closing) return;
    this.dead = true;
    this.log(`WARNING: ${why}; recording continues on the main thread (slower). Restart the daemon to get the worker back.`);
    for (const w of this.waiters.values()) w();
    this.waiters.clear();
    if (this.fallbackDb && this.onFallback) {
      const inline = new InlineWriter(this.fallbackDb, this.onReply, this.nextId);
      (inline as { mode: DbWriter["mode"] }).mode = "inline (worker crashed)";
      this.onFallback(inline);
    }
  }
  static available(): boolean {
    const here = fileURLToPath(import.meta.url);
    return existsSync(here.replace(/recorder\.(js|ts)$/, "db-worker.$1"));
  }
  nextRequestId(): number {
    return ++this.nextId;
  }
  post(msg: WriteMsg, transfer: ArrayBuffer[] = []): void {
    if (this.dead) return;
    this.posted++;
    this.worker.postMessage(msg, transfer);
  }
  backlog(): number {
    return this.dead ? 0 : Math.max(0, this.posted - this.applied);
  }
  flush(): Promise<void> {
    if (this.dead) return Promise.resolve();
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.waiters.set(seq, resolve);
      this.worker.postMessage({ op: "flush", seq } satisfies WriteMsg);
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.flush().catch(() => {});
    await this.worker.terminate();
  }
  /** tests: simulate a crash */
  async kill(): Promise<void> {
    await this.worker.terminate();
  }
}

export class InlineWriter implements DbWriter {
  readonly mode: DbWriter["mode"] = "inline";
  private lastUserText = new Map<number, string | null>();
  private nextId: number;
  constructor(
    private readonly db: Db,
    private readonly onReply: ReplyHandler,
    startId?: number,
  ) {
    this.nextId = startId ?? db.maxRequestId();
  }
  nextRequestId(): number {
    return ++this.nextId;
  }
  post(msg: WriteMsg): void {
    const r = applyWrite(this.db, msg, this.lastUserText);
    if (r && r.op !== "flushed") this.onReply(r);
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  backlog(): number {
    return 0;
  }
}

export interface RecordingHandle {
  id: number;
  setRoute(account: string | null, switchedFrom: string | null, retried: boolean): void;
  /** call when the upstream request is dispatched (measures proxy overhead) */
  dispatched(): void;
  responseStarted(status: number, rl: RateLimitInfo): void;
  chunk(buf: Buffer): void;
  finish(error?: string | null): void;
}

export class Recorder {
  /** above this many unapplied worker messages, new requests are recorded as metadata only */
  static SHED_BACKLOG = 200;
  private lastShedNote = 0;
  private readonly getWriter: () => DbWriter;
  constructor(
    writer: DbWriter | (() => DbWriter),
    private readonly cfg: () => Config,
    private readonly bus: EventBus,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.getWriter = typeof writer === "function" ? writer : () => writer;
  }
  get writer(): DbWriter {
    return this.getWriter();
  }

  /** Wire a writer's replies to the event bus. */
  static onReply(bus: EventBus): ReplyHandler {
    return (r) => {
      if (r.op === "recorded") bus.publish({ type: "request", at: r.summary.finishedAt ?? Date.now(), request: r.summary });
    };
  }

  snapshot(account: string, usage: Usage): void {
    this.writer.post({ op: "snapshot", account, usage });
  }
  event(event: CmEvent): void {
    this.writer.post({ op: "event", event });
  }
  prune(retentionDays: number, maxDbMb: number): void {
    this.writer.post({ op: "prune", retentionDays, maxDbMb });
  }

  /**
   * Begin recording. `raw` is the request body; it is transferred to the worker (zero copy) so pass a
   * buffer you no longer need.
   */
  start(path: string, body: ParsedRequestBody, raw: Buffer | null, modelFallbackFrom: string | null = null): RecordingHandle {
    const startedAt = Date.now();
    const id = this.writer.nextRequestId();
    let mode = this.cfg().log.bodies;
    if (mode !== "none" && this.writer.backlog() > Recorder.SHED_BACKLOG) {
      mode = "none";
      const now = Date.now();
      if (now - this.lastShedNote > 60_000) {
        this.lastShedNote = now;
        this.log(`recorder backlog ${this.writer.backlog()} messages: storing metadata only until it drains`);
      }
    }
    const prices = this.cfg().prices;
    const rawAb = raw && mode !== "none" ? toArrayBuffer(raw) : null;
    this.writer.post(
      {
        op: "start",
        id,
        startedAt,
        path,
        model: body.model,
        stream: body.stream,
        sessionId: body.sessionId,
        accountUuid: body.accountUuid,
        mode,
        raw: rawAb,
        modelFallbackFrom,
      },
      rawAb ? [rawAb] : [],
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    // only usage, stop reason, content blocks and a preview are extracted; 8 MB covers any real response
    const MAX = 8 * 1024 * 1024;
    let account: string | null = null;
    let switchedFrom: string | null = null;
    let retried = false;
    let status: number | null = null;
    let rl: RateLimitInfo | null = null;
    let dispatchedAt: number | null = null;
    let headersAt: number | null = null;
    let done = false;
    const writer = this.writer;
    return {
      id,
      setRoute(a, from, r) {
        account = a;
        switchedFrom = from;
        retried = r;
      },
      dispatched() {
        dispatchedAt = Date.now();
      },
      responseStarted(s, info) {
        status = s;
        rl = info;
        headersAt = Date.now();
      },
      chunk(buf) {
        bytes += buf.length;
        if (bytes <= MAX) chunks.push(buf);
      },
      finish(error) {
        if (done) return;
        done = true;
        const finishedAt = Date.now();
        const all = chunks.length ? Buffer.concat(chunks) : null;
        const ab = all ? toArrayBuffer(all) : null;
        writer.post(
          {
            op: "finish",
            id,
            startedAt,
            finishedAt,
            stream: body.stream,
            mode,
            model: body.model,
            account,
            statusCode: status,
            error: error ?? null,
            switchedFrom,
            retried,
            overheadMs: dispatchedAt ? dispatchedAt - startedAt : null,
            ttfbMs: dispatchedAt && headersAt ? headersAt - dispatchedAt : null,
            rl: {
              fiveHourUtil: rl?.fiveHour?.utilization ?? null,
              fiveHourReset: rl?.fiveHour?.resetsAt ?? null,
              sevenDayUtil: rl?.sevenDay?.utilization ?? null,
              sevenDayReset: rl?.sevenDay?.resetsAt ?? null,
              status: rl?.status ?? null,
              claim: rl?.representativeClaim ?? null,
            },
            prices,
            raw: ab,
            sessionId: body.sessionId,
            modelFallbackFrom,
          },
          ab ? [ab] : [],
        );
      },
    };
  }
}

function toArrayBuffer(b: Buffer): ArrayBuffer {
  // a fresh, exactly-sized ArrayBuffer so it can be transferred without dragging the pool slab along
  const ab = new ArrayBuffer(b.length);
  new Uint8Array(ab).set(b);
  return ab;
}
