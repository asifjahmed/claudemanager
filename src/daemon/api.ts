import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../core/config.js";
import { nativeRoutingUrl, setNativeRouting, directTokenFromSettings, directAccountFor } from "../core/settings.js";
import { getInferenceToken } from "../core/inference-token.js";
import type { AccountStore } from "../core/accounts.js";
import type { EventBus } from "../core/events.js";
import type { Db } from "../core/db.js";
import type { Proxy } from "./proxy.js";
import type { Poller } from "./poller.js";
import type { PerfMonitor } from "./perf.js";
import type { CmEvent } from "../core/types.js";
import { eligibility } from "../core/router.js";
import { analyzeRunway, consumedAccountPct } from "../core/runway.js";
import { attribute } from "../core/attribution.js";
import { contextReport } from "../core/context-growth.js";
import { modelFamily, readStockLogin } from "../core/claude-internals.js";
import type { WebhookDispatcher } from "./webhooks.js";
import type { JobRunner } from "./jobs.js";
import { renameAccount, removeAccount, claudeCliAvailable, AccountOpError, validName } from "../core/account-ops.js";
import { invalidateCredentialCache } from "../core/credentials.js";
import { clearInferenceTokenCache } from "../core/inference-token.js";

export interface ApiDeps {
  config: () => Config;
  reloadConfig: () => Config;
  /** persist a config change and apply it to the running daemon */
  applyConfig: (mutate: (c: Config) => void) => Config;
  store: AccountStore;
  bus: EventBus;
  db: Db | null;
  proxy: Proxy;
  poller: Poller;
  startedAt: number;
  version: string;
  log: (msg: string) => void;
  perf: PerfMonitor;
  /** the port the server actually listens on */
  port: () => number;
  webhooks: WebhookDispatcher;
  jobs: JobRunner;
  offers: () => import("./server.js").OfferPlan[];
  offerStore: import("./offer-store.js").OfferStore;
  /** last computed direct-routing info (refreshed on state requests) */
  directCache: () => { account: string | null; options: Array<{ name: string; email: string | null; hasToken: boolean }> } | null;
  setDirectCache: (v: { account: string | null; options: Array<{ name: string; email: string | null; hasToken: boolean }> }) => void;
  writerMode: () => "worker" | "inline" | "inline (worker crashed)" | null;
}

/** Accounts that can be the direct account (they have a long-lived token) and which one currently is. */
export async function directRouting(deps: ApiDeps) {
  const tokens: Record<string, string | null> = {};
  for (const a of deps.store.all()) tokens[a.name] = await getInferenceToken(a.name);
  const current = directAccountFor(directTokenFromSettings(), tokens);
  return {
    account: current,
    options: deps.store.all().map((a) => ({ name: a.name, email: a.email, hasToken: !!tokens[a.name] })),
  };
}

export function buildState(deps: ApiDeps) {
  const cfg = deps.config();
  const now = Date.now();
  const policy = {
    threshold: cfg.threshold,
    weeklyThreshold: cfg.weeklyThreshold,
    pinned: cfg.pinned,
    preferSoonerReset: cfg.preferSoonerReset,
    perishableHours: cfg.perishableHours,
  };
  deps.store.clearExpiredExhaustion(now);
  return {
    version: deps.version,
    startedAt: deps.startedAt,
    now,
    port: cfg.port,
    current: deps.proxy.routerState.current,
    /** active sessions (last 10 min) per account */
    sessions: deps.proxy.affinity.activeByAccount(),
    pinned: cfg.pinned,
    policy,
    pollIntervalSec: cfg.pollIntervalSec,
    accounts: deps.store.all().map((a) => {
      const acct = cfg.accounts.find((c) => c.name === a.name);
      const e = eligibility(a, policy, null, now);
      return {
        ...a,
        configDir: acct?.configDir ?? null,
        eligible: e.eligible,
        ineligibleReason: e.reason,
        eligibilityTier: e.tier,
        minHeadroom: e.minHeadroom,
      };
    }),
    events: deps.bus.recent(100),
    db: deps.db ? deps.db.counts() : null,
    log: cfg.log,
    perf: deps.perf.report(),
    writerMode: deps.writerMode(),
    /** base URL new Claude Code sessions use (from ~/.claude/settings.json), or null = stock */
    nativeRouting: nativeRoutingUrl(),
    baseUrl: `http://127.0.0.1:${deps.port()}`,
    /** the stored ~/.claude login, used directly when no direct account is selected */
    stockAccount: readStockLogin(),
    /** filled asynchronously by /api/state; see directRouting() */
    direct: deps.directCache(),
    jobs: deps.jobs.list(),
    offers: deps.offers().map((x) => ({ ...x.offer, plan: x.plan })),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const t = Buffer.concat(chunks).toString("utf8");
      if (!t.trim()) return resolve({});
      try {
        resolve(JSON.parse(t));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Only the daemon's own origin may use the control API (DNS-rebinding / cross-site guard). */
export function isLocalRequest(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  const okHost = host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  if (!okHost) return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return false;
  return true;
}

export async function handleApi(deps: ApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const m = req.method ?? "GET";
  const port = deps.port();
  if (!isLocalRequest(req, port)) return json(res, 403, { error: "control API accepts requests from the daemon's own origin only" });
  if (
    m === "POST" &&
    !(req.headers["content-type"] ?? "").includes("application/json") &&
    req.headers["content-length"] !== "0" &&
    req.headers["content-length"] !== undefined
  ) {
    return json(res, 415, { error: "POST bodies must be application/json" });
  }
  try {
    if (p === "/api/state" && m === "GET") {
      deps.setDirectCache(await directRouting(deps));
      return json(res, 200, buildState(deps));
    }
    if (p === "/api/health" && m === "GET") return json(res, 200, { ok: true, version: deps.version, pid: process.pid });

    if (p === "/api/events" && m === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const send = (ev: string, data: unknown) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      deps.setDirectCache(await directRouting(deps));
      send("state", buildState(deps));
      // state frames are coalesced: at most one per 500 ms per client, and skipped while the client's socket is backed up
      let stateTimer: NodeJS.Timeout | null = null;
      const scheduleState = () => {
        if (stateTimer) return;
        stateTimer = setTimeout(() => {
          stateTimer = null;
          if (res.destroyed) return;
          if (res.writableLength > 4 * 1024 * 1024) return; // a backgrounded tab; it catches up on the next event
          send("state", buildState(deps));
        }, 500);
      };
      const NOTIFY = new Set(["switch", "exhausted", "all_exhausted", "error", "fallback", "assign", "limit", "model_fallback", "free_reset"]);
      const unsub = deps.bus.subscribe((ev: CmEvent) => {
        if (ev.type === "usage" || ev.type === "state") scheduleState();
        else if (NOTIFY.has(ev.type)) {
          send(ev.type, ev);
          scheduleState();
        } else if (ev.type === "request") {
          if (res.writableLength < 4 * 1024 * 1024) send("request", ev.request);
        }
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        if (stateTimer) clearTimeout(stateTimer);
        unsub();
      });
      return;
    }

    if (p === "/api/refresh" && m === "POST") {
      await deps.poller.pollAll();
      return json(res, 200, buildState(deps));
    }
    if (p === "/api/reload" && m === "POST") {
      const cfg = deps.reloadConfig();
      deps.store.sync(cfg.accounts);
      // A reload usually follows `cm accounts login|set-token`: drop caches and rechecks so it shows up now.
      invalidateCredentialCache();
      clearInferenceTokenCache();
      for (const a of deps.store.all()) if (a.needsLogin) deps.poller.resetBackoff(a.name);
      deps.bus.publish({ type: "state", at: Date.now() });
      void deps.poller.pollAll();
      return json(res, 200, buildState(deps));
    }
    if (p === "/api/policy" && m === "POST") {
      const body = await readJson(req);
      const cfg = deps.applyConfig((c) => {
        if (typeof body.threshold === "number") c.threshold = body.threshold;
        if (typeof body.weeklyThreshold === "number") c.weeklyThreshold = body.weeklyThreshold;
        if (body.pinned === null || typeof body.pinned === "string") c.pinned = body.pinned;
        if (typeof body.preferSoonerReset === "boolean") c.preferSoonerReset = body.preferSoonerReset;
        if (typeof body.perishableHours === "number") c.perishableHours = body.perishableHours;
        if (typeof body.modelAwareAllocation === "boolean") c.modelAwareAllocation = body.modelAwareAllocation;
        if (typeof body.distribute === "boolean") c.distribute = body.distribute;
        if (body.offers && typeof body.offers === "object") {
          const f = body.offers;
          if (typeof f.concentrate === "boolean") c.offers.concentrate = f.concentrate;
          if (typeof f.minUtil === "number") c.offers.minUtil = f.minUtil;
          if (typeof f.minHoursBeforeNaturalReset === "number") c.offers.minHoursBeforeNaturalReset = f.minHoursBeforeNaturalReset;
          if (f.feedUrl === null || typeof f.feedUrl === "string") c.offers.feedUrl = f.feedUrl;
        }
        if (body.log && typeof body.log === "object") Object.assign(c.log, body.log);
      });
      if (cfg.pinned && deps.store.get(cfg.pinned)) deps.proxy.setCurrent(cfg.pinned, "pinned");
      deps.bus.publish({ type: "state", at: Date.now() });
      return json(res, 200, buildState(deps));
    }
    // ---- account management from the dashboard ----
    if (p === "/api/accounts" && m === "POST") {
      const body = await readJson(req);
      const name = String(body.name ?? "").trim();
      if (!validName(name)) return json(res, 400, { error: "name must be 1–40 characters of letters, digits, . _ -" });
      if (deps.config().accounts.some((a) => a.name === name)) return json(res, 409, { error: `account "${name}" already exists` });
      if (!(await claudeCliAvailable()))
        return json(res, 503, { error: "the `claude` CLI is not on the daemon's PATH; install Claude Code or add the account with `cm accounts add`" });
      const job = deps.jobs.start("login", name, { email: typeof body.email === "string" ? body.email : undefined });
      return json(res, 202, { job });
    }
    const acctOp = /^\/api\/accounts\/([^/]+)\/(login|setup-token|rename)$/.exec(p);
    if (acctOp && m === "POST") {
      const name = decodeURIComponent(acctOp[1]);
      if (!deps.config().accounts.some((a) => a.name === name)) return json(res, 404, { error: `unknown account ${name}` });
      if (acctOp[2] === "rename") {
        const body = await readJson(req);
        try {
          await renameAccount(name, String(body.name ?? "").trim());
        } catch (err: any) {
          return json(res, err instanceof AccountOpError ? 400 : 500, { error: err.message });
        }
        const cfg = deps.reloadConfig();
        deps.store.sync(cfg.accounts);
        deps.proxy.affinity.renameAccount(name, String(body.name).trim());
        if (deps.proxy.routerState.current === name) deps.proxy.routerState.current = String(body.name).trim();
        deps.bus.publish({ type: "state", at: Date.now() });
        return json(res, 200, buildState(deps));
      }
      if (!(await claudeCliAvailable())) return json(res, 503, { error: "the `claude` CLI is not on the daemon's PATH" });
      const job = deps.jobs.start(acctOp[2] as "login" | "setup-token", name);
      return json(res, 202, { job });
    }
    const acctDel = /^\/api\/accounts\/([^/]+)$/.exec(p);
    if (acctDel && m === "DELETE") {
      const name = decodeURIComponent(acctDel[1]);
      try {
        removeAccount(name);
      } catch (err: any) {
        return json(res, 404, { error: err.message });
      }
      const cfg = deps.reloadConfig();
      deps.store.sync(cfg.accounts);
      deps.bus.publish({ type: "state", at: Date.now() });
      return json(res, 200, buildState(deps));
    }
    const jobCancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(p);
    if (jobCancel && m === "POST") return json(res, 200, { cancelled: deps.jobs.cancel(jobCancel[1]) });
    if (p === "/api/jobs" && m === "GET") return json(res, 200, deps.jobs.list());

    if (p === "/api/offers" && m === "GET")
      return json(res, 200, {
        active: deps.offers().map((x) => ({ ...x.offer, plan: x.plan })),
        all: deps.offerStore.all(),
        disabled: deps.config().offers.disabled,
        feedUrl: deps.config().offers.feedUrl,
        lastFeedError: deps.offerStore.lastFeedError,
      });
    if (p === "/api/offers/refresh" && m === "POST") {
      const changed = await deps.offerStore.maybeRefresh(true);
      deps.bus.publish({ type: "state", at: Date.now() });
      return json(res, 200, { changed, error: deps.offerStore.lastFeedError, active: deps.offers().map((x) => x.offer.id) });
    }
    const off = /^\/api\/offers\/([^/]+)\/(enable|disable)$/.exec(p);
    if (off && m === "POST") {
      const id = decodeURIComponent(off[1]);
      deps.applyConfig((c) => {
        c.offers.disabled = c.offers.disabled.filter((x) => x !== id);
        if (off[2] === "disable") c.offers.disabled.push(id);
      });
      deps.bus.publish({ type: "state", at: Date.now() });
      return json(res, 200, buildState(deps));
    }
    const fr = /^\/api\/offers\/([^/]+)\/([^/]+)\/(used|unused)$/.exec(p);
    if (fr && m === "POST") {
      const id = decodeURIComponent(fr[1]);
      const name = decodeURIComponent(fr[2]);
      if (!deps.store.get(name)) return json(res, 404, { error: `unknown account ${name}` });
      deps.applyConfig((c) => {
        c.offers.used[id] ??= {};
        if (fr[3] === "used") (c.offers.used[id][name] ??= []).push(new Date().toISOString());
        else delete c.offers.used[id][name];
      });
      if (fr[3] === "used") deps.bus.publish({ type: "free_reset", at: Date.now(), account: name, kind: "used", detail: "marked by hand" });
      deps.bus.publish({ type: "state", at: Date.now() });
      return json(res, 200, buildState(deps));
    }
    const pin = /^\/api\/accounts\/([^/]+)\/pin$/.exec(p);
    if (pin && m === "POST") {
      const name = decodeURIComponent(pin[1]);
      if (!deps.store.get(name)) return json(res, 404, { error: `unknown account ${name}` });
      deps.applyConfig((c) => {
        c.pinned = name;
      });
      deps.proxy.setCurrent(name, "pinned");
      deps.bus.publish({ type: "state", at: Date.now() });
      return json(res, 200, buildState(deps));
    }
    if (p === "/api/unpin" && m === "POST") {
      deps.applyConfig((c) => {
        c.pinned = null;
      });
      deps.bus.publish({ type: "state", at: Date.now() });
      return json(res, 200, buildState(deps));
    }
    const dis = /^\/api\/accounts\/([^/]+)\/(enable|disable)$/.exec(p);
    if (dis && m === "POST") {
      const name = decodeURIComponent(dis[1]);
      if (!deps.store.get(name)) return json(res, 404, { error: `unknown account ${name}` });
      const cfg = deps.applyConfig((c) => {
        const a = c.accounts.find((x) => x.name === name);
        if (a) a.disabled = dis[2] === "disable";
      });
      deps.store.sync(cfg.accounts);
      deps.bus.publish({ type: "state", at: Date.now() });
      return json(res, 200, buildState(deps));
    }
    if (p === "/api/advice" && m === "GET") {
      return json(res, 200, deps.proxy.adviceFor(url.searchParams.get("session"), url.searchParams.get("model")));
    }
    if (p === "/api/wait" && m === "GET") {
      // Long-poll until the pool has headroom for a model family (or the session pool when no model is given).
      const model = url.searchParams.get("model");
      const min = Number(url.searchParams.get("min-headroom") ?? url.searchParams.get("minHeadroom") ?? 1);
      const timeoutS = Math.min(3600, Math.max(1, Number(url.searchParams.get("timeout") ?? 600)));
      const fam = modelFamily(model ?? undefined);
      const check = () => {
        const adv = deps.proxy.adviceFor(url.searchParams.get("session"), model);
        const f = fam ? adv.pool.families.find((x) => x.family === fam) : null;
        const headroom = f ? f.headroom : adv.pool.session.headroom;
        const ok = headroom >= min && (f ? f.eligibleAccounts > 0 : true) && adv.advice.action !== "pause";
        return { ok, headroom, adv };
      };
      const first = check();
      if (first.ok) return json(res, 200, { satisfied: true, waitedMs: 0, headroom: first.headroom, advice: first.adv });
      const started = Date.now();
      let done = false;
      const finish = (satisfied: boolean, headroom: number, adv: unknown) => {
        if (done) return;
        done = true;
        clearInterval(tick);
        clearTimeout(deadline);
        unsub();
        json(res, 200, { satisfied, waitedMs: Date.now() - started, headroom, advice: adv });
      };
      const recheck = () => {
        const r = check();
        if (r.ok) finish(true, r.headroom, r.adv);
      };
      let pending: NodeJS.Timeout | null = null;
      const unsub = deps.bus.subscribe((ev) => {
        if ((ev.type === "usage" || ev.type === "limit" || ev.type === "state") && !pending) {
          pending = setTimeout(() => {
            pending = null;
            recheck();
          }, 250);
        }
      });
      const tick = setInterval(recheck, 30_000);
      const deadline = setTimeout(() => {
        const r = check();
        finish(false, r.headroom, r.adv);
      }, timeoutS * 1000);
      req.on("close", () => {
        if (!done) {
          done = true;
          clearInterval(tick);
          clearTimeout(deadline);
          unsub();
        }
      });
      return;
    }
    if (p === "/api/webhooks/test" && m === "POST") {
      const body = await readJson(req);
      if (typeof body.url !== "string") return json(res, 400, { error: "expected {url, secret?}" });
      const status = await deps.webhooks.deliver(body.url, typeof body.secret === "string" ? body.secret : undefined, "ping", {
        message: "hello from claudemanager",
      });
      return json(res, 200, { delivered: status !== null && status < 400, status });
    }
    if (p === "/api/route" && m === "POST") {
      const body = await readJson(req);
      if (typeof body.on !== "boolean") return json(res, 400, { error: "expected {on: boolean, account?: string | null}" });
      try {
        let directToken: string | null | undefined = undefined;
        let label = "";
        if (!body.on && body.account !== undefined) {
          if (body.account === null || body.account === "stock") {
            directToken = null;
            label = " as the stored ~/.claude login";
          } else {
            const name = String(body.account);
            if (!deps.store.get(name)) return json(res, 404, { error: `unknown account ${name}` });
            const tok = await getInferenceToken(name, false);
            if (!tok)
              return json(res, 409, {
                error: `${name} has no long-lived token; set one up first (Set up long-lived token in its menu, or cm accounts set-token ${name})`,
              });
            directToken = tok;
            label = ` as ${name}`;
          }
        }
        const r = setNativeRouting(body.on, { baseUrl: `http://127.0.0.1:${deps.port()}`, directToken });
        deps.log(`native routing ${body.on ? "on" : "off" + label} via dashboard${r.backup ? ` (backup ${r.backup})` : ""}`);
        deps.setDirectCache(await directRouting(deps));
        deps.bus.publish({ type: "state", at: Date.now() });
        return json(res, 200, { nativeRouting: r.url, direct: deps.directCache(), backup: r.backup });
      } catch (err: any) {
        return json(res, 409, { error: err.message });
      }
    }
    if (p === "/api/route" && m === "GET") {
      // dry run: what would the router pick for a new session right now? No state changes.
      const d = deps.proxy.preview(modelFamily(url.searchParams.get("model") ?? undefined));
      return json(res, 200, d);
    }

    // observability
    if (!deps.db) return json(res, 503, { error: "database disabled" });
    if (p === "/api/requests" && m === "GET") {
      const q = url.searchParams;
      return json(
        res,
        200,
        deps.db.listRequests({
          account: q.get("account") ?? undefined,
          model: q.get("model") ?? undefined,
          session: q.get("session") ?? undefined,
          q: q.get("q") ?? undefined,
          since: q.get("since") ? Number(q.get("since")) : undefined,
          before: q.get("before") ? Number(q.get("before")) : undefined,
          limit: q.get("limit") ? Number(q.get("limit")) : undefined,
          offset: q.get("offset") ? Number(q.get("offset")) : undefined,
        }),
      );
    }
    const one = /^\/api\/requests\/(\d+)$/.exec(p);
    if (one && m === "GET") {
      const r = deps.db.getRequest(Number(one[1]));
      return r ? json(res, 200, r) : json(res, 404, { error: "not found" });
    }
    if (p === "/api/sessions" && m === "GET") return json(res, 200, deps.db.listSessions(Number(url.searchParams.get("limit") ?? 100)));
    if (p === "/api/stats" && m === "GET") {
      const by = (url.searchParams.get("by") ?? "account") as "account" | "model" | "day";
      const since = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined;
      return json(res, 200, deps.db.stats(["account", "model", "day"].includes(by) ? by : "account", since));
    }
    if (p === "/api/usage-history" && m === "GET") {
      return json(res, 200, deps.db.usageHistory(url.searchParams.get("account") ?? undefined, Number(url.searchParams.get("hours") ?? 24)));
    }
    if ((p === "/api/runway" || p === "/api/capacity") && m === "GET") {
      const cfg = deps.config();
      const since = Date.now() - 7 * 24 * 3600_000;
      const enabled = deps.store.all().filter((a) => !a.disabled);
      return json(
        res,
        200,
        analyzeRunway({
          snapshots: deps.db.usageHistory(undefined, 7 * 24),
          accounts: enabled.map((a) => ({
            account: a.name,
            fiveHour: a.usage?.fiveHour ?? { utilization: null, resetsAt: null },
            sevenDay: a.usage?.sevenDay ?? { utilization: null, resetsAt: null },
            models: a.usage?.models ?? {},
          })),
          signals: {
            relaxedEvents: deps.db.countEvents("switch", since, '"reason":"relaxed"') + deps.db.countEvents("assign", since, '"relaxed":true'),
            fallbackEvents: deps.db.countEvents("fallback", since),
            dryEvents: deps.db.countEvents("all_exhausted", since, '"cause":"limits"'),
          },
          modelUsage24h: deps.db.stats("model", Date.now() - 24 * 3600_000) as any,
          modelUsage7d: deps.db.stats("model", since) as any,
          threshold: cfg.threshold,
          weeklyThreshold: cfg.weeklyThreshold,
        }),
      );
    }
    if (p === "/api/attribution" && m === "GET") {
      const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours") ?? 24)));
      const sinceMs = Date.now() - hours * 3600_000;
      const snaps = deps.db.usageHistory(undefined, hours);
      const familyCosts: Record<string, Record<string, number>> = {};
      for (const r of deps.db.sessionModelCosts(sinceMs)) {
        const fam = modelFamily(r.model ?? undefined) ?? "other";
        (familyCosts[r.sessionId] ??= {})[fam] = (familyCosts[r.sessionId][fam] ?? 0) + r.estCostUsd;
      }
      const out = attribute({
        sessions: deps.db.sessionUsage(sinceMs, Number(url.searchParams.get("limit") ?? 100)),
        weeklyConsumed: consumedAccountPct(snaps, (r) => r.sevenDayUtil),
        sessionConsumed: consumedAccountPct(snaps, (r) => r.fiveHourUtil),
        familyCosts,
      });
      return json(res, 200, {
        hours,
        ...out,
        weeklyConsumed: consumedAccountPct(snaps, (r) => r.sevenDayUtil),
        sessionConsumed: consumedAccountPct(snaps, (r) => r.fiveHourUtil),
      });
    }
    const ctx = /^\/api\/sessions\/([^/]+)\/context$/.exec(p);
    if (ctx && m === "GET") {
      const sid = decodeURIComponent(ctx[1]);
      const rows = deps.db.sessionTurns(sid);
      if (!rows.length) return json(res, 404, { error: "unknown session" });
      return json(res, 200, { sessionId: sid, ...contextReport(rows, deps.db.latestBody(sid)) });
    }
    if (p === "/api/db-events" && m === "GET") return json(res, 200, deps.db.recentEvents(Number(url.searchParams.get("limit") ?? 100)));
    if (p === "/api/purge" && m === "POST") {
      const body = await readJson(req);
      const n = deps.db.purge(typeof body.before === "number" ? body.before : undefined);
      return json(res, 200, { deleted: n, ...deps.db.counts() });
    }
    return json(res, 404, { error: "not found" });
  } catch (err: any) {
    deps.log(`api error ${m} ${p}: ${err?.stack ?? err}`);
    if (!res.headersSent) json(res, 500, { error: err?.message ?? String(err) });
  }
}
