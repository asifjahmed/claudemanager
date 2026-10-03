import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  keychainService,
  keychainAccount,
  credentialsFilePath,
  OAUTH_TOKEN_URL,
  OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_SCOPES,
  type ClaudeAiOauth,
  type StoredCredentials,
} from "./claude-internals.js";

const execFileP = promisify(execFile);

/**
 * missing  – nothing stored for this config dir
 * relogin  – the refresh token is dead (invalid_grant): only `claude auth login` fixes it
 * network  – could not reach the token endpoint, or sent a refresh and got no response
 * held     – refresh deliberately deferred (system just woke, or a recent network failure)
 */
export type CredentialErrorCode = "missing" | "keychain" | "parse" | "refresh" | "expired" | "network" | "relogin" | "held";

export class CredentialError extends Error {
  constructor(
    message: string,
    public readonly code: CredentialErrorCode,
  ) {
    super(message);
  }
  /** true when the account cannot work again without a human logging in */
  get needsLogin(): boolean {
    return this.code === "relogin" || this.code === "missing" || this.code === "expired";
  }
}

export interface ReadResult {
  creds: ClaudeAiOauth;
  raw: StoredCredentials;
  from: "keychain" | "file";
}

/** Storage backend; tests inject a fake. */
export interface CredentialIO {
  read(configDir: string): Promise<ReadResult | null>;
  write(configDir: string, raw: StoredCredentials, from: "keychain" | "file"): Promise<void>;
}

async function readKeychain(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("security", ["find-generic-password", "-s", service, "-a", keychainAccount(), "-w"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch (err: any) {
    if (typeof err?.stderr === "string" && /could not be found/i.test(err.stderr)) return null;
    if (err?.code === 44) return null;
    throw new CredentialError(`keychain read failed for "${service}": ${err?.stderr || err?.message}`, "keychain");
  }
}

async function writeKeychain(service: string, secret: string): Promise<void> {
  await execFileP("security", ["add-generic-password", "-U", "-s", service, "-a", keychainAccount(), "-w", secret], {
    timeout: 10_000,
  });
}

function parseBlob(text: string, where: string): StoredCredentials {
  try {
    return JSON.parse(text) as StoredCredentials;
  } catch {
    throw new CredentialError(`could not parse credentials from ${where}`, "parse");
  }
}

/** Read credentials for a config dir: keychain first, then .credentials.json. */
export async function readCredentials(configDir: string): Promise<ReadResult | null> {
  if (process.platform === "darwin") {
    const blob = await readKeychain(keychainService(configDir));
    if (blob) {
      const raw = parseBlob(blob, "keychain");
      if (raw.claudeAiOauth?.accessToken) return { creds: raw.claudeAiOauth, raw, from: "keychain" };
    }
  }
  const file = credentialsFilePath(configDir);
  if (existsSync(file)) {
    const raw = parseBlob(readFileSync(file, "utf8"), file);
    if (raw.claudeAiOauth?.accessToken) return { creds: raw.claudeAiOauth, raw, from: "file" };
  }
  return null;
}

/** Write credentials back where they came from (keychain on macOS; mirror to file if the file exists). */
export async function writeCredentials(configDir: string, raw: StoredCredentials, from: "keychain" | "file"): Promise<void> {
  const text = JSON.stringify(raw);
  const file = credentialsFilePath(configDir);
  if (process.platform === "darwin" && from === "keychain") {
    await writeKeychain(keychainService(configDir), text);
    if (existsSync(file)) writeFileAtomic(file, text);
    return;
  }
  writeFileAtomic(file, text);
}

function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

const realIO: CredentialIO = { read: readCredentials, write: writeCredentials };

export interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  [k: string]: unknown;
}

/** How long to wait for the token endpoint's answer. Aborting early can LOSE a rotated refresh token, so be patient. */
export const REFRESH_TIMEOUT_MS = 120_000;
export const PREFLIGHT_TIMEOUT_MS = 5_000;

/** Cheap reachability check. Any HTTP response means the network path is up. Sends no credentials. */
export async function preflight(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetchImpl(OAUTH_TOKEN_URL, { method: "GET", signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => {});
  } catch (err: any) {
    throw new CredentialError(`network not ready (preflight to token endpoint failed: ${err?.message ?? err}); refresh not attempted`, "network");
  }
}

/**
 * Exchange a refresh token for a new access token.
 * Refresh tokens are SINGLE-USE: once the request reaches the server the old token is dead, whether or not we see
 * the response. Hence the preflight (don't send into a dead network) and the long timeout (don't abandon a slow answer).
 */
export async function refreshOAuth(creds: ClaudeAiOauth, fetchImpl: typeof fetch = fetch): Promise<ClaudeAiOauth> {
  const scopes = creds.scopes && creds.scopes.length ? creds.scopes : DEFAULT_OAUTH_SCOPES;
  const body = {
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: scopes.join(" "),
  };
  let res: Response;
  try {
    res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new CredentialError(`refresh request sent but no response (${err?.message ?? err}); the refresh token may have been consumed`, "network");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 400 && /invalid_grant/.test(text)) {
      throw new CredentialError("login expired (refresh token rejected: invalid_grant)", "relogin");
    }
    throw new CredentialError(`token refresh failed: HTTP ${res.status} ${text.replace(/\s+/g, " ").slice(0, 200)}`, "refresh");
  }
  const data = (await res.json()) as RefreshResponse;
  if (!data.access_token) throw new CredentialError("token refresh returned no access_token", "refresh");
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes: data.scope ? data.scope.split(" ") : scopes,
  };
}

// ---- process-wide refresh coordination -------------------------------------------------------------------------

/** One refresh at a time across ALL accounts, so a single bad network moment cannot burn every refresh token. */
let globalChain: Promise<unknown> = Promise.resolve();
function withGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = globalChain.catch(() => {}).then(fn);
  globalChain = next;
  return next;
}
/** After a network failure during refresh, nobody refreshes until this time. */
let refreshHoldUntil = 0;
export const REFRESH_HOLD_MS = 120_000;
export function refreshHeldUntil(): number {
  return refreshHoldUntil;
}
export function resetRefreshCoordination(): void {
  refreshHoldUntil = 0;
  readCache.clear();
  unpersisted.clear();
}

/** Short read cache: the proxy asks for a token on every request and spawning `security` each time is wasteful. */
const READ_CACHE_MS = 30_000;
const readCache = new Map<string, { at: number; value: ReadResult }>();
/** Fresh credentials we obtained but could not persist yet; never lose these. */
const unpersisted = new Map<string, ReadResult>();

export function invalidateCredentialCache(configDir?: string): void {
  if (configDir) {
    readCache.delete(configDir);
    unpersisted.delete(configDir);
  } else {
    readCache.clear();
    unpersisted.clear();
  }
}

export interface FreshTokenOptions {
  /** Refresh when less than this many ms remain (default 5 min). */
  minTtlMs?: number;
  /** Force a refresh even if the token looks valid (e.g. after a 401). */
  force?: boolean;
  /** false = never start a refresh now (e.g. the machine just woke); a still-valid token is returned, else `held`. */
  allowRefresh?: boolean;
  fetchImpl?: typeof fetch;
  io?: CredentialIO;
  log?: (msg: string) => void;
}

async function load(configDir: string, io: CredentialIO, useCache: boolean): Promise<ReadResult | null> {
  const pending = unpersisted.get(configDir);
  if (useCache) {
    const c = readCache.get(configDir);
    if (c && Date.now() - c.at < READ_CACHE_MS) return c.value;
  }
  let read = await io.read(configDir);
  // Prefer credentials we refreshed but failed to persist, and try persisting them again.
  if (pending && (!read || pending.creds.expiresAt > read.creds.expiresAt)) {
    try {
      await io.write(configDir, pending.raw, pending.from);
      unpersisted.delete(configDir);
    } catch {
      /* keep in memory */
    }
    read = pending;
  } else if (pending) {
    unpersisted.delete(configDir);
  }
  if (read) readCache.set(configDir, { at: Date.now(), value: read });
  return read;
}

/**
 * Return a valid access token for the config dir, refreshing (and persisting) if needed.
 * Never throws away a still-valid access token because a refresh could not be attempted.
 */
const inflightFresh = new Map<string, Promise<ClaudeAiOauth>>();

export async function getFreshToken(configDir: string, opts: FreshTokenOptions = {}): Promise<ClaudeAiOauth> {
  // single-flight per config dir: a burst of concurrent requests shares one read/refresh instead of N keychain spawns
  const key = `${configDir}|${opts.force ? "f" : "n"}`;
  const pending = inflightFresh.get(key);
  if (pending) return pending;
  const p = getFreshTokenImpl(configDir, opts).finally(() => inflightFresh.delete(key));
  inflightFresh.set(key, p);
  return p;
}

async function getFreshTokenImpl(configDir: string, opts: FreshTokenOptions = {}): Promise<ClaudeAiOauth> {
  const minTtl = opts.minTtlMs ?? 5 * 60_000;
  const io = opts.io ?? realIO;
  const log = opts.log ?? (() => {});

  const first = await load(configDir, io, !opts.force);
  if (!first) throw new CredentialError(`no credentials found for ${configDir}`, "missing");
  if (!opts.force && first.creds.expiresAt - Date.now() > minTtl) return first.creds;

  const usableOrThrow = (creds: ClaudeAiOauth, err: CredentialError): ClaudeAiOauth => {
    if (!opts.force && creds.expiresAt - Date.now() > 0) return creds; // still valid: keep serving with it
    throw err;
  };

  if (opts.allowRefresh === false) {
    return usableOrThrow(first.creds, new CredentialError("access token expired; refresh deferred until the system has been awake for a bit", "held"));
  }
  if (Date.now() < refreshHoldUntil) {
    return usableOrThrow(
      first.creds,
      new CredentialError(`access token expired; refresh on hold for ${Math.ceil((refreshHoldUntil - Date.now()) / 1000)}s after a network failure`, "held"),
    );
  }

  return withGlobalLock(async () => {
    // Re-read inside the lock: another caller (or process) may have refreshed meanwhile.
    const read = await load(configDir, io, false);
    if (!read) throw new CredentialError(`no credentials found for ${configDir}`, "missing");
    const { creds, raw, from } = read;
    const changed = creds.accessToken !== first.creds.accessToken;
    if ((!opts.force || changed) && creds.expiresAt - Date.now() > minTtl) return creds;
    if (Date.now() < refreshHoldUntil) return usableOrThrow(creds, new CredentialError("refresh on hold after a network failure", "held"));
    if (!creds.refreshToken) throw new CredentialError("access token expired and no refresh token stored", "expired");

    try {
      await preflight(opts.fetchImpl);
    } catch (err: any) {
      refreshHoldUntil = Date.now() + REFRESH_HOLD_MS;
      return usableOrThrow(creds, err);
    }
    let fresh: ClaudeAiOauth;
    try {
      fresh = await refreshOAuth(creds, opts.fetchImpl);
    } catch (err: any) {
      if (err instanceof CredentialError && err.code === "network") {
        refreshHoldUntil = Date.now() + REFRESH_HOLD_MS;
        log(`refresh for ${configDir}: ${err.message}`);
        return usableOrThrow(creds, err);
      }
      throw err;
    }
    const next: ReadResult = { creds: fresh, raw: { ...raw, claudeAiOauth: fresh }, from };
    readCache.set(configDir, { at: Date.now(), value: next });
    try {
      await io.write(configDir, next.raw, from);
    } catch (err: any) {
      // The new refresh token exists only in memory now. Keep it and retry persisting on the next read.
      unpersisted.set(configDir, next);
      log(`WARNING: refreshed token for ${configDir} could not be persisted (${err?.message ?? err}); holding it in memory`);
    }
    return fresh;
  });
}
