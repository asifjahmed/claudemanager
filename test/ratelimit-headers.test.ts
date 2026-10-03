import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRateLimitHeaders, mergeHeaderUsage } from "../src/core/ratelimit-headers.js";
import { usage } from "./helpers.js";

test("parses unified headers: fraction -> percent, unix -> ISO", () => {
  const reset = 1_800_000_000;
  const info = parseRateLimitHeaders({
    "anthropic-ratelimit-unified-5h-utilization": "0.4275",
    "anthropic-ratelimit-unified-5h-reset": String(reset),
    "anthropic-ratelimit-unified-7d-utilization": "0.12",
    "anthropic-ratelimit-unified-7d-reset": String(reset + 86400),
    "anthropic-ratelimit-unified-status": "allowed_warning",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
  });
  assert.equal(info.present, true);
  assert.equal(info.fiveHour?.utilization, 42.8);
  assert.equal(info.fiveHour?.resetsAt, new Date(reset * 1000).toISOString());
  assert.equal(info.sevenDay?.utilization, 12);
  assert.equal(info.status, "allowed_warning");
  assert.equal(info.representativeClaim, "five_hour");
});

test("absent headers -> not present", () => {
  const info = parseRateLimitHeaders({ "content-type": "application/json" });
  assert.equal(info.present, false);
  assert.equal(info.fiveHour, null);
});

test("merge keeps per-model data from the poll and overrides 5h/7d", () => {
  const prev = usage(10, 20, { fable: 33 });
  const info = parseRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.5", "anthropic-ratelimit-unified-5h-reset": "1800000000" });
  const m = mergeHeaderUsage(prev, info);
  assert.equal(m.fiveHour.utilization, 50);
  assert.equal(m.sevenDay.utilization, 20);
  assert.equal(m.models.fable.utilization, 33);
  assert.equal(m.source, "headers");
});
