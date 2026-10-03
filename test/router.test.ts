import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAccount } from "../src/core/router.js";
import { account, accountResetting } from "./helpers.js";

const policy = { threshold: 90, weeklyThreshold: 90, pinned: null, preferSoonerReset: false };
const soon = { threshold: 90, weeklyThreshold: 97, pinned: null, preferSoonerReset: true, perishableHours: 24 };

test("initial pick chooses the account with the most 5h headroom", () => {
  const d = pickAccount({ accounts: [account("a", 50), account("b", 10), account("c", 30)], policy, current: null, modelFamily: null });
  assert.equal(d.account, "b");
  assert.equal(d.reason, "initial");
  assert.equal(d.switched, true);
});

test("sticky: keeps current while eligible even if another has more headroom", () => {
  const d = pickAccount({ accounts: [account("a", 80), account("b", 10)], policy, current: "a", modelFamily: null });
  assert.equal(d.account, "a");
  assert.equal(d.reason, "sticky");
  assert.equal(d.switched, false);
});

test("switches when current crosses the session threshold", () => {
  const d = pickAccount({ accounts: [account("a", 90), account("b", 40), account("c", 20)], policy, current: "a", modelFamily: null });
  assert.equal(d.account, "c");
  assert.equal(d.reason, "threshold");
  assert.equal(d.from, "a");
});

test("weekly threshold disqualifies an account", () => {
  const d = pickAccount({ accounts: [account("a", 10, 95), account("b", 50, 10)], policy, current: null, modelFamily: null });
  assert.equal(d.account, "b");
});

test("per-model weekly window only matters for that model family", () => {
  const accounts = [account("a", 10, 10, { fable: 95 }), account("b", 50, 10, { fable: 5 })];
  assert.equal(pickAccount({ accounts, policy, current: null, modelFamily: "fable" }).account, "b");
  assert.equal(pickAccount({ accounts, policy, current: null, modelFamily: "sonnet" }).account, "a");
  assert.equal(pickAccount({ accounts, policy, current: null, modelFamily: null }).account, "a");
});

test("pinned wins while eligible, falls through when not", () => {
  const p = { ...policy, pinned: "b" };
  assert.equal(pickAccount({ accounts: [account("a", 10), account("b", 50)], policy: p, current: "a", modelFamily: null }).account, "b");
  assert.equal(pickAccount({ accounts: [account("a", 10), account("b", 95)], policy: p, current: "a", modelFamily: null }).account, "a");
});

test("exhausted and disabled accounts are skipped; exclusion set honored", () => {
  const accounts = [account("a", 0, 0, {}, { exhaustedUntil: Date.now() + 60_000 }), account("b", 0, 0, {}, { disabled: true }), account("c", 70)];
  assert.equal(pickAccount({ accounts, policy, current: null, modelFamily: null }).account, "c");
  const d = pickAccount({ accounts, policy, current: null, modelFamily: null, exclude: new Set(["c"]) });
  assert.equal(d.account, null);
  assert.equal(d.reason, "none_eligible");
  assert.ok(d.earliestResetAt && d.earliestResetAt > Date.now());
});

test("unknown usage is allowed; ties break on weekly headroom then name", () => {
  assert.equal(pickAccount({ accounts: [account("a", null), account("b", 5)], policy, current: null, modelFamily: null }).account, "a");
  assert.equal(pickAccount({ accounts: [account("b", 20, 50), account("a", 20, 10)], policy, current: null, modelFamily: null }).account, "a");
  assert.equal(pickAccount({ accounts: [account("b", 20, 10), account("a", 20, 10)], policy, current: null, modelFamily: null }).account, "a");
});

test("over-threshold accounts are used rather than stalling when nothing is within thresholds", () => {
  // current account is over the session threshold but has plenty of weekly room; the others are out of
  // per-model weekly quota: the proxy must keep serving from the current account, not stall
  const accounts = [account("a", 91, 21, { fable: 34 }), account("b", 8, 70, { fable: 100 }), account("c", 18, 56, { fable: 97 })];
  const d = pickAccount({ accounts, policy, current: "a", modelFamily: "fable" });
  assert.equal(d.account, "a");
  assert.equal(d.relaxed, true);
  // b at 100% is never used; c (3% model-weekly left) loses to a (9% session left)
  const d2 = pickAccount({ accounts, policy, current: "c", modelFamily: "fable" });
  assert.equal(d2.account, "a");
  assert.equal(d2.reason, "relaxed");
});

test("a tier-1 account is always preferred over the relaxed fallback", () => {
  const accounts = [account("a", 95), account("b", 96), account("c", 50)];
  const d = pickAccount({ accounts, policy, current: "a", modelFamily: null });
  assert.equal(d.account, "c");
  assert.equal(d.relaxed, false);
});

test("relaxed routing sticks to the current account unless another has clearly more room", () => {
  const accounts = [account("a", 92), account("b", 91)];
  assert.equal(pickAccount({ accounts, policy, current: "a", modelFamily: null }).account, "a");
  const accounts2 = [account("a", 98), account("b", 91)];
  assert.equal(pickAccount({ accounts: accounts2, policy, current: "a", modelFamily: null }).account, "b");
});

test("only 100% windows, exhaustion, disabled or dead tokens make an account unusable", () => {
  const accounts = [account("a", 100), account("b", 50, 100), account("c", 10, 10, { fable: 100 })];
  const d = pickAccount({ accounts, policy, current: null, modelFamily: "fable" });
  assert.equal(d.account, null);
  assert.equal(d.reason, "none_eligible");
  assert.equal(pickAccount({ accounts, policy, current: null, modelFamily: "sonnet" }).account, "c");
});

test("soonest weekly reset is spent first when picking an account", () => {
  const accounts = [accountResetting("a", 10, 30, 120), accountResetting("b", 40, 60, 10), accountResetting("c", 5, 5, 72)];
  const d = pickAccount({ accounts, policy: soon, current: null, modelFamily: null });
  assert.equal(d.account, "b"); // resets in 10 h, even though a and c have more headroom
});

test("an account about to hit the session threshold ranks last regardless of reset time", () => {
  const accounts = [accountResetting("a", 85, 30, 5), accountResetting("b", 10, 30, 100)];
  assert.equal(pickAccount({ accounts, policy: soon, current: null, modelFamily: null }).account, "b");
});

test("per-model reset time is used for that model's requests", () => {
  const a = accountResetting("a", 10, 10, 100, { fable: 50 });
  a.usage!.models.fable.resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
  const b = accountResetting("b", 10, 10, 20, { fable: 50 });
  assert.equal(pickAccount({ accounts: [a, b], policy: soon, current: null, modelFamily: "fable" }).account, "a");
  assert.equal(pickAccount({ accounts: [a, b], policy: soon, current: null, modelFamily: "sonnet" }).account, "b");
});

test("proactive switch to an account whose quota expires soon, rate-limited and guarded", () => {
  const cur = accountResetting("cur", 30, 30, 120);
  const soonAcct = accountResetting("soon", 20, 60, 8); // 40% weekly left, resets in 8 h
  let d = pickAccount({ accounts: [cur, soonAcct], policy: soon, current: "cur", modelFamily: null });
  assert.equal(d.account, "soon");
  assert.equal(d.reason, "perishable");
  // just switched: stay put
  d = pickAccount({ accounts: [cur, soonAcct], policy: soon, current: "cur", modelFamily: null, lastSwitchAt: Date.now() - 60_000 });
  assert.equal(d.account, "cur");
  // candidate nearly empty: not worth it
  const empty = accountResetting("soon", 20, 90, 8);
  assert.equal(pickAccount({ accounts: [cur, empty], policy: soon, current: "cur", modelFamily: null }).account, "cur");
  // feature off: plain sticky
  assert.equal(pickAccount({ accounts: [cur, soonAcct], policy: { ...soon, preferSoonerReset: false }, current: "cur", modelFamily: null }).account, "cur");
  // current itself resets soon: no gain, stay
  const curSoon = accountResetting("cur", 30, 30, 9);
  assert.equal(pickAccount({ accounts: [curSoon, soonAcct], policy: soon, current: "cur", modelFamily: null }).account, "cur");
});

const aware = { threshold: 90, weeklyThreshold: 97, pinned: null, preferSoonerReset: false, modelAware: true };

test("model-aware: a Sonnet request goes to the account whose Fable window is most spent", () => {
  const accounts = [account("a", 10, 30, { fable: 20 }), account("b", 10, 30, { fable: 95 }), account("c", 10, 30, { fable: 60 })];
  assert.equal(pickAccount({ accounts, policy: aware, current: null, modelFamily: "sonnet" }).account, "b");
  assert.equal(pickAccount({ accounts, policy: aware, current: null, modelFamily: "opus" }).account, "b");
  // a Fable request is unaffected: b is over the weekly threshold for fable? no (95 < 97) — but ranking for fable falls back to headroom → a
  assert.equal(pickAccount({ accounts, policy: aware, current: null, modelFamily: "fable" }).account, "a");
  // feature off: plain most-headroom (tie → name)
  assert.equal(pickAccount({ accounts, policy: { ...aware, modelAware: false }, current: null, modelFamily: "sonnet" }).account, "a");
});

test("model-aware never overrides session headroom or stickiness, and buckets to avoid flapping", () => {
  const accounts = [account("a", 85, 30, { fable: 100 }), account("b", 10, 30, { fable: 10 })];
  // a has the spent Fable window but almost no session headroom: b wins
  assert.equal(pickAccount({ accounts, policy: aware, current: null, modelFamily: "sonnet" }).account, "b");
  // sticky: a session already on b stays there
  assert.equal(
    pickAccount({ accounts: [account("a", 10, 30, { fable: 100 }), account("b", 10, 30, { fable: 10 })], policy: aware, current: "b", modelFamily: "sonnet" })
      .account,
    "b",
  );
  // within the same 10% bucket, ties go to headroom then name
  const close = [account("b", 10, 30, { fable: 52 }), account("a", 10, 30, { fable: 55 })];
  assert.equal(pickAccount({ accounts: close, policy: aware, current: null, modelFamily: "sonnet" }).account, "a");
});

test("distribute: new sessions land on a random within-threshold account; sticky and pinned still win", () => {
  const accounts = [account("a", 10, 30), account("b", 20, 30), account("c", 30, 30)];
  const seq = [0.05, 0.5, 0.95];
  let i = 0;
  const pol = { ...policy, distribute: true, random: () => seq[i++ % seq.length] };
  const picks = [0, 1, 2].map(() => pickAccount({ accounts, policy: pol, current: null, modelFamily: null }).account);
  assert.deepEqual(picks, ["a", "b", "c"]);
  // sticky: an assigned session stays
  assert.equal(pickAccount({ accounts, policy: pol, current: "c", modelFamily: null }).account, "c");
  // over-threshold accounts are never picked
  const withFull = [account("a", 95, 30), account("b", 20, 30), account("c", 30, 30)];
  for (let k = 0; k < 6; k++)
    assert.notEqual(pickAccount({ accounts: withFull, policy: { ...pol, random: Math.random }, current: null, modelFamily: null }).account, "a");
  // pinned wins
  assert.equal(pickAccount({ accounts, policy: { ...pol, pinned: "b" }, current: null, modelFamily: null }).account, "b");
});

test("eject hysteresis: an assigned session stays until ejectThreshold; new sessions stop landing at threshold", () => {
  const pol = { ...policy, ejectThreshold: 95 };
  const accounts = [account("a", 92, 30), account("b", 10, 30)];
  // new session: a is over threshold (90) → b
  assert.equal(pickAccount({ accounts, policy: pol, current: null, modelFamily: null }).account, "b");
  // assigned to a: 92 < 95 → stays
  assert.equal(pickAccount({ accounts, policy: pol, current: "a", modelFamily: null }).account, "a");
  // at 96 → ejected
  assert.equal(pickAccount({ accounts: [account("a", 96, 30), account("b", 10, 30)], policy: pol, current: "a", modelFamily: null }).account, "b");
});

test("proactive moves are gated globally: one per pool per 30 s", () => {
  const cur = accountResetting("cur", 30, 30, 120);
  const soonAcct = accountResetting("soon", 20, 60, 8);
  const pol = { ...soon, lastProactiveMoveAt: Date.now() - 5_000 };
  assert.equal(pickAccount({ accounts: [cur, soonAcct], policy: pol, current: "cur", modelFamily: null }).account, "cur");
  assert.equal(
    pickAccount({ accounts: [cur, soonAcct], policy: { ...pol, lastProactiveMoveAt: Date.now() - 60_000 }, current: "cur", modelFamily: null }).account,
    "soon",
  );
});
