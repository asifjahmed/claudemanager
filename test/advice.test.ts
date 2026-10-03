import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAdvice, adviceHeaders } from "../src/core/advice.js";
import { LimitTracker } from "../src/core/limits.js";
import { account, usage } from "./helpers.js";

const policy = { threshold: 90, weeklyThreshold: 97, pinned: null };
const base = (over: Partial<Parameters<typeof computeAdvice>[0]> = {}) =>
  computeAdvice({ accounts: [], policy, model: "claude-fable-5-1", sessionId: "s1", sessionAccount: null, approachingHeadroom: 15, ...over });

test("continue when headroom is plentiful; headers describe session and pool", () => {
  const r = base({ accounts: [account("a", 10, 20, { fable: 30 }), account("b", 5, 10, { fable: 10 })], sessionAccount: "a" });
  assert.equal(r.advice.action, "continue");
  assert.equal(r.session.account, "a");
  assert.equal(r.session.sessionHeadroom, 90);
  assert.equal(r.session.modelHeadroom, 70);
  const fable = r.pool.families.find((f) => f.family === "fable")!;
  assert.equal(fable.headroom, 70 + 90);
  assert.equal(fable.eligibleAccounts, 2);
  const hd = adviceHeaders(r);
  assert.equal(hd["x-cm-account"], "a");
  assert.match(hd["x-cm-session-headroom"], /^90;reset=\d+$/);
  assert.match(hd["x-cm-pool-model-headroom"], /fable=160;accounts=2;reset=\d+/);
  assert.equal(hd["x-cm-advice"], "continue");
});

test("switch-model when the requested family is almost gone and another has room", () => {
  const accts = [account("a", 10, 20, { fable: 95, opus: 10 }), account("b", 5, 10, { fable: 92, opus: 5 })];
  const r = base({ accounts: accts });
  assert.equal(r.advice.action, "switch-model");
  assert.equal(r.advice.switchTo, "opus");
  assert.equal(adviceHeaders(r)["x-cm-advice"], "switch-model;to=opus");
});

test("pause when every 5-hour window is full, with the earliest reset", () => {
  const a = account("a", 100, 20);
  const b = account("b", 100, 10);
  a.usage!.fiveHour.resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
  b.usage!.fiveHour.resetsAt = new Date(Date.now() + 1 * 3600_000).toISOString();
  const r = base({ accounts: [a, b], model: "claude-sonnet-5" });
  assert.equal(r.advice.action, "pause");
  assert.equal(r.advice.pauseUntil, b.usage!.fiveHour.resetsAt);
  assert.match(adviceHeaders(r)["x-cm-advice"], /^pause;until=/);
});

test("family exhausted with no alternative pauses until that family's reset", () => {
  const accts = [account("a", 10, 20, { fable: 100 }), account("b", 5, 10, { fable: 100 })];
  const r = base({ accounts: accts });
  assert.equal(r.advice.action, "pause");
  assert.ok(r.advice.pauseUntil);
});

test("limit tracker: reset, approaching, exhausted and recovered are edge-triggered", () => {
  const t = new LimitTracker(15);
  const a = account("a", 50, 40, { fable: 80 });
  const b = account("b", 10, 10, { fable: 95 });
  assert.deepEqual(t.update("a", a.usage!, [a, b]), []); // first sight: nothing
  assert.deepEqual(t.update("b", b.usage!, [a, b]), []);
  // pooled fable headroom: a 20 + b 5 = 25 (above 15). a climbs to 90 → 10 + 5 = 15 → approaching
  a.usage = usage(50, 40, { fable: 90 });
  let ev = t.update("a", a.usage, [a, b]);
  assert.deepEqual(
    ev.map((e) => e.kind),
    ["approaching"],
  );
  // same state again: no repeat
  assert.deepEqual(t.update("a", a.usage, [a, b]), []);
  // both at 100 → exhausted (b first, still approaching; then a)
  b.usage = usage(10, 10, { fable: 100 });
  assert.deepEqual(
    t.update("b", b.usage, [a, b]).map((e) => e.kind),
    [],
  );
  a.usage = usage(50, 40, { fable: 100 });
  ev = t.update("a", a.usage, [a, b]);
  assert.deepEqual(
    ev.map((e) => e.kind),
    ["exhausted"],
  );
  // a's weekly resets: utilization drops sharply → reset events for weekly and fable, then recovered
  a.usage = usage(50, 0, { fable: 0 });
  ev = t.update("a", a.usage, [a, b]);
  assert.deepEqual(
    ev.map((e) => e.kind),
    ["reset", "reset", "recovered"],
  );
  const r = ev.find((e) => e.kind === "reset" && (e as any).window === "fable") as any;
  assert.equal(r.freed, 100);
});
