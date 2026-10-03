import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../src/core/db.js";
import { usage } from "./helpers.js";

test("db round trip: request, body, response, list, stats, sessions", () => {
  const db = new Db(":memory:");
  const id = db.insertRequest({
    startedAt: Date.now() - 100,
    model: "claude-fable-5-1",
    path: "/v1/messages",
    sessionId: "s1",
    accountUuid: "u1",
    stream: true,
  });
  db.insertBody(
    id,
    { system: "sys", messages: [{ role: "user", content: "hello there" }], tools: [{ name: "Bash" }], params: { max_tokens: 5 }, lastUserText: "hello there" },
    "full",
  );
  db.finishRequest(id, {
    finishedAt: Date.now(),
    account: "a",
    statusCode: 200,
    error: null,
    switchedFrom: null,
    retried: false,
    rl: { fiveHourUtil: 10, fiveHourReset: null, sevenDayUtil: 5, sevenDayReset: null, status: "allowed", claim: null },
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
    stopReason: "end_turn",
    estCostUsd: 0.01,
  });
  db.insertResponse(id, [{ type: "text", text: "hi back" }], "hi back", null);
  const list = db.listRequests({ q: "hello" });
  assert.equal(list.length, 1);
  assert.equal(list[0].account, "a");
  assert.equal(list[0].lastUserText, "hello there");
  assert.equal(db.listRequests({ q: "nomatch" }).length, 0);
  const d = db.getRequest(id)!;
  assert.equal((d.body!.messages as any[])[0].content, "hello there");
  assert.equal((d.response!.content as any[])[0].text, "hi back");
  assert.ok(d.latencyMs! >= 100);
  const st = db.stats("account");
  assert.equal(st[0].key, "a");
  assert.equal(st[0].inputTokens, 100);
  assert.equal(db.listSessions()[0].sessionId, "s1");
  db.insertSnapshot("a", usage(10, 20));
  assert.equal(db.usageHistory("a", 1).length, 1);
  db.insertEvent({ type: "switch", at: Date.now(), from: null, to: "a", reason: "initial" });
  assert.equal(db.recentEvents()[0].type, "switch");
  assert.equal(db.purge(), 1);
  db.close();
});
