import { test } from "node:test";
import assert from "node:assert/strict";
import { createDaemon } from "../src/daemon/server.js";
import { ConfigSchema } from "../src/core/config.js";
import { startFakeUpstream } from "../src/dev/fake-upstream.js";
import { usage } from "./helpers.js";

async function setup(accounts: Record<string, { fiveHour: number; sevenDay?: number; exhausted?: boolean; transient429?: boolean }>) {
  const up = await startFakeUpstream({ accounts: Object.fromEntries(Object.entries(accounts).map(([n, a]) => [`tok-${n}`, a])) });
  const cfg = ConfigSchema.parse({
    upstream: up.url,
    threshold: 90,
    accounts: Object.keys(accounts).map((name) => ({ name, configDir: `/tmp/cm-test/${name}` })),
    log: { bodies: "full", retentionDays: 30, maxDbMb: 100 },
  });
  const d = createDaemon({
    config: cfg,
    dbPath: ":memory:",
    log: () => {},
    getToken: async (configDir) => `tok-${configDir.split("/").pop()}`,
  });
  // seed usage so routing is deterministic
  for (const [name, a] of Object.entries(accounts)) d.store.setUsage(name, usage(a.fiveHour * 100, (a.sevenDay ?? 0.1) * 100));
  const port = await d.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return {
    d,
    up,
    base,
    close: async () => {
      await d.close();
      await up.close();
    },
  };
}

const msg = (stream: boolean, model = "claude-fable-5-1") => ({
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer client-token" },
  body: JSON.stringify({
    model,
    stream,
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    metadata: { user_id: "user_x_account_11111111-2222-3333-4444-555555555555_session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  }),
});

test("routes to the account with most headroom, swaps the bearer token, streams SSE intact, records the request", async () => {
  const t = await setup({ a: { fiveHour: 0.7 }, b: { fiveHour: 0.2 } });
  try {
    const res = await fetch(`${t.base}/v1/messages`, msg(true));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.ok(text.includes("from tok-b"), text);
    assert.equal(t.up.seen[0].auth, "Bearer tok-b");
    assert.equal(t.up.seen[0].headers["accept-encoding"], undefined);
    assert.equal(t.d.proxy.routerState.current, "b");
    // header-derived usage applied
    assert.equal(t.d.store.get("b")!.usage!.fiveHour.utilization, 20);
    assert.equal(t.d.store.get("b")!.usage!.source, "headers");
    await t.d.flush();
    const rows = t.d.db!.listRequests();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account, "b");
    assert.equal(rows[0].statusCode, 200);
    assert.equal(rows[0].inputTokens, 10);
    assert.equal(rows[0].outputTokens, 3);
    assert.equal(rows[0].sessionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const detail = t.d.db!.getRequest(rows[0].id)!;
    assert.equal((detail.response!.content as any[])[0].text, "hello from tok-b");
    assert.equal(detail.body!.lastUserText, "hi");
  } finally {
    await t.close();
  }
});

test("sticky routing keeps the current account across requests", async () => {
  const t = await setup({ a: { fiveHour: 0.5 }, b: { fiveHour: 0.5 } });
  try {
    await (await fetch(`${t.base}/v1/messages`, msg(false))).text();
    const first = t.d.proxy.routerState.current!;
    // make the other one look better; should still stick
    const other = first === "a" ? "b" : "a";
    t.d.store.setUsage(other, usage(1, 1));
    await (await fetch(`${t.base}/v1/messages`, msg(false))).text();
    assert.equal(t.up.seen[1].auth, `Bearer tok-${first}`);
  } finally {
    await t.close();
  }
});

test("429 from upstream marks the account exhausted and retries once on the next account", async () => {
  const t = await setup({ a: { fiveHour: 0.1, exhausted: true }, b: { fiveHour: 0.5 } });
  try {
    const res = await fetch(`${t.base}/v1/messages`, msg(false));
    assert.equal(res.status, 200);
    const j = (await res.json()) as any;
    assert.equal(j.content[0].text, "hello from tok-b");
    assert.equal(t.up.seen.length, 2);
    assert.equal(t.up.seen[0].auth, "Bearer tok-a");
    assert.equal(t.up.seen[1].auth, "Bearer tok-b");
    assert.ok(t.d.store.get("a")!.exhaustedUntil! > Date.now());
    assert.equal(t.d.proxy.routerState.current, "b");
    await t.d.flush();
    const rows = t.d.db!.listRequests();
    assert.equal(rows[0].retried, true);
    assert.equal(rows[0].account, "b");
    assert.equal(rows[0].switchedFrom, "a");
    const events = t.d.bus.recent();
    assert.ok(events.some((e) => e.type === "exhausted" && e.account === "a"));
  } finally {
    await t.close();
  }
});

test("transient 429 without usage-limit headers passes through and does not exhaust the account", async () => {
  const t = await setup({ a: { fiveHour: 0.1, transient429: true }, b: { fiveHour: 0.5 } });
  try {
    const res = await fetch(`${t.base}/v1/messages`, msg(false));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "2");
    assert.equal(t.up.seen.length, 1);
    assert.equal(t.up.seen[0].auth, "Bearer tok-a");
    assert.equal(t.d.store.get("a")!.exhaustedUntil, null);
    assert.equal(t.d.proxy.routerState.current, "a");
    assert.ok(!t.d.bus.recent().some((e) => e.type === "exhausted"));
    const rows = t.d.db!.listRequests();
    assert.equal(rows[0].statusCode, 429);
    assert.equal(rows[0].account, "a");
  } finally {
    await t.close();
  }
});

test("no eligible account + caller has no credentials -> synthetic 429 with unified headers, no upstream call", async () => {
  const t = await setup({ a: { fiveHour: 1.0 }, b: { fiveHour: 0.5 } });
  try {
    t.d.store.markExhausted("b", Date.now() + 60_000, "five_hour");
    const m = msg(false);
    const res = await fetch(`${t.base}/v1/messages`, { ...m, headers: { "content-type": "application/json" } });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("retry-after"));
    assert.equal(res.headers.get("anthropic-ratelimit-unified-status"), "rate_limited");
    assert.equal(t.up.seen.length, 0);
    await t.d.flush();
    const rows = t.d.db!.listRequests();
    assert.equal(rows[0].error, "all accounts are at their limit");
  } finally {
    await t.close();
  }
});

test("FAIL OPEN: every account needs re-login -> request is forwarded with the caller's own login", async () => {
  const up = await startFakeUpstream({ accounts: { "client-token": { fiveHour: 0.3 } } });
  const cfg = ConfigSchema.parse({
    upstream: up.url,
    accounts: [
      { name: "a", configDir: "/tmp/cm-test/a" },
      { name: "b", configDir: "/tmp/cm-test/b" },
    ],
  });
  const d = createDaemon({
    config: cfg,
    dbPath: ":memory:",
    log: () => {},
    getToken: async () => {
      throw new Error("should not be called");
    },
  });
  for (const n of ["a", "b"]) Object.assign(d.store.get(n)!, { tokenOk: false, needsLogin: true });
  const port = await d.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, msg(false));
    assert.equal(res.status, 200);
    const j = (await res.json()) as any;
    assert.equal(j.content[0].text, "hello from client-token");
    assert.equal(up.seen[0].auth, "Bearer client-token");
    await d.flush();
    const rows = d.db!.listRequests();
    assert.equal(rows[0].account, "(passthrough)");
    assert.equal(rows[0].statusCode, 200);
    const fb = d.bus.recent().find((e) => e.type === "fallback") as any;
    assert.ok(fb && /re-login/.test(fb.reason));
  } finally {
    await d.close();
    await up.close();
  }
});

test("an account with a dead login but a long-lived inference token stays routable", async () => {
  const t = await setup({ a: { fiveHour: 0.1 } });
  try {
    Object.assign(t.d.store.get("a")!, { tokenOk: false, needsLogin: true, hasInferenceToken: true });
    const res = await fetch(`${t.base}/v1/messages`, msg(false));
    assert.equal(res.status, 200);
    assert.equal(t.up.seen[0].auth, "Bearer tok-a");
  } finally {
    await t.close();
  }
});

test("per-model weekly window steers fable traffic away but not sonnet", async () => {
  const t = await setup({ a: { fiveHour: 0.1 }, b: { fiveHour: 0.5 } });
  try {
    t.d.store.setUsage("a", usage(10, 10, { fable: 99 }));
    await (await fetch(`${t.base}/v1/messages`, msg(false, "claude-fable-5-1"))).text();
    assert.equal(t.up.seen[0].auth, "Bearer tok-b");
  } finally {
    await t.close();
  }
});

test("non-/v1 paths pass through with the caller's own auth", async () => {
  const t = await setup({ a: { fiveHour: 0.1 } });
  try {
    const res = await fetch(`${t.base}/api/oauth/profile`, { headers: { authorization: "Bearer client-token" } });
    const j = (await res.json()) as any;
    assert.equal(j.passthrough, true);
    assert.equal(j.auth, "Bearer client-token");
    await t.d.flush();
    assert.equal(t.d.db!.listRequests().length, 0);
  } finally {
    await t.close();
  }
});

test("control API: state, pin, policy, requests", async () => {
  const t = await setup({ a: { fiveHour: 0.1 }, b: { fiveHour: 0.2 } });
  try {
    const s = (await (await fetch(`${t.base}/api/state`)).json()) as any;
    assert.equal(s.accounts.length, 2);
    assert.equal(s.policy.threshold, 90);
    await (await fetch(`${t.base}/v1/messages`, msg(false))).text();
    await t.d.flush();
    const reqs = (await (await fetch(`${t.base}/api/requests`)).json()) as any[];
    assert.equal(reqs.length, 1);
    const one = (await (await fetch(`${t.base}/api/requests/${reqs[0].id}`)).json()) as any;
    assert.equal(one.body.messages[0].content, "hi");
    const sessions = (await (await fetch(`${t.base}/api/sessions`)).json()) as any[];
    assert.equal(sessions.length, 1);
    const stats = (await (await fetch(`${t.base}/api/stats?by=model`)).json()) as any[];
    assert.equal(stats[0].key, "claude-fable-5-1");
  } finally {
    await t.close();
  }
});

test("over-threshold accounts still serve when nothing is within thresholds (no fail-open, no 429)", async () => {
  const t = await setup({ a: { fiveHour: 0.95 }, b: { fiveHour: 0.99 } });
  try {
    const res = await fetch(`${t.base}/v1/messages`, msg(false));
    assert.equal(res.status, 200);
    assert.equal(t.up.seen[0].auth, "Bearer tok-a");
    await t.d.flush();
    assert.equal(t.d.db!.listRequests()[0].account, "a");
  } finally {
    await t.close();
  }
});

test("worker writer: recording happens off the event loop and lands in the database", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cm-worker-"));
  const up = await startFakeUpstream({ accounts: { "tok-a": { fiveHour: 0.1 } } });
  const cfg = ConfigSchema.parse({ upstream: up.url, accounts: [{ name: "a", configDir: "/tmp/cm-test/a" }] });
  const d = createDaemon({ config: cfg, dbPath: join(dir, "t.db"), writer: "worker", affinityPath: null, log: () => {}, getToken: async () => "tok-a" });
  const port = await d.listen(0);
  const seen: any[] = [];
  d.bus.subscribe((e) => {
    if (e.type === "request") seen.push(e);
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, msg(true));
    assert.equal(res.status, 200);
    await res.text();
    await d.flush();
    const rows = d.db!.listRequests();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outputTokens, 3);
    assert.ok(rows[0].overheadMs! >= 0 && rows[0].ttfbMs! >= 0);
    const detail = d.db!.getRequest(rows[0].id)!;
    assert.equal((detail.response!.content as any[])[0].text, "hello from tok-a");
    assert.equal(detail.body!.lastUserText, "hi");
    assert.ok(seen.length === 1 && seen[0].request.id === rows[0].id);
    assert.ok(!d.bus.recent().some((e) => e.type === "request"), "request events stay out of the event log");
  } finally {
    await d.close();
    await up.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const msgFor = (session: string, stream = false, model = "claude-fable-5-1") => ({
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer client-token", "x-claude-code-session-id": session },
  body: JSON.stringify({ model, stream, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
});
const S1 = "11111111-1111-1111-1111-111111111111";
const S2 = "22222222-2222-2222-2222-222222222222";

test("session affinity: sessions keep their account; only the affected session moves when its account trips", async () => {
  const t = await setup({ a: { fiveHour: 0.1 }, b: { fiveHour: 0.2 } });
  try {
    await (await fetch(`${t.base}/v1/messages`, msgFor(S1))).text();
    await (await fetch(`${t.base}/v1/messages`, msgFor(S2))).text();
    assert.equal(t.up.seen[0].auth, "Bearer tok-a");
    assert.equal(t.up.seen[1].auth, "Bearer tok-a"); // both start on the best account
    // a's session window fills completely: S1 must move (a cannot serve); S2 stays on a until it next asks
    t.d.store.setUsage("a", usage(100, 10));
    await (await fetch(`${t.base}/v1/messages`, msgFor(S1))).text();
    assert.equal(t.up.seen[2].auth, "Bearer tok-b");
    const sw = t.d.bus.recent().filter((e) => e.type === "switch") as any[];
    assert.equal(sw.length, 1);
    assert.equal(sw[0].session, S1);
    // S1 stays on b afterwards even though a recovers (and now resets sooner than b, so a is the best pick)
    t.d.store.setUsage("a", usage(5, 10, {}, 3600_000, 6 * 3600_000));
    await (await fetch(`${t.base}/v1/messages`, msgFor(S1))).text();
    assert.equal(t.up.seen[3].auth, "Bearer tok-b");
    // a fresh session picks the best account now (a)
    await (await fetch(`${t.base}/v1/messages`, msgFor("33333333-3333-3333-3333-333333333333"))).text();
    assert.equal(t.up.seen[4].auth, "Bearer tok-a");
    const st = (await (await fetch(`${t.base}/api/state`)).json()) as any;
    assert.deepEqual(st.sessions, { a: 2, b: 1 });
  } finally {
    await t.close();
  }
});

test("session affinity: a session on an over-threshold account is not moved while it is the only usable one (relaxed)", async () => {
  const t = await setup({ a: { fiveHour: 0.95 }, b: { fiveHour: 0.99 } });
  try {
    await (await fetch(`${t.base}/v1/messages`, msgFor(S1))).text();
    assert.equal(t.up.seen[0].auth, "Bearer tok-a");
    await (await fetch(`${t.base}/v1/messages`, msgFor(S1))).text();
    assert.equal(t.up.seen[1].auth, "Bearer tok-a");
  } finally {
    await t.close();
  }
});

test("session affinity survives a daemon restart", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cm-aff-"));
  const up = await startFakeUpstream({ accounts: { "tok-a": { fiveHour: 0.1 }, "tok-b": { fiveHour: 0.1 } } });
  const mk = () => {
    const cfg = ConfigSchema.parse({
      upstream: up.url,
      preferSoonerReset: false,
      accounts: [
        { name: "a", configDir: "/tmp/x/a" },
        { name: "b", configDir: "/tmp/x/b" },
      ],
    });
    const d = createDaemon({
      config: cfg,
      dbPath: ":memory:",
      affinityPath: join(dir, "aff.json"),
      log: () => {},
      getToken: async (c) => `tok-${c.split("/").pop()}`,
    });
    d.store.setUsage("a", usage(10, 10));
    d.store.setUsage("b", usage(30, 10));
    return d;
  };
  try {
    let d = mk();
    let port = await d.listen(0);
    // force S1 onto b by making a briefly ineligible
    d.store.setUsage("a", usage(95, 10));
    await (await fetch(`http://127.0.0.1:${port}/v1/messages`, msgFor(S1))).text();
    assert.equal(up.seen[0].auth, "Bearer tok-b");
    await d.close();
    d = mk(); // a is the best account now, but S1 must stay on b
    port = await d.listen(0);
    await (await fetch(`http://127.0.0.1:${port}/v1/messages`, msgFor(S1))).text();
    assert.equal(up.seen[1].auth, "Bearer tok-b");
    await d.close();
  } finally {
    await up.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker crash: recording falls back to the main thread and keeps working", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  type WW = import("../src/daemon/recorder.js").WorkerWriter;
  const dir = mkdtempSync(join(tmpdir(), "cm-crash-"));
  const up = await startFakeUpstream({ accounts: { "tok-a": { fiveHour: 0.1 } } });
  const cfg = ConfigSchema.parse({ upstream: up.url, accounts: [{ name: "a", configDir: "/tmp/cm-test/a" }] });
  const logs: string[] = [];
  const d = createDaemon({
    config: cfg,
    dbPath: join(dir, "t.db"),
    writer: "worker",
    affinityPath: null,
    log: (m) => logs.push(m),
    getToken: async () => "tok-a",
  });
  const port = await d.listen(0);
  try {
    await (await fetch(`http://127.0.0.1:${port}/v1/messages`, msg(false))).text();
    await d.flush();
    assert.equal(d.db!.listRequests().length, 1);
    await (d.recorder!.writer as WW).kill();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(logs.some((l) => /worker exited/.test(l)));
    await (await fetch(`http://127.0.0.1:${port}/v1/messages`, msg(false))).text();
    await d.flush();
    assert.equal(d.db!.listRequests().length, 2);
    const st = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as any;
    assert.equal(st.writerMode, "inline (worker crashed)");
  } finally {
    await d.close();
    await up.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control API rejects foreign Host/Origin and non-JSON POST bodies", async () => {
  const t = await setup({ a: { fiveHour: 0.1 } });
  try {
    const { request } = await import("node:http");
    const badStatus = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${t.base}/api/state`);
      request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: "evil.example:80" } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      })
        .on("error", reject)
        .end();
    });
    assert.equal(badStatus, 403);
    const badOrigin = await fetch(`${t.base}/api/state`, { headers: { origin: "https://evil.example" } });
    assert.equal(badOrigin.status, 403);
    const text = await fetch(`${t.base}/api/policy`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(text.status, 415);
    const ok = await fetch(`${t.base}/api/policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threshold: 85 }),
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).policy.threshold, 85);
    // /api/route is a dry run
    const before = t.d.proxy.routerState.current;
    await (await fetch(`${t.base}/api/route?model=claude-sonnet-5`)).json();
    assert.equal(t.d.proxy.routerState.current, before);
  } finally {
    await t.close();
  }
});

test("client abort mid-stream frees the handler: upstream body destroyed, request finished as 'client closed'", async () => {
  const up = await startFakeUpstream({ accounts: { "tok-a": { fiveHour: 0.1 } }, latencyMs: 400 });
  const cfg = ConfigSchema.parse({ upstream: up.url, accounts: [{ name: "a", configDir: "/tmp/cm-test/a" }] });
  const d = createDaemon({ config: cfg, dbPath: ":memory:", affinityPath: null, log: () => {}, getToken: async () => "tok-a" });
  const port = await d.listen(0);
  try {
    const ac = new AbortController();
    const p = fetch(`http://127.0.0.1:${port}/v1/messages`, { ...msg(true), signal: ac.signal });
    const res = await p;
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await reader.read(); // first chunk arrived; the rest is delayed 400 ms upstream
    ac.abort();
    await new Promise((r) => setTimeout(r, 700));
    await d.flush();
    const rows = d.db!.listRequests();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].finishedAt !== null, "request must be finished, not left hanging");
    assert.match(rows[0].error ?? "", /client closed/);
  } finally {
    await d.close();
    await up.close();
  }
});

test("move budget: a threshold crossing does not move every session at once", async () => {
  const t = await setup({ a: { fiveHour: 0.1 }, b: { fiveHour: 0.1 } });
  try {
    const sids = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(8, "0")}-1111-1111-1111-111111111111`);
    for (const sid of sids) await (await fetch(`${t.base}/v1/messages`, msgFor(sid))).text();
    const first = t.up.seen[0].auth;
    const onFirst = sids.filter((_, i) => t.up.seen[i].auth === first);
    assert.ok(onFirst.length >= 25, "sessions should concentrate on the best account");
    // that account crosses ejectThreshold (95) but still serves: everyone would like to move, the budget lets a few
    (t.d.config() as any).ejectThreshold = 95;
    const name = first === "Bearer tok-a" ? "a" : "b";
    t.d.store.setUsage(name, usage(97, 10));
    let moved = 0;
    for (const sid of onFirst) {
      await (await fetch(`${t.base}/v1/messages`, msgFor(sid))).text();
      if (t.up.seen[t.up.seen.length - 1].auth !== first) moved++;
    }
    // budget: maxMovesPerMinute (10) + 2% of active sessions, refilled over time; with 25+ candidates only ~10 move now
    assert.ok(moved >= 5 && moved <= 12, `moved ${moved}`);
  } finally {
    await t.close();
  }
});

test("recorder sheds bodies when the worker backlog is high", async () => {
  const { Recorder } = await import("../src/daemon/recorder.js");
  const prev = Recorder.SHED_BACKLOG;
  Recorder.SHED_BACKLOG = 0; // any backlog at all sheds
  const t = await setup({ a: { fiveHour: 0.1 } });
  try {
    // inline writer has zero backlog → bodies stored; simulate a backed-up worker via the writer interface
    const w = t.d.recorder!.writer;
    const orig = w.backlog;
    w.backlog = () => 5;
    await (await fetch(`${t.base}/v1/messages`, msg(false))).text();
    await t.d.flush();
    const d = t.d.db!.getRequest(t.d.db!.listRequests()[0].id)!;
    assert.equal(d.body, null, "body must not be stored while shedding");
    w.backlog = orig;
    await (await fetch(`${t.base}/v1/messages`, msg(false))).text();
    await t.d.flush();
    const d2 = t.d.db!.getRequest(t.d.db!.listRequests()[0].id)!;
    assert.ok(d2.body, "bodies resume when the backlog drains");
  } finally {
    Recorder.SHED_BACKLOG = prev;
    await t.close();
  }
});
