import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRunway, type RunwayAccount, type SnapshotRow } from "../src/core/runway.js";

const H = 3600_000;
const now = Date.parse("2026-09-22T12:00:00Z");
const iso = (hFromNow: number) => new Date(now + hFromNow * H).toISOString();
const noSignals = { relaxedEvents: 0, fallbackEvents: 0, dryEvents: 0 };

function acct(
  account: string,
  fiveHour: number,
  sevenDay: number,
  weeklyResetH: number,
  sessionResetH = 3,
  models: Record<string, number> = {},
): RunwayAccount {
  return {
    account,
    fiveHour: { utilization: fiveHour, resetsAt: iso(sessionResetH) },
    sevenDay: { utilization: sevenDay, resetsAt: iso(weeklyResetH) },
    models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { utilization: v, resetsAt: iso(weeklyResetH) }])),
  };
}
/** snapshots for one account: linear climb of the weekly and session windows over `hours` ending now */
function climb(account: string, hours: number, weeklyPerHour: number, sessionPerHour = 0): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (let h = hours; h >= 0; h -= 0.5)
    rows.push({ at: now - h * H, account, fiveHourUtil: (hours - h) * sessionPerHour, sevenDayUtil: (hours - h) * weeklyPerHour, models: {} });
  return rows;
}
const base = (over: Partial<Parameters<typeof analyzeRunway>[0]>) =>
  analyzeRunway({ snapshots: [], accounts: [], signals: noSignals, threshold: 90, weeklyThreshold: 97, now, ...over });

test("no history: unknown", () => {
  const r = base({ accounts: [acct("a", 10, 20, 100)] });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.windows[0].status, "unknown");
});

test("burn rate comes from positive increments; resets (drops) are ignored", () => {
  // weekly climbs 2%/h for 48 h, with a reset in the middle
  const rows = climb("a", 48, 2);
  for (const r of rows) if (r.at > now - 24 * H) r.sevenDayUtil = (r.sevenDayUtil ?? 0) - 48; // second day restarts from 0
  const r = base({ snapshots: rows, accounts: [acct("a", 0, 48, 100)] });
  const weekly = r.windows.find((w) => w.key === "weekly")!;
  assert.ok(Math.abs(weekly.burnPerHour7d! - 2) < 0.1, `burn ${weekly.burnPerHour7d}`);
  assert.ok(Math.abs(weekly.burnPerHour24h! - 2) < 0.1);
});

test("pooled headroom drains at the burn rate and jumps at resets", () => {
  // two accounts, weekly 80% and 40%, burn 2%/h pooled: headroom 80 → empty in 40 h without resets;
  // account a resets at +10 h and frees 80 → empty at 10 + (80-20+80)/2 = 80 h
  const rows = [...climb("a", 24, 1), ...climb("b", 24, 1)];
  const r = base({ snapshots: rows, accounts: [acct("a", 0, 80, 10), acct("b", 0, 40, 150)] });
  const weekly = r.windows.find((w) => w.key === "weekly")!;
  assert.equal(weekly.headroom, 80);
  assert.ok(Math.abs(weekly.burnPerHour24h! - 2) < 0.05);
  assert.ok(Math.abs(weekly.emptyInHours24h! - 80) < 1, `empty in ${weekly.emptyInHours24h}`);
  assert.equal(weekly.nextReset!.account, "a");
  assert.equal(weekly.nextReset!.frees, 80);
});

test("critical when empty lands before the next reset and within a day", () => {
  const rows = [...climb("a", 24, 4)];
  const r = base({ snapshots: rows, accounts: [acct("a", 0, 90, 60)] }); // 10% left, 4%/h → 2.5 h; reset in 60 h
  const weekly = r.windows.find((w) => w.key === "weekly")!;
  assert.equal(weekly.status, "critical");
  assert.equal(r.verdict, "tight");
  assert.match(r.headline, /before the next reset/);
});

test("comfortable when nothing runs out within 7 days", () => {
  const rows = [...climb("a", 24, 0.1)];
  const r = base({ snapshots: rows, accounts: [acct("a", 0, 10, 100)] });
  assert.equal(r.verdict, "comfortable");
  assert.equal(r.windows.find((w) => w.key === "weekly")!.emptyInHours24h, null);
});

test("per-model windows get their own runway and use the weekly reset time", () => {
  const rows = climb("a", 24, 0.5).map((r) => ({ ...r, models: { fable: { utilization: (r.sevenDayUtil ?? 0) * 4 } } }));
  const r = base({ snapshots: rows, accounts: [acct("a", 0, 12, 30, 3, { fable: 96 })] });
  const f = r.windows.find((w) => w.key === "fable")!;
  assert.equal(f.kind, "model");
  assert.ok(Math.abs(f.burnPerHour24h! - 2) < 0.1);
  assert.equal(f.headroom, 4);
  assert.equal(f.nextReset!.at, Date.parse(iso(30)));
});

test("signals override: fail-open or pool-dry in the last week means tight; relaxed means close", () => {
  const rows = climb("a", 24, 0.1);
  assert.equal(base({ snapshots: rows, accounts: [acct("a", 0, 10, 100)], signals: { ...noSignals, fallbackEvents: 3 } }).verdict, "tight");
  assert.equal(base({ snapshots: rows, accounts: [acct("a", 0, 10, 100)], signals: { ...noSignals, relaxedEvents: 2 } }).verdict, "close");
});

test("session windows are rate limits: a pace under the pooled 5-hour capacity is sustainable", () => {
  // 3 accounts burning 12 %/h pooled = 60% per cycle against 300% of pooled 5-hour capacity
  const rows = [...climb("a", 24, 0, 4), ...climb("b", 24, 0, 4), ...climb("c", 24, 0, 4)];
  const r = base({ snapshots: rows, accounts: [acct("a", 20, 10, 100, 3), acct("b", 20, 10, 100, 4), acct("c", 20, 10, 100, 5)] });
  const s = r.windows.find((w) => w.key === "session")!;
  assert.ok(Math.abs(s.burnPerHour24h! - 12) < 0.2);
  assert.equal(s.emptyInHours24h, null);
  assert.equal(s.status, "ok");
  assert.match(s.note, /sustainable/);
});

test("session windows: a pace that would fill every window within one cycle runs out", () => {
  // one account, 30 %/h = 150% per 5 h against 100% capacity; 90% headroom → 3 h
  const rows = climb("a", 6, 0, 30);
  const r = base({ snapshots: rows, accounts: [acct("a", 10, 10, 100, 2)] });
  const s = r.windows.find((w) => w.key === "session")!;
  assert.ok(s.emptyInHours24h !== null && Math.abs(s.emptyInHours24h - 3) < 0.2, `empty ${s.emptyInHours24h}`);
  assert.equal(s.status, "critical");
});

test("per-model breakdown is keyed by model id; own-window families split their measured burn among their models", () => {
  const rows = [...climb("a", 24, 2)].map((r) => ({ ...r, models: { fable: { utilization: (r.sevenDayUtil ?? 0) * 2 } } }));
  const usageRows = [
    { key: "claude-sonnet-5", requests: 30, inputTokens: 1e6, outputTokens: 1e5, cacheReadTokens: 5e6, cacheWriteTokens: 1e5, estCostUsd: 3 },
    { key: "claude-opus-5", requests: 10, inputTokens: 5e5, outputTokens: 5e4, cacheReadTokens: 2e6, cacheWriteTokens: 5e4, estCostUsd: 1 },
    { key: "claude-fable-5-1", requests: 5, inputTokens: 1e5, outputTokens: 1e4, cacheReadTokens: 1e6, cacheWriteTokens: 1e4, estCostUsd: 3 },
    { key: "claude-fable-5", requests: 2, inputTokens: 5e4, outputTokens: 5e3, cacheReadTokens: 5e5, cacheWriteTokens: 5e3, estCostUsd: 1 },
  ];
  const r = base({ snapshots: rows, accounts: [acct("a", 0, 48, 100, 3, { fable: 96 })], modelUsage24h: usageRows, modelUsage7d: usageRows });
  const ids = r.models.map((m) => m.model);
  assert.deepEqual(ids, ["claude-fable-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]);
  const sonnet = r.models.find((m) => m.model === "claude-sonnet-5")!;
  const f51 = r.models.find((m) => m.model === "claude-fable-5-1")!;
  const f5 = r.models.find((m) => m.model === "claude-fable-5")!;
  assert.equal(Math.round(sonnet.share24h! * 100), 38); // 3 of 8
  assert.equal(sonnet.bindingWindow, "Weekly, all models");
  assert.ok(Math.abs(sonnet.burnPerHour24h! - 2 * 0.375) < 0.05);
  assert.equal(f51.bindingWindow, "Weekly, Fable");
  // the Fable window burns 4 %/h; 5.1 has 3/4 of the family's cost, 5 has 1/4
  assert.ok(Math.abs(f51.burnPerHour24h! - 3) < 0.1);
  assert.ok(Math.abs(f5.burnPerHour24h! - 1) < 0.1);
  assert.equal(f51.headroom, 4);
  assert.equal(f51.family, "fable");
});
