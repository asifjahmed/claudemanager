import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent, request as undiciRequest, type Dispatcher } from "undici";
import { policyFromConfig, type Config } from "../core/config.js";
import type { AccountStore } from "../core/accounts.js";
import type { EventBus } from "../core/events.js";
import { pickAccount, eligibility } from "../core/router.js";
import { parseRateLimitHeaders, mergeHeaderUsage, type RateLimitInfo } from "../core/ratelimit-headers.js";
import { PASSTHROUGH_PATH_PREFIXES, modelFamily } from "../core/claude-internals.js";
import { computeAdvice, adviceHeaders, type AdviceResult } from "../core/advice.js";
import { CredentialError } from "../core/credentials.js";
import { parseRequestBody, type Recorder } from "./recorder.js";
import type { PerfMonitor } from "./perf.js";
import { AffinityStore } from "./affinity.js";

export interface ProxyDeps {
  config: () => Config;
  store: AccountStore;
  bus: EventBus;
  /** Returns a valid bearer token for the named account (refreshing if needed). */
  getToken: (account: string, opts?: { force?: boolean }) => Promise<string>;
  recorder: Recorder | null;
  perf?: PerfMonitor;
  /** free-reset concentrate mode: the account new sessions should fill first, or null */
  drainAccount?: () => string | null;
  /** where to persist session→account affinity; null = memory only */
  affinityPath?: string | null;
  log: (msg: string) => void;
  /** override for tests */
  dispatcher?: Dispatcher;
}

export interface RouterState {
  /** account of the most recent request (status line, poll priority) */
  current: string | null;
  lastSwitchAt: number | null;
  /** sticky slot for requests that carry no session id */
  anon: string | null;
  /** when the pool last made a proactive (perishable) move */
  lastProactiveMoveAt: number | null;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) {
        reject(new Error(`request body exceeds ${max} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function upstreamHeaders(req: IncomingMessage, token: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (token) {
    out["authorization"] = `Bearer ${token}`;
    delete out["x-api-key"];
  }
  return out;
}

function resetMsFromInfo(info: RateLimitInfo): number | null {
  const iso = info.representativeClaim?.startsWith("seven_day") ? (info.sevenDay?.resetsAt ?? info.resetAt) : (info.fiveHour?.resetsAt ?? info.resetAt);
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export class Proxy {
  readonly routerState: RouterState = { current: null, lastSwitchAt: null, anon: null, lastProactiveMoveAt: null };
  readonly affinity: AffinityStore;
  private readonly agent: Dispatcher;

  constructor(private readonly deps: ProxyDeps) {
    this.affinity = new AffinityStore(deps.affinityPath ?? null);
    this.agent =
      deps.dispatcher ??
      new Agent({ keepAliveTimeout: 30_000, connections: deps.config().upstreamConnections, pipelining: 1, headersTimeout: 300_000, bodyTimeout: 900_000 });
  }

  /** Decide which account serves a request; emits switch events. */
  decide(
    family: string | null,
    exclude?: Set<string>,
  ): { account: string | null; switched: boolean; from: string | null; reason: string; earliestResetAt: number | null; relaxed: boolean } {
    const cfg = this.deps.config();
    this.deps.store.clearExpiredExhaustion();
    const d = pickAccount({
      accounts: this.deps.store.all(),
      policy: { ...policyFromConfig(cfg, this.deps.drainAccount?.() ?? null), lastProactiveMoveAt: this.routerState.lastProactiveMoveAt },
      current: this.routerState.anon,
      modelFamily: family,
      exclude,
      lastSwitchAt: this.routerState.lastSwitchAt,
    });
    if (d.account && d.account !== this.routerState.anon) {
      const from = this.routerState.anon;
      this.routerState.anon = d.account;
      if (from) {
        this.routerState.lastSwitchAt = Date.now();
        this.deps.bus.publish({ type: "switch", at: Date.now(), from, to: d.account, reason: d.reason });
        this.deps.log(`switch (no session id) ${from} -> ${d.account} (${d.reason})`);
      }
    }
    if (d.account) this.routerState.current = d.account;
    if (d.account && d.relaxed) this.noteRelaxed(d.account, family);
    if (!d.account) this.noteNoAccount(d.earliestResetAt);
    return { account: d.account, switched: d.switched, from: d.from, reason: d.reason, earliestResetAt: d.earliestResetAt, relaxed: d.relaxed };
  }

  private lastNoAccountNote = 0;
  private lastExhaustedNote = new Map<string, number>();
  private lastAllExhaustedAt = 0;
  /** Publish all_exhausted with its cause. With no accounts configured at all, say so at most every 10 minutes. */
  private noteNoAccount(earliestResetAt: number | null): void {
    const all = this.deps.store.all();
    const live = all.filter((a) => !a.disabled);
    const cause = live.length === 0 ? (all.length ? "disabled" : "none") : live.some((a) => !a.tokenOk && !a.hasInferenceToken) ? "auth" : "limits";
    const now = Date.now();
    if (cause === "none" || cause === "disabled") {
      if (now - this.lastNoAccountNote < 10 * 60_000) return;
      this.lastNoAccountNote = now;
      this.deps.log(
        cause === "none"
          ? "no accounts configured; forwarding requests with the caller's own login (cm accounts add <name>)"
          : "all accounts are disabled; forwarding requests with the caller's own login",
      );
    }
    // edge-triggered: one event per minute while the pool stays dry, not one per request
    if (now - this.lastAllExhaustedAt < 60_000) return;
    this.lastAllExhaustedAt = now;
    this.deps.bus.publish({ type: "all_exhausted", at: now, earliestResetAt, cause });
  }

  private noteRelaxed(account: string, family: string | null): void {
    const now = Date.now();
    if (now - this.lastRelaxedNote < 60_000) return;
    this.lastRelaxedNote = now;
    this.deps.log(`every account is over a switch threshold for ${family ?? "this model"}; serving from ${account} (most room left) rather than stalling`);
  }

  private lastRelaxedNote = 0;
  private lastFallbackNote = 0;
  private noteFallback(why: string): void {
    const now = Date.now();
    if (now - this.lastFallbackNote < 60_000) return;
    this.lastFallbackNote = now;
    this.deps.log(`FAIL-OPEN: ${why}; forwarding requests with the caller's own login`);
    this.deps.bus.publish({ type: "fallback", at: now, reason: why });
  }

  private noAccountReason(): string {
    const live = this.deps.store.all().filter((a) => !a.disabled);
    if (live.length === 0) return this.deps.store.all().length ? "all accounts are disabled" : "no accounts configured";
    if (live.every((a) => a.needsLogin && !a.hasInferenceToken)) return "every account needs re-login (cm accounts login <name>)";
    if (live.some((a) => a.needsLogin && !a.hasInferenceToken)) return "remaining accounts are at their limit and others need re-login";
    return "all accounts are at their limit";
  }

  /**
   * Per-session routing. A session keeps its account (its prompt cache lives there) until that account stops
   * being usable or a proactive move is justified; new sessions land on the best account right now.
   */
  private moveTokens = 0;
  private moveTokensAt = 0;
  /** Global move budget: exhaustion/auth-driven moves are always allowed; threshold/perishable moves are rate-limited. */
  private allowMove(reason: string): boolean {
    if (reason === "exhausted" || reason === "error" || reason === "disabled" || reason === "pinned" || reason === "relaxed") return true;
    const cfg = this.deps.config();
    const now = Date.now();
    const perMin = cfg.maxMovesPerMinute + 0.02 * Object.values(this.affinity.activeByAccount()).reduce((a, b) => a + b, 0);
    const elapsedMin = (now - this.moveTokensAt) / 60_000;
    this.moveTokens = Math.min(perMin, this.moveTokens + elapsedMin * perMin);
    this.moveTokensAt = now;
    if (this.moveTokens < 1) return false;
    this.moveTokens -= 1;
    return true;
  }

  decideForSession(
    sessionId: string | null,
    family: string | null,
    exclude?: Set<string>,
  ): { account: string | null; switched: boolean; from: string | null; reason: string; earliestResetAt: number | null; relaxed: boolean } {
    if (!sessionId) return this.decide(family, exclude);
    const cfg = this.deps.config();
    this.deps.store.clearExpiredExhaustion();
    const aff = this.affinity.get(sessionId);
    const d = pickAccount({
      accounts: this.deps.store.all(),
      policy: { ...policyFromConfig(cfg, this.deps.drainAccount?.() ?? null), lastProactiveMoveAt: this.routerState.lastProactiveMoveAt },
      current: aff?.account ?? null,
      modelFamily: family,
      exclude,
      lastSwitchAt: aff?.lastSwitchAt ?? null,
    });
    let account = d.account;
    let reason = d.reason;
    let moved = !!aff && !!account && aff.account !== account;
    // budget: if this kind of move is rate-limited and the budget is spent, stay (a tier-2 account still serves)
    if (moved && aff && !exclude?.has(aff.account) && !this.allowMove(reason)) {
      const cur = this.deps.store.get(aff.account);
      // only a still-usable (tier 2) account may keep a session past the budget; a window at 100% or a dead token always moves
      const stillServes = !!cur && eligibility(cur, policyFromConfig(cfg), family, Date.now(), { assigned: true }).tier === 2;
      if (stillServes) {
        account = aff.account;
        reason = "sticky";
        moved = false;
      }
    }
    if (account) {
      this.affinity.assign(sessionId, account, moved);
      this.routerState.current = account;
      if (moved) {
        this.routerState.lastSwitchAt = Date.now();
        if (reason === "perishable") this.routerState.lastProactiveMoveAt = Date.now();
        this.deps.bus.publish({ type: "switch", at: Date.now(), from: aff!.account, to: account, reason, session: sessionId });
        this.deps.log(`session ${sessionId.slice(0, 8)}: ${aff!.account} -> ${account} (${reason})`);
      } else if (!aff) {
        this.deps.bus.publish({ type: "assign", at: Date.now(), session: sessionId, account, relaxed: d.relaxed });
      }
      if (d.relaxed) this.noteRelaxed(account, family);
    } else {
      this.noteNoAccount(d.earliestResetAt);
    }
    return { account, switched: moved, from: aff?.account ?? null, reason, earliestResetAt: d.earliestResetAt, relaxed: d.relaxed };
  }

  /** Advice for an application: this session's account windows, the pool per model family, and what to do. */
  adviceFor(sessionId: string | null, model: string | null): AdviceResult {
    const cfg = this.deps.config();
    this.deps.store.clearExpiredExhaustion();
    return computeAdvice({
      accounts: this.deps.store.all(),
      policy: policyFromConfig(cfg, this.deps.drainAccount?.() ?? null),
      model,
      sessionId,
      sessionAccount: sessionId ? (this.affinity.get(sessionId)?.account ?? null) : null,
      approachingHeadroom: cfg.advice.approachingHeadroom,
    });
  }

  /** Side-effect-free routing preview for a new session. */
  preview(family: string | null): ReturnType<typeof pickAccount> {
    const cfg = this.deps.config();
    return pickAccount({
      accounts: this.deps.store.all(),
      policy: policyFromConfig(cfg, this.deps.drainAccount?.() ?? null),
      current: null,
      modelFamily: family,
    });
  }

  /** Force the current account (manual pin from API). */
  setCurrent(name: string | null, reason = "manual"): void {
    if (name === this.routerState.current) return;
    const from = this.routerState.current;
    this.routerState.current = name;
    this.routerState.lastSwitchAt = Date.now();
    if (name) this.deps.bus.publish({ type: "switch", at: Date.now(), from, to: name, reason });
  }

  isRoutable(path: string): boolean {
    if (PASSTHROUGH_PATH_PREFIXES.some((p) => path.startsWith(p))) return false;
    return path.startsWith("/v1/");
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cfg = this.deps.config();
    const path = req.url ?? "/";
    const url = new URL(path, cfg.upstream).toString();
    if (!this.isRoutable(path)) {
      return this.passthrough(req, res, url);
    }

    // client abort: stop the upstream stream and free everything; nothing may hang on a closed client
    const ac = new AbortController();
    let clientClosed = false;
    res.on("close", () => {
      clientClosed = true;
      ac.abort();
    });
    let body: Buffer;
    try {
      body = await readBody(req, cfg.maxBodyBytes);
    } catch (err: any) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "request_too_large", message: err.message } }));
      return;
    }
    let json: any = null;
    if (body.length && (req.headers["content-type"] ?? "").includes("json")) {
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        json = null;
      }
    }
    const parsed = parseRequestBody(json ?? {}, req.headers);
    let family = modelFamily(parsed.model ?? undefined);
    const isMessages = path.startsWith("/v1/messages") && !path.includes("count_tokens") && req.method === "POST";

    // Model fallback (opt-in): when the requested family has no pooled headroom left, rewrite the model.
    // This is the one deliberate body edit the proxy makes; it is logged, recorded and surfaced in a header.
    let modelFallbackFrom: string | null = null;
    const fallbackTo = family ? cfg.modelFallback[family] : undefined;
    if (isMessages && json && fallbackTo && fallbackTo !== parsed.model) {
      const adv = this.adviceFor(parsed.sessionId, parsed.model);
      const mine = adv.pool.families.find((f) => f.family === family);
      if (mine && mine.headroom <= cfg.modelFallbackHeadroom) {
        modelFallbackFrom = parsed.model;
        json.model = fallbackTo;
        body = Buffer.from(JSON.stringify(json));
        parsed.model = fallbackTo;
        family = modelFamily(fallbackTo);
        const reason = `pooled ${mine.family} headroom ${Math.round(mine.headroom)}% ≤ ${cfg.modelFallbackHeadroom}%`;
        this.deps.bus.publish({
          type: "model_fallback",
          at: Date.now(),
          session: parsed.sessionId,
          account: null,
          from: modelFallbackFrom!,
          to: fallbackTo,
          reason,
        });
        this.deps.log(`model fallback ${modelFallbackFrom} -> ${fallbackTo} for session ${parsed.sessionId?.slice(0, 8) ?? "?"} (${reason})`);
      }
    }
    // the recorder gets its own copy of the body (transferred to the worker); the proxy keeps `body` for retries
    const rec = isMessages && this.deps.recorder ? this.deps.recorder.start(path, parsed, json ? Buffer.from(body) : null, modelFallbackFrom) : null;
    // the worker re-parses its own copy; drop the main thread's object graph now (it is the bulk of per-request memory)
    // eslint-disable-next-line no-useless-assignment -- releases the parsed body for GC; the function runs for the life of the stream
    json = null;
    parsed.messages = null;
    parsed.tools = null;
    parsed.system = null;
    const t0 = Date.now();
    const extraHeaders = (): Record<string, string> => {
      const hd = adviceHeaders(this.adviceFor(parsed.sessionId, parsed.model));
      if (modelFallbackFrom) hd["x-cm-model-fallback"] = `${modelFallbackFrom}->${parsed.model}`;
      return hd;
    };

    const excluded = new Set<string>();
    let retried = false;
    let switchedFrom: string | null = null;
    let forcedRefresh = false;
    let attempts = 0;

    while (attempts++ < 4) {
      const decision = this.decideForSession(parsed.sessionId, family, excluded);
      if (decision.switched && !switchedFrom) switchedFrom = decision.from;
      if (!decision.account) {
        const why = this.noAccountReason();
        // FAIL OPEN: a proxy-side problem must never stall a session. If the caller brought its own login,
        // forward the request untouched and let upstream answer for that account.
        if (req.headers["authorization"] || req.headers["x-api-key"]) {
          this.noteFallback(why);
          rec?.setRoute("(passthrough)", switchedFrom, retried);
          try {
            const up = await undiciRequest(url, {
              method: req.method as Dispatcher.HttpMethod,
              headers: upstreamHeaders(req, null),
              body: body.length ? body : undefined,
              dispatcher: this.agent,
              signal: ac.signal,
            });
            rec?.responseStarted(up.statusCode, parseRateLimitHeaders(up.headers as Record<string, string | string[] | undefined>));
            await this.pipeResponse(up, res, rec, extraHeaders());
          } catch (err: any) {
            rec?.finish(`upstream: ${err.message}`);
            if (!res.headersSent) {
              res.writeHead(502, { "content-type": "application/json" });
              res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `claudemanager upstream error: ${err.message}` } }));
            }
          }
          return;
        }
        const retryAt = decision.earliestResetAt ? new Date(decision.earliestResetAt).toISOString() : "unknown";
        this.deps.log(`no eligible account for ${path}: ${why} (earliest reset ${retryAt})`);
        const hdrs: Record<string, string> = {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-status": "rate_limited",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        };
        if (decision.earliestResetAt) {
          hdrs["retry-after"] = String(Math.max(1, Math.ceil((decision.earliestResetAt - Date.now()) / 1000)));
          hdrs["anthropic-ratelimit-unified-reset"] = String(Math.floor(decision.earliestResetAt / 1000));
          hdrs["anthropic-ratelimit-unified-5h-reset"] = String(Math.floor(decision.earliestResetAt / 1000));
        }
        res.writeHead(429, hdrs);
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `claudemanager: ${why}; earliest reset ${retryAt}` } }));
        rec?.setRoute(null, switchedFrom, retried);
        rec?.responseStarted(429, parseRateLimitHeaders({}));
        rec?.finish(why);
        return;
      }
      const account = decision.account;
      let token: string;
      try {
        token = await this.deps.getToken(account, { force: forcedRefresh });
        forcedRefresh = false;
      } catch (err: any) {
        const s = this.deps.store.get(account);
        const dead = err instanceof CredentialError ? err.needsLogin : false;
        if (s) {
          // Only a dead login takes the account out of rotation; "held"/"network" just skips it for this request.
          if (dead) {
            const first = !s.needsLogin;
            s.tokenOk = false;
            s.needsLogin = true;
            const note = `${err.message} — run: cm accounts login ${account}`;
            this.deps.store.setError(account, note);
            if (first) this.deps.bus.publish({ type: "error", at: Date.now(), account, message: note });
          } else {
            this.deps.store.setError(account, `token: ${err.message}`);
          }
        }
        excluded.add(account);
        continue;
      }

      let up: Dispatcher.ResponseData;
      const dispatchedAt = Date.now();
      try {
        rec?.dispatched();
        up = await undiciRequest(url, {
          method: req.method as Dispatcher.HttpMethod,
          headers: upstreamHeaders(req, token),
          body: body.length ? body : undefined,
          dispatcher: this.agent,
          signal: ac.signal,
        });
      } catch (err: any) {
        if (clientClosed) {
          rec?.setRoute(account, switchedFrom, retried);
          rec?.finish("client closed before upstream responded");
          return;
        }
        this.deps.log(`upstream error (${account}): ${err.message}`);
        rec?.setRoute(account, switchedFrom, retried);
        rec?.finish(`upstream: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `claudemanager upstream error: ${err.message}` } }));
        }
        return;
      }

      const info = parseRateLimitHeaders(up.headers as Record<string, string | string[] | undefined>);
      this.applyHeaders(account, info);

      if (up.statusCode === 401 && !forcedRefresh && attempts < 4) {
        await up.body.text().catch(() => "");
        this.deps.log(`401 from upstream for ${account}; forcing token refresh`);
        forcedRefresh = true;
        continue;
      }
      // Only the unified headers can tell a plan-usage limit apart from a transient server-side throttle.
      const usageLimited = info.present && (info.status === "rate_limited" || info.status === "rejected");
      if (up.statusCode === 429 && !usageLimited) {
        // Transient 429 (no usage-limit headers): not this account's fault. Pass it through untouched;
        // Claude Code retries these with backoff on its own. Do NOT mark the account exhausted.
        this.deps.log(`transient 429 from upstream on ${account} (no usage-limit headers); passing through`);
        this.deps.store.markUsed(account);
        rec?.setRoute(account, switchedFrom, retried);
        rec?.responseStarted(up.statusCode, info);
        await this.pipeResponse(up, res, rec, extraHeaders());
        return;
      }
      if (usageLimited) {
        const until = resetMsFromInfo(info);
        this.deps.store.markExhausted(account, until, info.representativeClaim);
        if (Date.now() - (this.lastExhaustedNote.get(account) ?? 0) > 60_000) {
          this.lastExhaustedNote.set(account, Date.now());
          this.deps.bus.publish({ type: "exhausted", at: Date.now(), account, until, claim: info.representativeClaim });
          this.deps.log(`${account} exhausted (${info.representativeClaim ?? "unknown"}) until ${until ? new Date(until).toISOString() : "?"}`);
        }
        if (cfg.retryOn429 && up.statusCode === 429) {
          excluded.add(account);
          const next = this.decideForSession(parsed.sessionId, family, excluded);
          if (next.account) {
            await up.body.text().catch(() => "");
            retried = true;
            if (!switchedFrom) switchedFrom = account;
            this.deps.log(`retrying ${path} on ${next.account}`);
            continue;
          }
        }
      }

      this.deps.store.markUsed(account);
      rec?.setRoute(account, switchedFrom, retried);
      rec?.responseStarted(up.statusCode, info);
      this.deps.perf?.record(dispatchedAt - t0, Date.now() - dispatchedAt);
      await this.pipeResponse(up, res, rec, extraHeaders());
      return;
    }
    if (!res.headersSent) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "claudemanager: could not route request" } }));
    }
    rec?.finish("could not route request");
  }

  private applyHeaders(account: string, info: RateLimitInfo): void {
    if (!info.present) return;
    const s = this.deps.store.get(account);
    if (!s) return;
    const merged = mergeHeaderUsage(s.usage, info);
    this.deps.store.setUsage(account, merged);
    s.lastStatus = info.status;
    s.representativeClaim = info.representativeClaim;
    this.deps.bus.publish({ type: "usage", at: Date.now(), account, usage: merged });
  }

  private async pipeResponse(
    up: Dispatcher.ResponseData,
    res: ServerResponse,
    rec: { chunk(b: Buffer): void; finish(e?: string | null): void } | null,
    extra: Record<string, string> = {},
  ): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) {
      if (v === undefined || k === "connection" || k === "keep-alive" || k === "transfer-encoding") continue;
      headers[k] = v as string | string[];
    }
    Object.assign(headers, extra);
    if (res.destroyed) {
      up.body.destroy();
      rec?.finish("client closed");
      return;
    }
    res.writeHead(up.statusCode, headers);
    try {
      for await (const chunk of up.body) {
        if (res.destroyed) {
          up.body.destroy();
          rec?.finish("client closed");
          return;
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        rec?.chunk(buf);
        if (!res.write(buf)) {
          // wait for drain, but never for a client that has gone away
          await new Promise<void>((r) => {
            const done = () => {
              res.off("drain", done);
              res.off("close", done);
              r();
            };
            res.once("drain", done);
            res.once("close", done);
          });
        }
      }
      res.end();
      rec?.finish(null);
    } catch (err: any) {
      rec?.finish(res.destroyed ? "client closed" : `stream: ${err.message}`);
      if (!res.destroyed) res.destroy(err);
    }
  }

  private async passthrough(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    try {
      const up = await undiciRequest(url, {
        method: req.method as Dispatcher.HttpMethod,
        headers: upstreamHeaders(req, null),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
        dispatcher: this.agent,
      });
      await this.pipeResponse(up, res, null);
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `claudemanager upstream error: ${err.message}` } }));
      }
    }
  }

  async close(): Promise<void> {
    this.affinity.flush();
    await this.agent.close();
  }
}
