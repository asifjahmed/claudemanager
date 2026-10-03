# claudemanager

Local reverse proxy + monitor that spreads Claude Code traffic across several Claude Max accounts and
switches accounts before a usage window fills. Node ≥ 22.13, TypeScript, ESM. Runtime deps: undici,
commander, zod. No framework anywhere; the dashboard is vanilla JS served by the daemon.

## Commands

- `npm run build` — compile `src/` to `dist/`. `npm run build:test` — compile tests to `dist-test/`.
- `npm test` — build both, then `node --test`. Tests never touch the network, the keychain or
  `~/.claudemanager`: they use `test/fake-upstream.ts`, injected `getToken`/`fetchImpl`, `:memory:`
  SQLite, and `CLAUDEMANAGER_HOME` pointed at a temp dir by `test/setup.ts`.
- `npm run lint` / `npm run format` — eslint + prettier. CI runs typecheck, lint and tests on macOS and
  Ubuntu, Node 22 and 26.
- `npm run dev:daemon` — daemon in the foreground with tsx. `npm run dev:cli -- <args>` — CLI from source.
- After `npm run build`, `cm daemon restart` picks up the change (the service manager owns the process).
  Before restarting a daemon that other people's sessions use, check `cm daemon status` for load: an
  in-flight request fails once and Claude Code retries it.

## Layout

- `src/core/` — pure logic, no I/O except `credentials.ts`, `inference-token.ts`, `db.ts`, `usage.ts`.
  - `router.ts` — `pickAccount()`: eligibility tiers, stickiness, soonest-weekly-reset ranking, guarded
    proactive moves. Pure; test it directly.
  - `runway.ts` — pooled headroom vs burn rate vs reset schedule per window. Pure. Deliberately no demand
    prediction or routing simulation: measured consumption is capped by the pool, so "accounts needed"
    estimates were wrong by construction.
  - `claude-internals.ts` — EVERY undocumented Claude Code detail: keychain naming, OAuth endpoints and
    client id, usage endpoint and its `limits[]` shape, `anthropic-ratelimit-unified-*` headers, the
    session-id header, passthrough paths, model-family mapping. Nothing else may hardcode any of it.
  - `credentials.ts` — credential storage and the sleep-safe OAuth refresh (see the header comment).
  - `config.ts` — zod schema, paths, `policyFromConfig()`.
  - `account-ops.ts` — sign-in, setup-token, rename, remove; shared by the CLI and the dashboard jobs.
  - `attribution.ts`, `context-growth.ts` — quota by session and prompt growth per session. Pure.
  - `offers.ts` — promotion definitions (schema, merge, active); `free-reset.ts` — the free-reset planner and
    the detector that marks a reset used. Pure. Definitions live in `offers.json` at the repo root, which is also
    the daily feed existing installs fetch: editing that file is how a new promotion reaches users.
  - `advice.ts` — what a session should do next (continue / switch-model / pause) plus the response headers;
    `limits.ts` — edge-triggered reset / approaching / exhausted / recovered events from usage updates. Pure.
- `src/daemon/` — `server.ts` wires everything (`createDaemon()`); `proxy.ts` is the hot path (buffer
  body, pick account, swap `Authorization`, stream back, retry on genuine 429, fail open);
  `poller.ts` polls usage and refreshes tokens; `recorder.ts` + `record-ops.ts` + `db-worker.ts` record
  requests in a worker thread; `affinity.ts` maps sessions to accounts; `api.ts` is the localhost control
  API + SSE; `static.ts` serves `web/`.
- `src/cli/` — one file per command group under `commands/`; `service/` has the launchd and systemd
  backends; `client.ts` talks to the daemon; `status.ts` and `render.ts` render.
- `src/daemon/offer-store.ts` — bundled + feed + local offer definitions, daily refresh with an on-disk cache.
- `src/dev/` — `fake-upstream.ts` (used by tests and `cm demo`) and `demo.ts`.
- `web/` — `index.html`, `app.js`, `style.css`. No build step. Every string from upstream or the user
  goes through `esc()` before `innerHTML`.

## Rules that come from incidents (do not regress)

- **Never stall a session.** Order of preference: an account within thresholds → an account over a
  switch threshold but under 100% on every relevant window (relaxed) → fail open and forward with the
  caller's own credentials. Thresholds are preferences, not limits. Only a window at 100%, a
  server-confirmed exhaustion, a dead token or a disabled flag removes an account from rotation.
- **A 429 without `anthropic-ratelimit-unified-*` headers is a transient throttle**, not a usage limit.
  Pass it through; Claude Code retries. Only status `rate_limited`/`rejected` marks an account exhausted.
- **OAuth refresh tokens are single-use and there is no reuse grace.** A lost refresh response kills the
  login until a human logs in again. Hence: no refresh until the machine has been awake ~30 s, a
  credential-free connectivity preflight first, a long response timeout (never abort a refresh early),
  refreshes serialized across accounts with a hold after any network failure, refresh early while the old
  token still works, keep an unpersisted fresh token in memory. All of this is in `credentials.ts`.
- **`claude setup-token` rewrites the login of the `CLAUDE_CONFIG_DIR` it runs in.** Run it in a
  throwaway dir. Its token cannot read the usage endpoint (no `user:profile` scope), so an account needs
  both a long-lived token (traffic) and a normal login (usage numbers).
- **Nothing heavy on the event loop.** Body parsing, gzip, SQLite writes and pruning happen in the DB
  worker. The proxy hands over raw buffers by transfer. Never VACUUM automatically.
- **Do not rewrite request bodies.** The proxy only replaces the `Authorization` header. Claude Code
  already sets 1-hour cache breakpoints; cache reads dominate quota consumption, and the lever is context
  length, not TTL. The single exception is the opt-in model fallback (`modelFallback` config): it rewrites
  only the `model` field, is off by default, and every use is recorded, logged, sent as an event and flagged
  in the `x-cm-model-fallback` header.
- **Sessions stick to their account** (their prompt cache lives there). Moving a session re-writes its
  whole context; the router moves one only when it must or when the guarded perishable rule applies.
- **The usage endpoint rate-limits polling.** Keep the cadence gentle and the backoff in place; the live
  response headers keep the serving account fresh regardless.
- **Nothing on the request path may block or scale with sessions.** No SQLite queries in bus subscribers (the
  planner recomputes on poll snapshots and a timer, from a cached row set), SSE state frames are coalesced per
  client, per-request memory is released right after the recorder takes its copy, a client disconnect aborts the
  upstream stream, and the recorder sheds bodies when the worker backlog passes `Recorder.SHED_BACKLOG`.
  `bench/load.mjs` is the regression check: 1,000 sessions must run inside a 512 MB heap.
- **Herds are prevented by design, not by luck.** Assigned sessions stay until `ejectThreshold`; moves are
  budgeted (`maxMovesPerMinute` + 2% of active sessions) except for exhaustion/auth; proactive moves are gated
  globally; exhaustion events are edge-triggered.
- **Never restart the daemon from code paths a user did not ask for**, and never spawn a second daemon
  next to the service manager's. `cm daemon start|stop|restart` go through launchd/systemd when a
  service is installed.

## Conventions

- Error messages name the fix: `cm accounts login <name>`, `cm daemon restart`, `cm route on`.
- A new config key needs: a zod default in `config.ts`, a row in the README configuration table, a
  dashboard control if it is a policy knob. `cm config set` works automatically.
- Platform-specific code lives behind `process.platform` checks in `credentials.ts`,
  `inference-token.ts` and `src/cli/service/`. Everything else must be portable across macOS and Linux.
- After a Claude Code update: `cm doctor`. If it fails, fix `claude-internals.ts` and bump
  `VERIFIED_CLAUDE_CODE_VERSION`.
- Tests for routing and runway are unit tests on pure functions; proxy behavior is tested end to end
  against the fake upstream (`test/proxy.test.ts`); credential refresh against a fake store and network
  (`test/credentials.test.ts`). Add a test for every incident-derived rule you touch.
- Commit messages say what changed and why (the incident, the measurement). Keep account names,
  emails and personal paths out of code, tests, docs and commits.
- The user's `~/.claude/settings.json` is edited only by `cm route on|off`, atomically, with a backup,
  and never when it fails to parse.
