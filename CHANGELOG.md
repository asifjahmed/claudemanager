# Changelog

## 0.1.1 — 2026-10-04

- New installations store only the newest turn of each request (`log.bodies: lastTurn`); tool definitions
  are kept in that mode so the context inspector keeps working. `full` remains available. (#6, by @1cbyc)
- `cm demo` exits cleanly on a second shutdown signal instead of printing a stack trace under `npx`.
- The build sets the execute bit on the CLI and daemon entries; a clean rebuild under `npm link` left `cm`
  unrunnable.
- `scripts/export-parquet.py`: export the request log as Parquet (requests, turns, blobs) for analysis or
  training; documented under Observability.
- README: demo tour GIF; npm trusted publishing for releases.

## 0.1.0 — 2026-10-03

First public release.

- Local reverse proxy that spreads Claude Code traffic across several Claude Max accounts and switches
  before a session or weekly window fills; per-session account affinity; soonest-reset-first ranking.
- Never stalls: over-threshold accounts still serve when nothing better exists, and the proxy fails open
  with the caller's own credentials as a last resort.
- Sleep-safe OAuth refresh (single-use refresh tokens are never lost to a lost response), optional
  long-lived tokens via `claude setup-token`.
- Usage dashboard and `cm status` with session, weekly and per-model windows; a runway view (pooled headroom, burn rate, time-to-empty and reset timeline per window); request log with prompts, responses, tokens, cost estimates and proxy performance.
- Promotions as data (`offers.json`, daily feed, local overrides) with a planner for Anthropic's one-time
  free session reset: per-account gain now, best moment before the deadline, RESET NOW flags, concentrate
  routing, automatic detection of a used reset.
- Account management from the dashboard (add, rename, sign in again, long-lived token, enable/disable,
  remove); quota attribution by session; context-growth inspector; `cm demo`.
- For applications built on cm: advice headers on every response, `GET /api/advice`, `GET /api/wait`
  long-poll and `cm wait`, signed webhooks for limit / reset / routing / account events, and an opt-in
  model fallback.
- macOS (keychain, launchd) and Linux (credential files, systemd user unit).
