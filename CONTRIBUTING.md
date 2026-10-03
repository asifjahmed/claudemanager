# Contributing

Thanks for helping. This tool touches people's Claude logins and routes all of their Claude Code traffic,
so the bar for changes is "a stranger's session must not stall and their login must not die".

## Setup

```sh
git clone https://github.com/asifjahmed/claudemanager
cd claudemanager
npm install          # also builds dist/ via the prepare script
npm test             # builds tests to dist-test/ and runs them with node --test
npm run lint
```

Node ≥ 22.13 (`.nvmrc` says 26). Tests need neither the network, nor a Claude account, nor the keychain:
the proxy is exercised against `test/fake-upstream.ts`, credentials against a fake store and network, and
`CLAUDEMANAGER_HOME` points at a temp dir (`test/setup.ts`).

To try a change against your real setup: `npm run build`, then `cm daemon restart` (the service manager owns
the process). Check `cm daemon status` for load first; a request in flight at that moment fails once and
Claude Code retries it. `npm run dev:daemon` runs the daemon in the foreground from source.

## Where things live

`CLAUDE.md` at the repo root is the map: layout, the rules that came out of incidents, and conventions.
Read it before changing `src/daemon/proxy.ts`, `src/core/credentials.ts` or `src/core/router.ts`.

The one rule worth repeating: **every undocumented Claude Code detail lives in
`src/core/claude-internals.ts`.** If a Claude Code update breaks something, `cm doctor` tells you which
assumption failed; fix it there and bump `VERIFIED_CLAUDE_CODE_VERSION`.

## Pull requests

- One change per PR, with a test when the change is about routing, credentials, recording or the API.
  Routing and capacity are pure functions; test them directly.
- Keep the README's configuration and CLI tables in sync with `src/core/config.ts` and `src/cli/commands/`.
- No account names, emails or personal paths in code, tests, docs or commit messages.
- Run `npm run lint && npm test` before pushing; CI runs them on macOS and Ubuntu, Node 22 and 26.
- Describe what changed and why in the commit message. If it was an incident, say what happened.

## Reporting problems

Open an issue with the output of `cm doctor` and your Claude Code version (`claude --version`). For anything
involving credentials or stored prompts, see `SECURITY.md`.
