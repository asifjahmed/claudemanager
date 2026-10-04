import { test } from "node:test";
import assert from "node:assert/strict";
import { ResponseAccumulator, parseRequestBody } from "../src/daemon/recorder.js";
import { applyWrite } from "../src/daemon/record-ops.js";
import { Db } from "../src/core/db.js";
import { normalizeUsage, nextAnniversary } from "../src/core/usage.js";
import { parseUserIdMetadata, modelFamily, keychainService, KEYCHAIN_SERVICE_BASE } from "../src/core/claude-internals.js";

const sse = (events: object[]) => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("accumulates a streamed response with text, tool_use and usage", () => {
  const acc = new ResponseAccumulator(true);
  const frames = sse([
    { type: "message_start", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 800, cache_creation_input_tokens: 50, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"ls"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ]);
  // feed in awkward chunk boundaries
  for (let i = 0; i < frames.length; i += 7) acc.push(Buffer.from(frames.slice(i, i + 7)));
  const out = acc.finish();
  assert.deepEqual(acc.usage, { input: 1000, output: 42, cacheRead: 800, cacheWrite: 50 });
  assert.equal(acc.stopReason, "tool_use");
  const content = out.content as any[];
  assert.equal(content[0].text, "Hello world");
  assert.deepEqual(content[1].input, { command: "ls" });
  assert.equal(out.textPreview, "Hello world");
});

test("non-streamed JSON response", () => {
  const acc = new ResponseAccumulator(false);
  acc.push(Buffer.from(JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } })));
  const out = acc.finish();
  assert.equal(acc.usage.input, 5);
  assert.equal(acc.stopReason, "end_turn");
  assert.equal(out.textPreview, "hi");
});

test("parseRequestBody extracts model, session id, last user text", () => {
  const b = parseRequestBody({
    model: "claude-fable-5-1",
    stream: true,
    system: [{ type: "text", text: "You are helpful" }],
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "x", content: "result" },
          { type: "text", text: "second" },
        ],
      },
    ],
    metadata: { user_id: "user_abc_account_11111111-2222-3333-4444-555555555555_session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    max_tokens: 100,
  });
  assert.equal(b.model, "claude-fable-5-1");
  assert.equal(b.system, "You are helpful");
  assert.equal(b.sessionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(b.accountUuid, "11111111-2222-3333-4444-555555555555");
  assert.ok(b.lastUserText?.includes("second"));
  assert.equal(b.params.max_tokens, 100);
  assert.equal(
    parseRequestBody({ model: "x" }, { "x-claude-code-session-id": "12345678-1234-1234-1234-123456789abc" }).sessionId,
    "12345678-1234-1234-1234-123456789abc",
  );
});

test("last-turn recording keeps tool definitions", () => {
  const db = new Db(":memory:");
  const tools = [{ name: "Bash", description: "Run a command" }];
  const raw = new TextEncoder().encode(
    JSON.stringify({
      model: "claude-fable-5-1",
      messages: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "earlier response" },
        { role: "user", content: "latest" },
      ],
      tools,
    }),
  ).buffer;

  applyWrite(
    db,
    {
      op: "start",
      id: 1,
      startedAt: Date.now(),
      path: "/v1/messages",
      model: "claude-fable-5-1",
      stream: true,
      sessionId: null,
      accountUuid: null,
      mode: "lastTurn",
      raw,
      modelFallbackFrom: null,
    },
    new Map(),
  );

  const body = db.getRequest(1)?.body;
  assert.deepEqual(body?.messages, [{ role: "user", content: "latest" }]);
  assert.deepEqual(body?.tools, tools);
  db.close();
});

test("usage endpoint normalization", () => {
  const u = normalizeUsage({
    five_hour: { utilization: 12.5, resets_at: "2026-09-16T20:00:00Z" },
    seven_day: { utilization: 40, resets_at: "2026-09-20T00:00:00Z" },
    seven_day_opus: { utilization: 3, resets_at: null },
    model_scoped: [{ display_name: "Fable", utilization: 55, resets_at: "2026-09-20T00:00:00Z" }],
    limits: [
      { kind: "session", group: "session", percent: 12, resets_at: "2026-09-16T20:00:00Z", scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 7,
        resets_at: "2026-09-20T00:00:00Z",
        scope: { model: { id: null, display_name: "Opus" }, surface: null },
      },
    ],
  });
  assert.equal(u.fiveHour.utilization, 12.5);
  assert.equal(u.models.opus.utilization, 7); // limits[] wins over legacy seven_day_opus
  assert.equal(u.models.fable.utilization, 55);
});

test("internals helpers", () => {
  assert.equal(modelFamily("claude-fable-5-1"), "fable");
  assert.equal(modelFamily("claude-opus-5"), "opus");
  assert.equal(modelFamily("claude-sonnet-5"), "sonnet");
  assert.equal(parseUserIdMetadata(undefined).sessionId, null);
  assert.equal(keychainService(process.env.HOME + "/.claude"), KEYCHAIN_SERVICE_BASE);
  assert.match(keychainService("/home/x/.claudemanager/accounts/a"), /^Claude Code-credentials-[0-9a-f]{8}$/);
});

test("next billing anniversary: same day-of-month, clamped, always in the future", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  assert.equal(nextAnniversary("2025-10-02T14:43:20Z", now)?.slice(0, 10), "2026-10-02");
  assert.equal(nextAnniversary("2025-03-21T17:28:03Z", now)?.slice(0, 10), "2026-10-21");
  assert.equal(nextAnniversary("2025-01-31T00:00:00Z", Date.parse("2026-02-01T00:00:00Z"))?.slice(0, 10), "2026-02-28");
  assert.equal(nextAnniversary(null, now), null);
});
