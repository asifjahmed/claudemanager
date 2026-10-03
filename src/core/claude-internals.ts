/**
 * Every undocumented Claude Code / Anthropic OAuth detail this tool depends on lives here.
 * Verified against Claude Code 2.1.280 (macOS, arm64) on 2026-09-22 by inspecting the binary.
 * If `cm doctor` reports a failure, this is the file to fix.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";

export const VERIFIED_CLAUDE_CODE_VERSION = "2.1.287";

/** OAuth client id Claude Code registers with the Anthropic IdP. */
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** Refresh-token grant endpoint (JSON body). */
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Plan-usage snapshot endpoint (Bearer OAuth token + beta header). */
export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** Account + organization profile (subscription status and creation date; no explicit billing-cycle field). */
export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const UPSTREAM_DEFAULT = "https://api.anthropic.com";

/** Keychain service name base. Suffixed with -<sha256(configDir)[0:8]> when CLAUDE_CONFIG_DIR is set. */
export const KEYCHAIN_SERVICE_BASE = "Claude Code-credentials";
export const CREDENTIALS_FILENAME = ".credentials.json";

export function defaultClaudeConfigDir(): string {
  return join(homedir(), ".claude");
}

export function keychainAccount(): string {
  let name: string;
  try {
    name = process.env.USER || userInfo().username;
  } catch {
    name = "claude-code-user";
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

/** Suffix Claude Code appends when CLAUDE_CONFIG_DIR is set: first 8 hex of sha256(NFC(path)). */
export function configDirHash(configDir: string): string {
  return createHash("sha256").update(configDir.normalize("NFC")).digest("hex").substring(0, 8);
}

/**
 * Keychain service for a config dir. Claude Code only adds the hash suffix when the env var is set,
 * so the default ~/.claude (launched without CLAUDE_CONFIG_DIR) uses the bare service name.
 */
export function keychainService(configDir: string): string {
  if (resolve(configDir) === resolve(defaultClaudeConfigDir())) return KEYCHAIN_SERVICE_BASE;
  return `${KEYCHAIN_SERVICE_BASE}-${configDirHash(configDir)}`;
}

export function credentialsFilePath(configDir: string): string {
  return join(configDir, CREDENTIALS_FILENAME);
}

/** Shape of the stored credential blob (keychain password / .credentials.json). */
export interface StoredCredentials {
  claudeAiOauth?: ClaudeAiOauth | null;
  [key: string]: unknown;
}
export interface ClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  /** ms since epoch */
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string | null;
  [key: string]: unknown;
}

/** Default scopes requested on refresh when the stored blob has none. */
export const DEFAULT_OAUTH_SCOPES = ["user:inference", "user:profile"];

/** Response headers on every OAuth /v1/messages response. Utilizations are fractions 0-1, resets unix seconds. */
export const RL = {
  fiveHourUtil: "anthropic-ratelimit-unified-5h-utilization",
  fiveHourReset: "anthropic-ratelimit-unified-5h-reset",
  fiveHourSurpassed: "anthropic-ratelimit-unified-5h-surpassed-threshold",
  sevenDayUtil: "anthropic-ratelimit-unified-7d-utilization",
  sevenDayReset: "anthropic-ratelimit-unified-7d-reset",
  sevenDaySurpassed: "anthropic-ratelimit-unified-7d-surpassed-threshold",
  status: "anthropic-ratelimit-unified-status",
  reset: "anthropic-ratelimit-unified-reset",
  representativeClaim: "anthropic-ratelimit-unified-representative-claim",
  overageStatus: "anthropic-ratelimit-unified-overage-status",
  overageUtil: "anthropic-ratelimit-unified-overage-utilization",
  fallback: "anthropic-ratelimit-unified-fallback",
} as const;

export type UnifiedStatus = "allowed" | "allowed_warning" | "rejected" | "rate_limited";

/** Paths the proxy must forward with the caller's own auth untouched. */
export const PASSTHROUGH_PATH_PREFIXES = ["/api/oauth/", "/v1/oauth/", "/api/organizations/", "/api/claude_cli_profile", "/api/event_logging/"];

/** Claude Code metadata.user_id format: user_<hash>_account_<uuid>_session_<uuid> */
export function parseUserIdMetadata(userId: string | undefined): { accountUuid: string | null; sessionId: string | null } {
  if (!userId) return { accountUuid: null, sessionId: null };
  const m = /account_([0-9a-f-]{36})_session_([0-9a-f-]{36})/i.exec(userId);
  return m ? { accountUuid: m[1], sessionId: m[2] } : { accountUuid: null, sessionId: null };
}

/** Map a model id to the per-model weekly window family name used by the usage endpoint. */
export function modelFamily(modelId: string | undefined): string | null {
  if (!modelId) return null;
  const m = modelId.toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return null;
}

/** Who the default Claude Code config dir (~/.claude) is signed in as, from ~/.claude.json. Null when unknown. */
export function readStockLogin(): { email: string | null; orgName: string | null; subscriptionType: string | null } | null {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const a = j?.oauthAccount;
    if (!a) return null;
    return { email: a.emailAddress ?? null, orgName: a.organizationName ?? null, subscriptionType: a.organizationType?.replace(/^claude_/, "") ?? null };
  } catch {
    return null;
  }
}
