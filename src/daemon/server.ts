import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig, updateConfig, ConfigSchema, type Config, DB_PATH, CM_HOME } from "../core/config.js";
import { AccountStore } from "../core/accounts.js";
import { EventBus } from "../core/events.js";
import { Db } from "../core/db.js";
import { getFreshToken } from "../core/credentials.js";
import { PASSTHROUGH_PATH_PREFIXES } from "../core/claude-internals.js";
import { renameSync } from "node:fs";
import { getInferenceToken } from "../core/inference-token.js";
import { Proxy } from "./proxy.js";
import { Poller } from "./poller.js";
import { Recorder, WorkerWriter, InlineWriter, type DbWriter } from "./recorder.js";
import { PerfMonitor } from "./perf.js";
import { LimitTracker } from "../core/limits.js";
import { WebhookDispatcher } from "./webhooks.js";
import { JobRunner } from "./jobs.js";
import { planFreeResets, FreeResetDetector, type FreeResetResult } from "../core/free-reset.js";
import { OfferStore } from "./offer-store.js";
import type { Offer } from "../core/offers.js";

export interface OfferPlan {
  offer: Offer;
  plan: FreeResetResult;
}
import { burnPerHourFor } from "../core/runway.js";
import { invalidateCredentialCache } from "../core/credentials.js";
import { clearInferenceTokenCache, invalidateInferenceToken } from "../core/inference-token.js";
import { handleApi, type ApiDeps } from "./api.js";
import { serveStatic } from "./static.js";

import { VERSION } from "../core/version.js";
export { VERSION };

export interface DaemonOptions {
  config?: Config;
  dbPath?: string | null;
  log?: (msg: string) => void;
  webRoot?: string;
  fetchImpl?: typeof fetch;
  /** resolves a bearer token for an account (tests inject a fake) */
  getToken?: (configDir: string, opts?: { force?: boolean }) => Promise<string>;
  dispatcher?: import("undici").Dispatcher;
  /** force the write path; default: worker when the compiled worker exists and the db is a file */
  writer?: "worker" | "inline";
  /** session affinity persistence file; null = memory only (default: ~/.claudemanager/affinity.json when logging to a file db) */
  affinityPath?: string | null;
}

export interface Daemon {
  server: Server;
  proxy: Proxy;
  poller: Poller;
  store: AccountStore;
  bus: EventBus;
  db: Db | null;
  recorder: Recorder | null;
  /** wait until every queued recorder write has been applied (tests) */
  flush(): Promise<void>;
  config: () => Config;
  reload(): Config;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

function defaultWebRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const cand of [join(here, "..", "..", "web"), join(here, "..", "..", "..", "web")]) if (existsSync(cand)) return cand;
  return join(here, "..", "..", "web");
}

export function createDaemon(opts: DaemonOptions = {}): Daemon {
  const log = opts.log ?? ((m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`));
  let cfg = opts.config ?? loadConfig();
  const config = () => cfg;
  const reloadConfig = () => {
    cfg = opts.config ? cfg : loadConfig();
    return cfg;
  };
  const applyConfig = (mutate: (c: Config) => void): Config => {
    if (opts.config) {
      mutate(cfg);
      cfg = ConfigSchema.parse(cfg);
    } else {
      cfg = updateConfig(mutate);
    }
    return cfg;
  };
  const bus = new EventBus();
  const store = new AccountStore(cfg.accounts);
  const perf = new PerfMonitor();
  const dbPath = opts.dbPath === null ? null : (opts.dbPath ?? DB_PATH);
  // Writes go through a worker thread so parsing/compression/SQLite never block the proxy's event loop.
  // The main thread keeps a second connection for reads (WAL allows concurrent readers).
  let writer: DbWriter | null = null;
  let db: Db | null = null;
  if (dbPath) {
    const useWorker = opts.writer === "worker" || (opts.writer === undefined && dbPath !== ":memory:" && WorkerWriter.available());
    const openDb = (): Db => (useWorker ? new Db(dbPath, { readOnly: false, busyTimeoutMs: 500 }) : new Db(dbPath));
    try {
      db = openDb();
    } catch (err: any) {
      // The proxy must come up regardless of logging: move the unreadable file aside and start fresh.
      if (dbPath !== ":memory:" && existsSync(dbPath)) {
        const aside = `${dbPath}.corrupt-${Date.now()}`;
        try {
          renameSync(dbPath, aside);
          for (const sfx of ["-wal", "-shm"]) if (existsSync(dbPath + sfx)) renameSync(dbPath + sfx, aside + sfx);
          log(`WARNING: could not open ${dbPath} (${err?.message ?? err}); moved it to ${aside} and starting a fresh database`);
          db = openDb();
        } catch (err2: any) {
          log(`WARNING: request logging disabled: ${err2?.message ?? err2}`);
        }
      } else {
        log(`WARNING: request logging disabled: ${err?.message ?? err}`);
      }
    }
    if (db) {
      if (useWorker) {
        const ww = new WorkerWriter(dbPath, Recorder.onReply(bus), log, (inline) => (writer = inline));
        ww.fallbackDb = db;
        writer = ww;
      } else {
        writer = new InlineWriter(db, Recorder.onReply(bus));
      }
    }
  }
  const recorder = writer ? new Recorder(() => writer!, config, bus, log) : null;
  // limit events (reset / approaching / exhausted / recovered) derived from every usage update
  const limits = new LimitTracker(cfg.advice.approachingHeadroom);
  bus.subscribe((ev) => {
    if (ev.type !== "usage" && ev.type !== "request" && ev.type !== "state") recorder?.event(ev);
    if (ev.type === "request") perf.record(ev.request.overheadMs ?? null, ev.request.ttfbMs ?? null);
    if (ev.type === "usage") {
      for (const le of limits.update(ev.account, ev.usage, store.all())) {
        log(
          `limit ${le.kind}${"family" in le ? ` ${le.family} (${Math.round(le.headroom)}% pooled)` : ` ${le.account} ${le.window} (+${Math.round(le.freed)}%)`}`,
        );
        bus.publish({ type: "limit", at: Date.now(), ...le });
      }
    }
  });
  const webhooks = new WebhookDispatcher(config, log, opts.fetchImpl);
  webhooks.subscribe(bus);
  // dashboard-driven login / setup-token jobs; when one finishes, pick up the new credentials immediately
  const jobs = new JobRunner(bus, log, () => {
    const c = reloadConfig();
    store.sync(c.accounts);
    invalidateCredentialCache();
    clearInferenceTokenCache();
    for (const a of store.all()) if (a.needsLogin) poller.resetBackoff(a.name);
    void poller.pollAll();
  });

  const getToken = async (account: string, o?: { force?: boolean }): Promise<string> => {
    const a = config().accounts.find((x) => x.name === account);
    if (!a) throw new Error(`unknown account ${account}`);
    if (opts.getToken) return opts.getToken(a.configDir, o);
    // Traffic path prefers a long-lived `claude setup-token` token: no refresh, nothing to lose on a bad network.
    // `force` means the last token was rejected (401), so fall through to the refreshable login instead.
    if (!o?.force) {
      const long = await getInferenceToken(account);
      if (long) return long;
    } else {
      // the last request was rejected with 401 while a long-lived token was in use: stop offering it
      const s0 = store.get(account);
      if (s0?.hasInferenceToken) {
        invalidateInferenceToken(account);
        s0.hasInferenceToken = false;
        store.setError(account, `long-lived token rejected upstream (401); run: cm accounts set-token ${account}`);
        log(`${account}: long-lived token rejected upstream; falling back to the login`);
      }
    }
    // A live request means the machine is awake; the preflight and the global hold still guard the refresh itself.
    const creds = await getFreshToken(a.configDir, { force: o?.force, fetchImpl: opts.fetchImpl, minTtlMs: 60_000, log });
    const s = store.get(account);
    if (s) {
      s.tokenExpiresAt = creds.expiresAt;
      s.tokenOk = true;
      s.needsLogin = false;
    }
    return creds.accessToken;
  };

  // ---- promotions ("offers"): per active free-reset offer, plan, detect use, and feed the drain target to routing ----
  const offerStore = new OfferStore(config, log, opts.fetchImpl, () => bus.publish({ type: "state", at: Date.now() }));
  let offerPlans: OfferPlan[] = [];
  let offersComputedAt = 0;
  // snapshot rows change only when the poller inserts one; never re-query them on the request path
  let snapCache: { at: number; rows: ReturnType<Db["usageHistory"]> } | null = null;
  const snapshots = () => {
    const now = Date.now();
    if (!snapCache || now - snapCache.at > 60_000) snapCache = { at: now, rows: db ? db.usageHistory(undefined, 7 * 24) : [] };
    return snapCache.rows;
  };
  const computeOffers = (): OfferPlan[] => {
    const c = config();
    const now = Date.now();
    offersComputedAt = now;
    if (!offerStore.active(now).length) return (offerPlans = []);
    const snaps = snapshots();
    const pooled = burnPerHourFor(snaps, (r) => r.sevenDayUtil, 7 * 24, now);
    offerPlans = offerStore
      .active(now)
      .filter((o) => o.kind === "free-reset")
      .map((offer) => {
        const usedFor = c.offers.used[offer.id] ?? {};
        const accounts = store.all().map((a) => {
          const u = a.usage;
          let bindingWindow = "weekly";
          let weeklyUtil = u?.sevenDay.utilization ?? null;
          if (offer.resets.includes("model")) {
            for (const [k, w] of Object.entries(u?.models ?? {})) {
              if (w.utilization !== null && (weeklyUtil === null || w.utilization > weeklyUtil)) {
                weeklyUtil = w.utilization;
                bindingWindow = k;
              }
            }
          }
          return {
            account: a.name,
            weeklyUtil,
            bindingWindow,
            weeklyResetsAt: u?.sevenDay.resetsAt ?? null,
            fiveHourUtil: u?.fiveHour.utilization ?? null,
            ownBurnPerHour: burnPerHourFor(
              snaps.filter((r) => r.account === a.name),
              (r) => r.sevenDayUtil,
              7 * 24,
              now,
            ),
            used: usedFor[a.name] ?? [],
            disabled: a.disabled,
          };
        });
        const plan = planFreeResets({
          offerId: offer.id,
          usesPerAccount: offer.usesPerAccount,
          accounts,
          deadline: offer.deadline,
          pooledBurnPerHour: pooled,
          concentrate: c.offers.concentrate,
          minUtil: c.offers.minUtil,
          minHoursBeforeNaturalReset: c.offers.minHoursBeforeNaturalReset,
          now,
        });
        return { offer, plan };
      })
      // a finished offer disappears from the UI and from routing
      .filter((x) => !x.plan.complete);
    return offerPlans;
  };
  const detector = new FreeResetDetector();
  const recommended = new Set<string>();
  bus.subscribe((ev) => {
    if (ev.type !== "usage") return;
    // header-driven usage events arrive per proxied response; the planner runs on poll snapshots and on its timer
    const plans = ev.usage.source === "poll" || Date.now() - offersComputedAt > 5 * 60_000 ? computeOffers() : offerPlans;
    if (!plans.length) return;
    const c = config();
    // a detected reset counts against the first active offer that still has a use left on this account
    if (detector.update(ev.account, ev.usage.sevenDay.utilization, ev.usage.sevenDay.resetsAt)) {
      const target = plans.find((x) => (c.offers.used[x.offer.id]?.[ev.account]?.length ?? 0) < x.offer.usesPerAccount);
      if (target) {
        applyConfig((cc) => {
          cc.offers.used[target.offer.id] ??= {};
          (cc.offers.used[target.offer.id][ev.account] ??= []).push(new Date().toISOString());
        });
        log(`free reset detected on ${ev.account} (${target.offer.id}): weekly dropped while its natural reset was still ahead`);
        bus.publish({
          type: "free_reset",
          at: Date.now(),
          account: ev.account,
          kind: "used",
          detail: `${target.offer.title}: weekly window dropped while its natural reset was still ahead`,
        });
        computeOffers();
      }
    }
    for (const x of offerPlans) {
      for (const p of x.plan.plans) {
        const key = `${x.offer.id}|${p.account}`;
        if (p.status === "reset-now" && !recommended.has(key)) {
          recommended.add(key);
          log(`free reset recommended now on ${p.account} (${x.offer.id}): ${p.reason}`);
          bus.publish({ type: "free_reset", at: Date.now(), account: p.account, kind: "recommended", detail: `${x.offer.title}: ${p.reason}` });
        } else if (p.status !== "reset-now") recommended.delete(key);
      }
    }
  });

  const proxy = new Proxy({
    config,
    store,
    bus,
    getToken,
    recorder,
    perf,
    log,
    drainAccount: () => (offersComputedAt ? offerPlans : computeOffers()).find((x) => x.plan.drainTarget)?.plan.drainTarget ?? null,
    dispatcher: opts.dispatcher,
    affinityPath: opts.affinityPath === undefined ? (dbPath && dbPath !== ":memory:" ? join(CM_HOME, "affinity.json") : null) : opts.affinityPath,
  });
  const poller = new Poller({
    config,
    store,
    bus,
    recorder,
    current: () => proxy.routerState.current,
    log,
    fetchImpl: opts.fetchImpl,
    // an injected token source (tests, cm demo) feeds the poller too, so synthetic accounts poll like real ones
    getCreds: opts.getToken ? async (configDir) => ({ accessToken: await opts.getToken!(configDir), expiresAt: Date.now() + 3600_000 }) : undefined,
  });
  const webRoot = opts.webRoot ?? defaultWebRoot();
  const startedAt = Date.now();
  let boundPort = cfg.port;
  let directCache: { account: string | null; options: Array<{ name: string; email: string | null; hasToken: boolean }> } | null = null;
  const apiDeps: ApiDeps = {
    config,
    reloadConfig,
    applyConfig,
    store,
    bus,
    db,
    proxy,
    poller,
    startedAt,
    version: VERSION,
    log,
    perf,
    port: () => boundPort,
    webhooks,
    jobs,
    offers: () => (offersComputedAt ? offerPlans : computeOffers()),
    offerStore,
    directCache: () => directCache,
    setDirectCache: (v) => (directCache = v),
    writerMode: () => writer?.mode ?? null,
  };

  const server = createServer((req, res) => {
    const raw = req.url ?? "/";
    const q = raw.indexOf("?");
    const path = q === -1 ? raw : raw.slice(0, q);
    if (path.startsWith("/api/") && !PASSTHROUGH_PATH_PREFIXES.some((p) => path.startsWith(p))) {
      void handleApi(apiDeps, req, res);
      return;
    }
    if (
      req.method === "GET" &&
      (path === "/" || path.startsWith("/app.") || path.startsWith("/style.") || path.startsWith("/index.html") || path.startsWith("/favicon"))
    ) {
      if (serveStatic(webRoot, req, res)) return;
    }
    void proxy.handle(req, res).catch((err) => {
      log(`proxy error: ${err?.stack ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(err?.message ?? err) } }));
      }
    });
  });
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;

  offerStore.start();
  const evictTimer = setInterval(() => proxy.affinity.evict(), 60_000);
  evictTimer.unref();
  // Re-plan on a timer too: statuses change with time alone (deadlines, natural resets) even when no request arrives.
  const replan = setInterval(() => {
    const before = JSON.stringify(offerPlans.map((x) => x.plan.plans.map((p) => p.status)));
    computeOffers();
    const after = JSON.stringify(offerPlans.map((x) => x.plan.plans.map((p) => p.status)));
    if (before !== after) bus.publish({ type: "state", at: Date.now() });
  }, 5 * 60_000);
  replan.unref();
  return {
    server,
    proxy,
    poller,
    store,
    bus,
    db,
    recorder,
    flush: () => writer?.flush() ?? Promise.resolve(),
    config,
    reload() {
      const c = reloadConfig();
      store.sync(c.accounts);
      bus.publish({ type: "state", at: Date.now() });
      return c;
    },
    async listen(port = cfg.port, host = "127.0.0.1") {
      if (writer instanceof WorkerWriter) await writer.ready;
      return new Promise<number>((resolve, reject) => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE")
            reject(new Error(`port ${port} is already in use (another daemon? try \`cm daemon status\`). Pick another with: cm config set port <n>`));
          else reject(err);
        });
        // macOS caps the backlog at kern.ipc.somaxconn (128 by default); a big number is harmless elsewhere
        server.listen({ port, host, backlog: 4096 }, () => {
          const addr = server.address();
          boundPort = typeof addr === "object" && addr ? addr.port : port;
          resolve(boundPort);
        });
      });
    },
    async close() {
      poller.stop();
      offerStore.stop();
      clearInterval(replan);
      clearInterval(evictTimer);
      // SSE / keep-alive clients would keep server.close() waiting forever; drop them.
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      await proxy.close();
      await writer?.close();
      db?.close();
    },
  };
}
