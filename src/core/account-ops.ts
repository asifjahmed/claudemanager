/**
 * Account operations shared by the CLI and the daemon: sign an account in, run `claude setup-token`,
 * rename, remove. Interactive flows spawn the `claude` CLI; output is streamed to a callback so the
 * dashboard can show progress (and the login URL if the browser did not open).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultClaudeConfigDir, keychainService } from "./claude-internals.js";
import { readCredentials, invalidateCredentialCache } from "./credentials.js";
import { setInferenceToken, getInferenceToken, deleteInferenceToken } from "./inference-token.js";
import { ACCOUNTS_DIR, loadConfig, updateConfig, type Config } from "./config.js";

const execFileP = promisify(execFile);

export class AccountOpError extends Error {}

/** Claude Code only hashes the keychain entry when CLAUDE_CONFIG_DIR is set, so leave it unset for the default dir. */
export function claudeEnvFor(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL; // auth flows must talk to Anthropic directly, never through the proxy
  if (resolve(dir) === resolve(defaultClaudeConfigDir())) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

export async function authStatus(dir: string): Promise<any> {
  try {
    const { stdout } = await execFileP("claude", ["auth", "status", "--json"], { encoding: "utf8", env: claudeEnvFor(dir), timeout: 20_000 });
    return JSON.parse(stdout || "{}");
  } catch {
    return {};
  }
}

export async function claudeCliAvailable(): Promise<boolean> {
  try {
    await execFileP("claude", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export interface RunOptions {
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  /** inherit the terminal (CLI) instead of piping output */
  interactive?: boolean;
  timeoutMs?: number;
}

/** Run a `claude` subcommand under a config dir; resolves with captured stdout (empty when interactive). */
export function runClaude(args: string[], dir: string, opts: RunOptions = {}): Promise<{ code: number | null; stdout: string; all: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { env: claudeEnvFor(dir), stdio: opts.interactive ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let all = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : null;
    child.stdout?.on("data", (b: Buffer) => {
      const t = b.toString();
      stdout += t;
      all += t;
      opts.onOutput?.(t);
    });
    child.stderr?.on("data", (b: Buffer) => {
      const t = b.toString();
      all += t;
      opts.onOutput?.(t);
    });
    opts.signal?.addEventListener("abort", () => child.kill("SIGTERM"));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(
        new AccountOpError((err as NodeJS.ErrnoException).code === "ENOENT" ? "the `claude` CLI is not on PATH (install Claude Code first)" : err.message),
      );
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, all });
    });
  });
}

export function accountConfigDir(name: string): string {
  return join(ACCOUNTS_DIR, name);
}

export function validName(name: string): boolean {
  return /^[a-zA-Z0-9._-]{1,40}$/.test(name);
}

/** Sign in (browser flow) under the account's config dir, verify, and register or update the account. */
export async function loginAccount(
  name: string,
  opts: RunOptions & { email?: string; configDir?: string; force?: boolean } = {},
): Promise<{ email: string | null; orgName: string | null; subscriptionType: string | null; created: boolean }> {
  if (!validName(name)) throw new AccountOpError("name must be 1–40 characters of letters, digits, . _ -");
  const cfg = loadConfig();
  const existing = cfg.accounts.find((a) => a.name === name);
  const configDir = opts.configDir ? resolve(opts.configDir) : (existing?.configDir ?? accountConfigDir(name));
  const reuse = !!opts.configDir && resolve(opts.configDir) === resolve(defaultClaudeConfigDir());
  if (!reuse) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const r = await runClaude(["auth", "login", "--claudeai", ...(opts.email ? ["--email", opts.email] : [])], configDir, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    });
    if (r.code !== 0) throw new AccountOpError(`claude auth login exited with ${r.code}`);
  }
  const info = await authStatus(configDir);
  if (!info.loggedIn) throw new AccountOpError(`claude reports not logged in for ${configDir}`);
  const dup = cfg.accounts.find((a) => a.name !== name && a.email && info.email && a.email.toLowerCase() === info.email.toLowerCase());
  if (dup && !opts.force && !existing)
    throw new AccountOpError(`${info.email} is already registered as "${dup.name}"; two entries for one login share one rate limit`);
  invalidateCredentialCache(configDir);
  const creds = await readCredentials(configDir);
  if (!creds)
    throw new AccountOpError(
      process.platform === "darwin"
        ? `logged in, but no credentials readable from keychain service "${keychainService(configDir)}" or ${configDir}/.credentials.json`
        : `logged in, but ${configDir}/.credentials.json is missing or unreadable`,
    );
  updateConfig((c) => {
    const a = c.accounts.find((x) => x.name === name);
    if (a) {
      a.email = info.email ?? a.email;
      a.orgName = info.orgName ?? a.orgName;
      a.subscriptionType = info.subscriptionType ?? a.subscriptionType;
      a.disabled = false;
    } else c.accounts.push({ name, configDir, email: info.email, orgName: info.orgName, subscriptionType: info.subscriptionType });
  });
  return { email: info.email ?? null, orgName: info.orgName ?? null, subscriptionType: info.subscriptionType ?? null, created: !existing };
}

/**
 * Run `claude setup-token` in a throwaway config dir (it rewrites the login of whatever dir it runs in),
 * capture the token it prints, and store it for the account.
 */
export async function setupToken(name: string, opts: RunOptions = {}): Promise<{ where: "keychain" | "file" }> {
  const cfg = loadConfig();
  if (!cfg.accounts.some((a) => a.name === name)) throw new AccountOpError(`no account "${name}"`);
  const scratch = mkdtempSync(join(tmpdir(), "cm-setup-token-"));
  try {
    const r = await runClaude(["setup-token"], scratch, { ...opts, timeoutMs: opts.timeoutMs ?? 10 * 60_000 });
    const m = /(sk-ant-[A-Za-z0-9_-]{20,})/.exec(r.stdout) ?? /(sk-ant-[A-Za-z0-9_-]{20,})/.exec(r.all);
    if (!m) throw new AccountOpError(`claude setup-token exited with ${r.code} and printed no token`);
    const where = await setInferenceToken(name, m[1]);
    return { where };
  } finally {
    if (process.platform === "darwin") await execFileP("security", ["delete-generic-password", "-s", keychainService(scratch)]).catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Store a token the user pasted (CLI path). */
export async function storeToken(name: string, token: string): Promise<{ where: "keychain" | "file" }> {
  if (!loadConfig().accounts.some((a) => a.name === name)) throw new AccountOpError(`no account "${name}"`);
  return { where: await setInferenceToken(name, token.trim()) };
}

/** Rename an account (its alias). The config dir, login and tokens stay; the long-lived token is re-keyed. */
export async function renameAccount(from: string, to: string): Promise<Config> {
  if (!validName(to)) throw new AccountOpError("name must be 1–40 characters of letters, digits, . _ -");
  const cfg = loadConfig();
  if (!cfg.accounts.some((a) => a.name === from)) throw new AccountOpError(`no account "${from}"`);
  if (cfg.accounts.some((a) => a.name === to)) throw new AccountOpError(`an account named "${to}" already exists`);
  const tok = await getInferenceToken(from, false);
  if (tok) {
    await setInferenceToken(to, tok);
    await deleteInferenceToken(from);
  }
  return updateConfig((c) => {
    const a = c.accounts.find((x) => x.name === from)!;
    a.name = to;
    if (c.pinned === from) c.pinned = to;
  });
}

export function removeAccount(name: string): Config {
  const cfg = loadConfig();
  if (!cfg.accounts.some((a) => a.name === name)) throw new AccountOpError(`no account "${name}"`);
  return updateConfig((c) => {
    c.accounts = c.accounts.filter((a) => a.name !== name);
    if (c.pinned === name) c.pinned = null;
  });
}

export function accountDirExists(name: string): boolean {
  return existsSync(accountConfigDir(name));
}
