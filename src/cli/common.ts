import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_LOG_PATH, DB_PATH, ensureHome } from "../core/config.js";
import { defaultClaudeConfigDir } from "../core/claude-internals.js";
import { Db } from "../core/db.js";
import { daemonAlive, daemonBase } from "./client.js";
import { c } from "./render.js";
import { service } from "./service/index.js";

export function die(msg: string, code = 1): never {
  process.stderr.write(c.red(msg) + "\n");
  process.exit(code);
}

/** Claude Code only hashes the keychain entry when CLAUDE_CONFIG_DIR is set, so leave it unset for the default dir. */
export function claudeEnvFor(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL; // auth flows must talk to Anthropic directly, never through the proxy
  if (resolve(dir) === resolve(defaultClaudeConfigDir())) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

/** Exit with a helpful message when the `claude` CLI is not installed. */
export function requireClaudeCli(): void {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    die("the `claude` CLI is not on PATH. Install Claude Code first: https://docs.claude.com/en/docs/claude-code (then re-run this command)");
  }
}

export function claudeVersion(): string | null {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || "").trim().split(" ")[0] || null;
}

export function authStatus(dir: string): any {
  const st = spawnSync("claude", ["auth", "status", "--json"], { encoding: "utf8", env: claudeEnvFor(dir) });
  try {
    return JSON.parse(st.stdout || "{}");
  } catch {
    return {};
  }
}

/** How to start the daemon process: compiled entry under node, or the TS source under tsx in dev. */
export function daemonEntry(): { cmd: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith(".ts");
  const entry = resolve(here, "..", "..", "daemon", isTs ? "main.ts" : "main.js");
  if (isTs) return { cmd: "npx", args: ["tsx", entry] };
  return { cmd: process.execPath, args: [entry] };
}

export async function waitAlive(up: boolean, ms = 10_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!!(await daemonAlive()) === up) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function lastLogLines(n = 3): string {
  try {
    const lines = readFileSync(DAEMON_LOG_PATH, "utf8").trimEnd().split("\n");
    return lines.slice(-n).join("\n");
  } catch {
    return "";
  }
}

/** Make sure a daemon is running: via the service manager when installed, else as a detached child. */
export async function ensureDaemon(quiet = false): Promise<void> {
  if (await daemonAlive()) return;
  ensureHome();
  const svc = service();
  if (svc?.installed()) {
    // Let the service manager own the process so we never end up with two daemons.
    svc.start();
    if (await waitAlive(true)) {
      if (!quiet) process.stderr.write(c.dim(`daemon started via ${svc.name} on ${daemonBase()}\n`));
      return;
    }
    die(`${svc.name} did not bring the daemon up. Last log lines (${DAEMON_LOG_PATH}):\n${lastLogLines()}`);
  }
  const { cmd, args } = daemonEntry();
  const out = openSync(DAEMON_LOG_PATH, "a");
  const child = spawn(cmd, args, { detached: true, stdio: ["ignore", out, out], env: { ...process.env } });
  child.on("error", (err) => die(`could not start the daemon: ${err.message}`));
  child.unref();
  if (await waitAlive(true)) {
    if (!quiet) process.stderr.write(c.dim(`daemon started (pid ${child.pid}) on ${daemonBase()}\n`));
    return;
  }
  die(`daemon did not come up. Last log lines (${DAEMON_LOG_PATH}):\n${lastLogLines()}`);
}

export function withDb<T>(fn: (db: Db) => T): T {
  if (!existsSync(DB_PATH)) die(`no database yet at ${DB_PATH} (start the daemon and route some traffic)`);
  const db = new Db(DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Open a URL in the user's browser without crashing if no opener exists. */
export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
  child.on("error", () => process.stderr.write(c.dim(`(could not launch a browser; open ${url} yourself)\n`)));
  child.unref();
}
