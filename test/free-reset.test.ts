import { test } from "node:test";
import assert from "node:assert/strict";
import { planFreeResets, FreeResetDetector } from "../src/core/free-reset.js";

const H = 3600_000;
const now = Date.parse("2026-09-24T12:00:00Z");
const iso = (h: number) => new Date(now + h * H).toISOString();
const deadline = iso(28 * 24);
const acct = (account: string, weeklyUtil: number | null, resetInH: number, extra: Partial<Parameters<typeof planFreeResets>[0]["accounts"][number]> = {}) => ({
  account,
  weeklyUtil,
  bindingWindow: "weekly",
  weeklyResetsAt: iso(resetInH),
  fiveHourUtil: 10,
  ownBurnPerHour: 1,
  used: [] as string[],
  disabled: false,
  ...extra,
});
const plan = (accounts: any[], over: Partial<Parameters<typeof planFreeResets>[0]> = {}) =>
  planFreeResets({
    offerId: "test",
    usesPerAccount: 1,
    accounts,
    deadline,
    pooledBurnPerHour: 2,
    concentrate: true,
    minUtil: 85,
    minHoursBeforeNaturalReset: 48,
    now,
    ...over,
  });

test("reset now when the window is nearly full and the natural reset is far away; gain is what would not fit", () => {
  const r = plan([acct("a", 92, 5 * 24)]);
  const p = r.plans[0];
  assert.equal(p.status, "reset-now");
  // demand until natural: 2%/h × 120 h = 240; would fit 8; gain = min(92, 232) = 92
  assert.equal(Math.round(p.gainNow!), 92);
  assert.match(r.summary, /Reset a now/);
});

test("worthless right before a natural reset; the planner schedules the next fill instead", () => {
  const r = plan([acct("a", 92, 6)]);
  const p = r.plans[0];
  assert.notEqual(p.status, "reset-now");
  assert.equal(Math.round(p.gainNow!), 4); // 2 × 6 = 12 demand, 8 fits → min(92, 12-8) = 4
  assert.equal(p.status, "scheduled");
  // after the natural reset in 6 h, filling at 2%/h reaches 100% in ~50 h with ~118 h left → gain ≈ 100
  assert.ok(p.gainAtBest! >= 90, `gain ${p.gainAtBest}`);
  assert.ok(Date.parse(p.bestAt!) > now + 6 * H);
});

test("used and expired are reported; deadline caps the projection", () => {
  const r = plan([acct("u", 50, 100, { used: ["2026-09-20T00:00:00Z"] }), acct("x", 90, 100)], { deadline: iso(-1) });
  assert.equal(r.plans[0].status, "used");
  assert.equal(r.plans[1].status, "expired");
});

test("low value when the pace never fills the window before a natural reset", () => {
  const r = plan([acct("a", 10, 24)], { pooledBurnPerHour: 0.1, concentrate: false, accounts: [acct("a", 10, 24, { ownBurnPerHour: 0.1 })] });
  assert.equal(r.plans[0].status, "low-value");
});

test("drain target: finish an account already well along, else the one whose natural reset is furthest away", () => {
  const r1 = plan([acct("a", 60, 5 * 24), acct("b", 5, 6 * 24)]);
  assert.equal(r1.drainTarget, "a");
  const r2 = plan([acct("a", 5, 2 * 24), acct("b", 5, 6 * 24), acct("c", 5, 4 * 24, { used: ["2026-09-20T00:00:00Z"] })]);
  assert.equal(r2.drainTarget, "b");
  assert.equal(plan([acct("a", 60, 5 * 24)], { concentrate: false }).drainTarget, null);
});

test("detector: a sharp weekly drop with the natural reset still ahead and the schedule unchanged is a free reset", () => {
  const d = new FreeResetDetector();
  const natural = iso(3 * 24);
  assert.equal(d.update("a", 80, natural, now), false);
  assert.equal(d.update("a", 82, natural, now + H), false); // climbing
  assert.equal(d.update("a", 2, natural, now + 2 * H), true); // free reset
  // a natural reset: drop AND resets_at moved a week forward → not a free reset
  const d2 = new FreeResetDetector();
  d2.update("b", 80, iso(1), now);
  assert.equal(d2.update("b", 0, iso(1 + 7 * 24), now + 2 * H), false);
});

test("complete when every enabled account has used its resets, or the deadline passed; usesPerAccount honoured", () => {
  const r = plan([
    acct("a", 50, 100, { used: ["2026-09-20T00:00:00Z"] }),
    acct("b", 50, 100, { used: ["2026-09-21T00:00:00Z"] }),
    acct("d", 50, 100, { disabled: true }),
  ]);
  assert.equal(r.complete, true);
  assert.equal(r.summary, "all resets used");
  assert.equal(r.drainTarget, null);
  const r2 = plan([acct("a", 92, 5 * 24, { used: ["2026-09-20T00:00:00Z"] })], { usesPerAccount: 2 });
  assert.equal(r2.plans[0].status, "reset-now");
  assert.equal(r2.plans[0].usesLeft, 1);
  assert.equal(plan([acct("a", 10, 100)], { deadline: iso(-1) }).complete, true);
});
