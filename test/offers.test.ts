import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFeed, mergeOffers, activeOffers } from "../src/core/offers.js";
import { ConfigSchema } from "../src/core/config.js";

test("bundled offers.json parses and the free-reset offer is active until its deadline", () => {
  const offers = parseFeed(JSON.parse(readFileSync(new URL("../../offers.json", import.meta.url), "utf8")));
  const fr = offers.find((o) => o.id === "anthropic-free-session-reset-2026-10")!;
  assert.equal(fr.kind, "free-reset");
  assert.equal(fr.usesPerAccount, 1);
  assert.deepEqual(fr.resets, ["session", "weekly", "model"]);
  assert.equal(activeOffers(offers, [], Date.parse("2026-10-01T00:00:00Z")).length, 1);
  // the deadline is end of day 2026-10-22 US Eastern: active one second before, gone one second after
  assert.equal(activeOffers(offers, [], Date.parse("2026-10-22T23:59:59-04:00")).length, 1);
  assert.equal(activeOffers(offers, [], Date.parse("2026-10-23T00:00:00-04:00")).length, 0);
  assert.equal(activeOffers(offers, [], Date.parse("2026-10-23T12:00:00Z")).length, 0);
  assert.equal(activeOffers(offers, ["anthropic-free-session-reset-2026-10"], Date.parse("2026-10-01T00:00:00Z")).length, 0);
});

test("feed validation rejects bad shapes; later sources override by id", () => {
  assert.throws(() => parseFeed({ version: 2, offers: [] }));
  assert.throws(() => parseFeed({ version: 1, offers: [{ id: "x", kind: "free-reset" }] }));
  const a = parseFeed({ version: 1, offers: [{ id: "promo-a", kind: "free-reset", title: "A", deadline: "2026-12-01T00:00:00Z" }] });
  const b = parseFeed({ version: 1, offers: [{ id: "promo-a", kind: "free-reset", title: "A2", deadline: "2026-12-31T00:00:00Z", usesPerAccount: 2 }] });
  const m = mergeOffers(a, b);
  assert.equal(m.length, 1);
  assert.equal(m[0].title, "A2");
  assert.equal(m[0].usesPerAccount, 2);
});

test("old freeReset config migrates into offers.used", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "cm-mig-"));
  const prev = process.env.CLAUDEMANAGER_HOME;
  process.env.CLAUDEMANAGER_HOME = home;
  try {
    // config.ts reads CLAUDEMANAGER_HOME at import time, so exercise the migration through the exported parser path instead
    const raw: any = { freeReset: { enabled: true, used: { a: "2026-09-23T06:26:00Z", b: "2026-09-23T06:28:00Z" }, concentrate: false } };
    writeFileSync(join(home, "config.json"), JSON.stringify(raw));
    const { migrateForTest } = await import("../src/core/config.js");
    migrateForTest(raw);
    const cfg = ConfigSchema.parse(raw);
    assert.deepEqual(cfg.offers.used["anthropic-free-session-reset-2026-10"], { a: ["2026-09-23T06:26:00Z"], b: ["2026-09-23T06:28:00Z"] });
    assert.equal(cfg.offers.concentrate, false);
    assert.equal((cfg as any).freeReset, undefined);
  } finally {
    process.env.CLAUDEMANAGER_HOME = prev;
  }
});
