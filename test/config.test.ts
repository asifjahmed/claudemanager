import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema } from "../src/core/config.js";

test("request bodies default to the last turn while explicit modes are preserved", () => {
  assert.equal(ConfigSchema.parse({}).log.bodies, "lastTurn");
  assert.equal(ConfigSchema.parse({ log: { bodies: "full" } }).log.bodies, "full");
  assert.equal(ConfigSchema.parse({ log: { bodies: "none" } }).log.bodies, "none");
});
