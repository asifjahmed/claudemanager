# Security

## What this tool holds

- **Your Claude logins.** One per account, stored where Claude Code stores its own: the macOS keychain, or
  `<config dir>/.credentials.json` (mode 0600) on Linux. Optional long-lived tokens from
  `claude setup-token` are stored the same way (keychain, or `~/.claudemanager/tokens/`).
- **Every prompt and response** that goes through the proxy, in `~/.claudemanager/claudemanager.db`
  (SQLite, mode 0600, plaintext). That includes file contents Claude Code reads. Set
  `cm config set log.bodies none` to keep only metadata, or `lastTurn` to keep the newest user message and the
  response. `cm purge` deletes what is stored.
- **A control API and dashboard** on `127.0.0.1` with no authentication. It only accepts requests whose
  `Host` and `Origin` are the daemon's own, which blocks browsers on other sites and DNS rebinding, but any
  process running as any user on the same machine can read the request log through it. Do not run this on a
  shared host.

## What it does on the wire

The proxy forwards Claude Code's requests to `api.anthropic.com` with the `Authorization` header replaced by
the chosen account's token. It does not modify request bodies. Requests to other paths pass through with the
caller's own credentials. Nothing is sent anywhere else.

## Not affiliated with Anthropic

This project relies on Claude Code internals that Anthropic has not published (credential storage, the usage
endpoint, rate-limit headers). They can change without notice; `cm doctor` checks each assumption.
Whether rotating between subscriptions you own is acceptable under Anthropic's terms is your responsibility.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on
this repository ("Report a vulnerability" under the Security tab), or email the address on the maintainer's
GitHub profile. You should hear back within a week.
