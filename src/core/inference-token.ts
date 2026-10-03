import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CM_HOME } from "./config.js";

const execFileP = promisify(execFile);

/**
 * Optional long-lived inference tokens from `claude setup-token` (about a year, no refresh).
 * When present, the proxy uses this for the traffic path, so inference never depends on OAuth refresh.
 * Stored in the macOS keychain (one item per account) or, elsewhere, in a 0600 file under ~/.claudemanager/tokens/.
 */
export const INFERENCE_TOKEN_SERVICE = "claudemanager-inference-token";
const TOKEN_DIR = join(CM_HOME, "tokens");
const useKeychain = () => process.platform === "darwin";

const cache = new Map<string, { at: number; value: string | null }>();
const CACHE_MS = 60_000;

function tokenFile(account: string): string {
  return join(TOKEN_DIR, account);
}

async function readKeychain(account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("security", ["find-generic-password", "-s", INFERENCE_TOKEN_SERVICE, "-a", account, "-w"], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function readFile(account: string): string | null {
  try {
    return readFileSync(tokenFile(account), "utf8").trim() || null;
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<string | null>>();

/** Single-flight: concurrent callers on a cache miss share one keychain read instead of spawning one `security` each. */
export async function getInferenceToken(account: string, useCache = true): Promise<string | null> {
  const c = cache.get(account);
  if (useCache && c && Date.now() - c.at < CACHE_MS) return c.value;
  const pending = inflight.get(account);
  if (pending) return pending;
  const p = (async () => {
    try {
      const value = (useKeychain() ? await readKeychain(account) : null) ?? readFile(account);
      cache.set(account, { at: Date.now(), value });
      return value;
    } finally {
      inflight.delete(account);
    }
  })();
  inflight.set(account, p);
  return p;
}

/** A stored token was rejected upstream: forget it so routing stops offering it until it is replaced. */
export function invalidateInferenceToken(account: string): void {
  cache.set(account, { at: Date.now(), value: null });
}

export async function setInferenceToken(account: string, token: string): Promise<"keychain" | "file"> {
  cache.delete(account);
  if (useKeychain()) {
    try {
      await execFileP("security", ["add-generic-password", "-U", "-s", INFERENCE_TOKEN_SERVICE, "-a", account, "-w", token], { timeout: 10_000 });
      return "keychain";
    } catch {
      /* fall through to the file */
    }
  }
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${tokenFile(account)}.tmp-${process.pid}`;
  writeFileSync(tmp, token + "\n", { mode: 0o600 });
  renameSync(tmp, tokenFile(account));
  return "file";
}

export async function deleteInferenceToken(account: string): Promise<boolean> {
  cache.delete(account);
  let removed = false;
  if (useKeychain()) {
    try {
      await execFileP("security", ["delete-generic-password", "-s", INFERENCE_TOKEN_SERVICE, "-a", account], { timeout: 10_000 });
      removed = true;
    } catch {
      /* not in keychain */
    }
  }
  if (existsSync(tokenFile(account))) {
    unlinkSync(tokenFile(account));
    removed = true;
  }
  return removed;
}

export function clearInferenceTokenCache(): void {
  cache.clear();
}
