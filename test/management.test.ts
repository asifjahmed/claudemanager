import { test } from "node:test";
import assert from "node:assert/strict";
import { createDaemon } from "../src/daemon/server.js";
import { ConfigSchema, loadConfig, saveConfig } from "../src/core/config.js";
import { attribute } from "../src/core/attribution.js";
import { contextReport } from "../src/core/context-growth.js";
import { startFakeUpstream } from "../src/dev/fake-upstream.js";
import { usage } from "./helpers.js";

test("attribution splits measured consumption by cost share", () => {
  const r = attribute({
    sessions: [
      {
        sessionId: "a",
        firstSeen: 0,
        lastSeen: 1,
        requests: 10,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estCostUsd: 3,
        accounts: "x",
        models: "m",
        firstPrompt: "p",
        maxContext: 100,
      },
      {
        sessionId: "b",
        firstSeen: 0,
        lastSeen: 1,
        requests: 5,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estCostUsd: 1,
        accounts: "x",
        models: "m",
        firstPrompt: "q",
        maxContext: 50,
      },
    ],
    weeklyConsumed: 40,
    sessionConsumed: 80,
    familyCosts: { a: { fable: 2, opus: 1 } },
  });
  assert.equal(r.sessions[0].sessionId, "a");
  assert.equal(r.sessions[0].share, 0.75);
  assert.equal(r.sessions[0].weeklyPct, 30);
  assert.equal(r.sessions[1].sessionPct, 20);
  assert.ok(Math.abs(r.sessions[0].familyShare.fable - 2 / 3) < 1e-9);
});

test("context report: growth per turn, jumps, largest tool results", () => {
  const rows = [1, 2, 3].map((i) => ({
    id: i,
    startedAt: i * 1000,
    model: "m",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: i * 10000,
    cacheWriteTokens: i === 2 ? 5000 : 0,
    latencyMs: 1,
    statusCode: 200,
  }));
  const body = {
    system: "sys",
    tools: [{ name: "Bash" }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "x".repeat(500) },
          { type: "tool_result", tool_use_id: "t2", content: "y".repeat(50) },
        ],
      },
    ],
  };
  const r = contextReport(rows, body);
  assert.equal(r.turns.length, 3);
  assert.equal(r.turns[1].context, 100 + 20000 + 5000);
  assert.equal(r.peakContext, 30100);
  assert.equal(r.biggestJumps[0].id, 2);
  assert.equal(r.latest!.largestToolResults[0].tool, "Bash");
  assert.equal(r.latest!.largestToolResults[0].chars, 500);
  assert.equal(r.cacheWriteTotal, 5000);
});

test("dashboard account management: rename keeps affinity and pin; remove; attribution and context endpoints", async () => {
  const up = await startFakeUpstream({ accounts: { "tok-a": { fiveHour: 0.1 }, "tok-b": { fiveHour: 0.2 } } });
  // rename/remove go through the config file, so give the daemon a real (temp-home) config
  const cfg = ConfigSchema.parse({
    upstream: up.url,
    preferSoonerReset: false,
    pinned: "a",
    accounts: [
      { name: "a", configDir: "/tmp/x/a" },
      { name: "b", configDir: "/tmp/x/b" },
    ],
  });
  saveConfig(cfg);
  const d = createDaemon({ dbPath: ":memory:", affinityPath: null, log: () => {}, getToken: async (c) => `tok-${c.split("/").pop()}` });
  d.store.setUsage("a", usage(10, 10));
  d.store.setUsage("b", usage(20, 10));
  const port = await d.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const SID = "12345678-1234-1234-1234-123456789abc";
  try {
    await (
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer x", "x-claude-code-session-id": SID },
        body: JSON.stringify({ model: "claude-fable-5-1", max_tokens: 5, messages: [{ role: "user", content: "hello there" }] }),
      })
    ).text();
    assert.equal(d.proxy.affinity.get(SID)!.account, "a");
    const r = await fetch(`${base}/api/accounts/a/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "work" }),
    });
    assert.equal(r.status, 200);
    const st = (await r.json()) as any;
    assert.deepEqual(st.accounts.map((x: any) => x.name).sort(), ["b", "work"]);
    assert.equal(st.pinned, "work");
    assert.equal(d.proxy.affinity.get(SID)!.account, "work");
    assert.equal(loadConfig().accounts.find((x) => x.name === "work")!.configDir, "/tmp/x/a");
    const bad = await fetch(`${base}/api/accounts/work/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "b" }),
    });
    assert.equal(bad.status, 400);
    const del = await fetch(`${base}/api/accounts/b`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.deepEqual(
      loadConfig().accounts.map((x) => x.name),
      ["work"],
    );
    await d.flush();
    const at = (await (await fetch(`${base}/api/attribution?hours=1`)).json()) as any;
    assert.equal(at.sessions.length, 1);
    assert.equal(at.sessions[0].sessionId, SID);
    assert.equal(at.sessions[0].share, 1);
    const ctx = (await (await fetch(`${base}/api/sessions/${SID}/context`)).json()) as any;
    assert.equal(ctx.turns.length, 1);
    assert.equal(ctx.latest.messages, 1);
    const jobs = (await (await fetch(`${base}/api/jobs`)).json()) as any[];
    assert.deepEqual(jobs, []);
  } finally {
    await d.close();
    await up.close();
  }
});
