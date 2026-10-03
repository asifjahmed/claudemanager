import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { createDaemon } from "../src/daemon/server.js";
import { ConfigSchema } from "../src/core/config.js";
import { WebhookDispatcher } from "../src/daemon/webhooks.js";
import { directAccountFor } from "../src/core/settings.js";
import { startFakeUpstream } from "../src/dev/fake-upstream.js";
import { usage } from "./helpers.js";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const msg = (model = "claude-fable-5-1") => ({
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer client-token", "x-claude-code-session-id": SID },
  body: JSON.stringify({ model, stream: false, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
});

async function setup(extra: Record<string, unknown> = {}) {
  const up = await startFakeUpstream({ accounts: { "tok-a": { fiveHour: 0.1 }, "tok-b": { fiveHour: 0.2 } } });
  const cfg = ConfigSchema.parse({
    upstream: up.url,
    preferSoonerReset: false,
    accounts: [
      { name: "a", configDir: "/tmp/x/a" },
      { name: "b", configDir: "/tmp/x/b" },
    ],
    ...extra,
  });
  const d = createDaemon({ config: cfg, dbPath: ":memory:", affinityPath: null, log: () => {}, getToken: async (c) => `tok-${c.split("/").pop()}` });
  d.store.setUsage("a", usage(10, 20, { fable: 30, opus: 10 }));
  d.store.setUsage("b", usage(20, 10, { fable: 40, opus: 5 }));
  const port = await d.listen(0);
  return {
    d,
    up,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await d.close();
      await up.close();
    },
  };
}

test("every proxied response carries advice headers for the session and the pool", async () => {
  const t = await setup();
  try {
    const res = await fetch(`${t.base}/v1/messages`, msg());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-cm-account"), "a");
    assert.match(res.headers.get("x-cm-session-headroom")!, /^\d+;reset=\d+$/);
    assert.match(res.headers.get("x-cm-model-headroom")!, /^fable=\d+;reset=\d+$/);
    assert.match(res.headers.get("x-cm-pool-model-headroom")!, /fable=\d+;accounts=2;reset=\d+/);
    assert.equal(res.headers.get("x-cm-advice"), "continue");
    assert.equal(res.headers.get("x-cm-model-fallback"), null);
  } finally {
    await t.close();
  }
});

test("GET /api/advice reflects the session's account and says switch-model when its family is nearly gone", async () => {
  const t = await setup();
  try {
    await (await fetch(`${t.base}/v1/messages`, msg())).text();
    t.d.store.setUsage("a", usage(10, 20, { fable: 95, opus: 10 }));
    t.d.store.setUsage("b", usage(20, 10, { fable: 92, opus: 5 }));
    const r = (await (await fetch(`${t.base}/api/advice?session=${SID}&model=claude-fable-5-1`)).json()) as any;
    assert.equal(r.session.account, "a");
    assert.equal(r.advice.action, "switch-model");
    assert.equal(r.advice.switchTo, "opus");
  } finally {
    await t.close();
  }
});

test("model fallback rewrites the model when the family has no pooled headroom, records and announces it", async () => {
  const t = await setup({ modelFallback: { fable: "claude-opus-5" } });
  try {
    t.d.store.setUsage("a", usage(10, 20, { fable: 100, opus: 10 }));
    t.d.store.setUsage("b", usage(20, 10, { fable: 100, opus: 5 }));
    const res = await fetch(`${t.base}/v1/messages`, msg());
    assert.equal(res.status, 200);
    assert.equal(t.up.seen[0].body.model, "claude-opus-5");
    assert.equal(res.headers.get("x-cm-model-fallback"), "claude-fable-5-1->claude-opus-5");
    await t.d.flush();
    const row = t.d.db!.listRequests()[0];
    assert.equal(row.model, "claude-opus-5");
    assert.equal(row.modelFallbackFrom, "claude-fable-5-1");
    assert.ok(t.d.bus.recent().some((e) => e.type === "model_fallback"));
    // headroom back: no rewrite
    t.d.store.setUsage("a", usage(10, 20, { fable: 30, opus: 10 }));
    await (await fetch(`${t.base}/v1/messages`, msg())).text();
    assert.equal(t.up.seen[1].body.model, "claude-fable-5-1");
  } finally {
    await t.close();
  }
});

test("GET /api/wait returns as soon as headroom appears, and reports timeout otherwise", async () => {
  const t = await setup();
  try {
    t.d.store.setUsage("a", usage(10, 20, { fable: 100 }));
    t.d.store.setUsage("b", usage(20, 10, { fable: 100 }));
    const quick = (await (await fetch(`${t.base}/api/wait?model=claude-fable-5-1&min-headroom=10&timeout=1`)).json()) as any;
    assert.equal(quick.satisfied, false);
    const p = fetch(`${t.base}/api/wait?model=claude-fable-5-1&min-headroom=10&timeout=30`).then((r) => r.json() as Promise<any>);
    await new Promise((r) => setTimeout(r, 50));
    const u = usage(10, 20, { fable: 20 });
    t.d.store.setUsage("a", u);
    t.d.bus.publish({ type: "usage", at: Date.now(), account: "a", usage: u });
    const r = await p;
    assert.equal(r.satisfied, true);
    assert.ok(r.headroom >= 10);
    assert.ok(r.waitedMs < 5000);
  } finally {
    await t.close();
  }
});

test("limit events fire on reset / exhausted and reach webhooks signed with the secret", async () => {
  const received: Array<{ headers: Record<string, string | string[] | undefined>; body: any }> = [];
  const sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as any).port}/hook`;
  const t = await setup({ webhooks: [{ url: sinkUrl, events: ["limit.*"], secret: "s3cret" }] });
  try {
    // prime the tracker, then exhaust fable, then reset a's windows
    t.d.bus.publish({ type: "usage", at: Date.now(), account: "a", usage: t.d.store.get("a")!.usage! });
    t.d.bus.publish({ type: "usage", at: Date.now(), account: "b", usage: t.d.store.get("b")!.usage! });
    const full = usage(10, 20, { fable: 100, opus: 10 });
    t.d.store.setUsage("a", full);
    t.d.bus.publish({ type: "usage", at: Date.now(), account: "a", usage: full });
    const fullB = usage(20, 10, { fable: 100, opus: 5 });
    t.d.store.setUsage("b", fullB);
    t.d.bus.publish({ type: "usage", at: Date.now(), account: "b", usage: fullB });
    const fresh = usage(10, 0, { fable: 0, opus: 0 });
    t.d.store.setUsage("a", fresh);
    t.d.bus.publish({ type: "usage", at: Date.now(), account: "a", usage: fresh });
    for (let i = 0; i < 50 && received.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    const events = received.map((r) => r.body.event);
    assert.ok(events.includes("limit.exhausted"), events.join(","));
    assert.ok(events.includes("limit.reset"), events.join(","));
    const one = received[0];
    const expected = `sha256=${createHmac("sha256", "s3cret").update(JSON.stringify(one.body)).digest("hex")}`;
    assert.equal(one.headers["x-cm-signature"], expected);
    assert.equal(one.headers["x-cm-event"], one.body.event);
  } finally {
    await t.close();
    await new Promise<void>((r) => sink.close(() => r()));
  }
});

test("webhook dispatcher retries transient failures and gives up on 4xx", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("", { status: calls < 2 ? 503 : 200 });
  }) as unknown as typeof fetch;
  const w = new WebhookDispatcher(
    () => ConfigSchema.parse({}),
    () => {},
    fetchImpl,
  );
  const t0 = Date.now();
  const status = await w.deliver("http://example.invalid/hook", undefined, "ping", {});
  assert.equal(status, 200);
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 >= 900);
  calls = 0;
  const w2 = new WebhookDispatcher(
    () => ConfigSchema.parse({}),
    () => {},
    (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
  );
  assert.equal(await w2.deliver("http://example.invalid/hook", undefined, "ping", {}), 404);
});

test("direct account is identified by exact token match; unknown or missing token means the stored login", () => {
  const tokens = { a: "sk-ant-oat01-aaa", b: "sk-ant-oat01-bbb", c: null };
  assert.equal(directAccountFor("sk-ant-oat01-bbb", tokens), "b");
  assert.equal(directAccountFor("sk-ant-oat01-zzz", tokens), null);
  assert.equal(directAccountFor(null, tokens), null);
});
