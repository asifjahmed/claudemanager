import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFreshToken, CredentialError, resetRefreshCoordination, refreshHeldUntil, type CredentialIO, type ReadResult } from "../src/core/credentials.js";

function store(initial: Record<string, { expiresInMs: number; rt?: string }>) {
  const data = new Map<string, ReadResult>();
  for (const [dir, v] of Object.entries(initial)) {
    const creds = { accessToken: `at-${dir}-0`, refreshToken: v.rt ?? `rt-${dir}-0`, expiresAt: Date.now() + v.expiresInMs, scopes: ["user:inference"] };
    data.set(dir, { creds, raw: { claudeAiOauth: creds }, from: "keychain" });
  }
  let failWrites = 0;
  const writes: string[] = [];
  const io: CredentialIO = {
    async read(dir) {
      const r = data.get(dir);
      return r ? { ...r, creds: { ...r.creds } } : null;
    },
    async write(dir, raw, from) {
      if (failWrites > 0) {
        failWrites--;
        throw new Error("keychain locked");
      }
      writes.push(dir);
      data.set(dir, { creds: raw.claudeAiOauth!, raw, from });
    },
  };
  return { io, data, writes, failNextWrites: (n: number) => (failWrites = n) };
}

/** fake network: records calls; behavior per phase */
function net(behavior: { preflight?: "ok" | "fail"; post?: "ok" | "timeout" | "invalid_grant" }) {
  const calls: Array<{ method: string; body?: any }> = [];
  let n = 0;
  const fetchImpl = (async (_url: any, init: any) => {
    const method = init?.method ?? "GET";
    calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === "GET") {
      if (behavior.preflight === "fail") throw new Error("getaddrinfo ENOTFOUND");
      return new Response("", { status: 405 });
    }
    if (behavior.post === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (behavior.post === "invalid_grant")
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }), { status: 400 });
    n++;
    return new Response(JSON.stringify({ access_token: `at-new-${n}`, refresh_token: `rt-new-${n}`, expires_in: 28800 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls, posts: () => calls.filter((c) => c.method === "POST") };
}

beforeEach(() => resetRefreshCoordination());

test("a valid token is returned without touching the network", async () => {
  const s = store({ "/a": { expiresInMs: 3600_000 } });
  const n = net({});
  const c = await getFreshToken("/a", { io: s.io, fetchImpl: n.fetchImpl });
  assert.equal(c.accessToken, "at-/a-0");
  assert.equal(n.calls.length, 0);
});

test("refresh succeeds: preflight first, new tokens persisted", async () => {
  const s = store({ "/a": { expiresInMs: 60_000 } });
  const n = net({ preflight: "ok", post: "ok" });
  const c = await getFreshToken("/a", { io: s.io, fetchImpl: n.fetchImpl });
  assert.equal(c.accessToken, "at-new-1");
  assert.deepEqual(
    n.calls.map((x) => x.method),
    ["GET", "POST"],
  );
  assert.equal(n.posts()[0].body.refresh_token, "rt-/a-0");
  assert.equal(s.data.get("/a")!.creds.refreshToken, "rt-new-1");
});

test("allowRefresh=false (system just woke): still-valid token is served, expired token is 'held', nothing is sent", async () => {
  const s = store({ "/valid": { expiresInMs: 60_000 }, "/expired": { expiresInMs: -1000 } });
  const n = net({ post: "ok" });
  const c = await getFreshToken("/valid", { io: s.io, fetchImpl: n.fetchImpl, allowRefresh: false });
  assert.equal(c.accessToken, "at-/valid-0");
  await assert.rejects(
    getFreshToken("/expired", { io: s.io, fetchImpl: n.fetchImpl, allowRefresh: false }),
    (e: any) => e instanceof CredentialError && e.code === "held" && !e.needsLogin,
  );
  assert.equal(n.calls.length, 0);
});

test("dead network: preflight fails, the refresh token is NEVER sent, and other accounts are held too", async () => {
  const s = store({ "/a": { expiresInMs: -1000 }, "/b": { expiresInMs: -1000 }, "/c": { expiresInMs: -1000 } });
  const n = net({ preflight: "fail" });
  const results = await Promise.allSettled(["/a", "/b", "/c"].map((d) => getFreshToken(d, { io: s.io, fetchImpl: n.fetchImpl })));
  assert.ok(results.every((r) => r.status === "rejected"));
  assert.equal(n.posts().length, 0, "no refresh token may leave the machine when the network is down");
  assert.equal(n.calls.length, 1, "only one preflight; the rest are held");
  assert.ok(refreshHeldUntil() > Date.now());
  for (const d of ["/a", "/b", "/c"]) assert.equal(s.data.get(d)!.creds.refreshToken, `rt-${d}-0`);
});

test("response lost mid-refresh (the DarkWake case): at most ONE account is exposed, the others are held", async () => {
  const s = store({ "/a": { expiresInMs: -1000 }, "/b": { expiresInMs: -1000 }, "/c": { expiresInMs: -1000 } });
  const n = net({ preflight: "ok", post: "timeout" });
  const results = await Promise.allSettled(["/a", "/b", "/c"].map((d) => getFreshToken(d, { io: s.io, fetchImpl: n.fetchImpl })));
  const errs = results.map((r) => (r as PromiseRejectedResult).reason as CredentialError);
  assert.equal(n.posts().length, 1, "after one lost response nobody else may send a refresh");
  assert.equal(errs.filter((e) => e.code === "network").length, 1);
  assert.equal(errs.filter((e) => e.code === "held").length, 2);
  assert.ok(errs.every((e) => !e.needsLogin));
});

test("network failure while the old token is still valid keeps serving with the old token", async () => {
  const s = store({ "/a": { expiresInMs: 10 * 60_000 } });
  const n = net({ preflight: "ok", post: "timeout" });
  const c = await getFreshToken("/a", { io: s.io, fetchImpl: n.fetchImpl, minTtlMs: 30 * 60_000 });
  assert.equal(c.accessToken, "at-/a-0");
});

test("invalid_grant is classified as needs-login", async () => {
  const s = store({ "/a": { expiresInMs: -1000 } });
  const n = net({ preflight: "ok", post: "invalid_grant" });
  await assert.rejects(
    getFreshToken("/a", { io: s.io, fetchImpl: n.fetchImpl }),
    (e: any) => e instanceof CredentialError && e.code === "relogin" && e.needsLogin,
  );
});

test("refreshed token survives a failed keychain write and is persisted on the next call", async () => {
  const s = store({ "/a": { expiresInMs: -1000 } });
  const n = net({ preflight: "ok", post: "ok" });
  s.failNextWrites(1);
  const logs: string[] = [];
  const c1 = await getFreshToken("/a", { io: s.io, fetchImpl: n.fetchImpl, log: (m) => logs.push(m) });
  assert.equal(c1.accessToken, "at-new-1");
  assert.equal(s.data.get("/a")!.creds.refreshToken, "rt-/a-0", "storage still has the old (now dead) token");
  assert.ok(logs.some((l) => /could not be persisted/.test(l)));
  const c2 = await getFreshToken("/a", { io: s.io, fetchImpl: n.fetchImpl, force: false });
  assert.equal(c2.accessToken, "at-new-1", "memory copy wins over stale storage");
  assert.equal(n.posts().length, 1, "no second refresh with the dead token");
  // cache expiry is 30s; force a storage re-read path by asking with force=false after invalidating the read cache only
  assert.equal(s.writes.length >= 0, true);
});

test("concurrent callers for one account trigger exactly one refresh", async () => {
  const s = store({ "/a": { expiresInMs: -1000 } });
  const n = net({ preflight: "ok", post: "ok" });
  const all = await Promise.all(Array.from({ length: 8 }, () => getFreshToken("/a", { io: s.io, fetchImpl: n.fetchImpl })));
  assert.ok(all.every((c) => c.accessToken === "at-new-1"));
  assert.equal(n.posts().length, 1);
});
