/**
 * The one place that edits the user's ~/.claude/settings.json: native routing on/off.
 * Never overwrites a file it cannot parse; always keeps a timestamped backup; writes atomically.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultClaudeConfigDir } from "./claude-internals.js";

export const SETTINGS_PATH = join(defaultClaudeConfigDir(), "settings.json");

export function readSettings(): Record<string, any> {
  if (!existsSync(SETTINGS_PATH)) return {};
  const text = readFileSync(SETTINGS_PATH, "utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err: any) {
    throw new Error(`${SETTINGS_PATH} is not valid JSON (${err.message}); not touching it. Fix the file, then re-run.`, { cause: err });
  }
}

export function writeSettings(s: Record<string, any>): string | null {
  let backup: string | null = null;
  if (existsSync(SETTINGS_PATH)) {
    backup = `${SETTINGS_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    writeFileSync(backup, readFileSync(SETTINGS_PATH));
  }
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, SETTINGS_PATH);
  if (backup) chmodSync(backup, 0o600);
  return backup;
}

/** The base URL new Claude Code sessions use, or null when they talk to Anthropic directly. */
export function nativeRoutingUrl(): string | null {
  try {
    return readSettings()?.env?.ANTHROPIC_BASE_URL ?? null;
  } catch {
    return null;
  }
}

/**
 * Route new sessions through the proxy (on) or straight to Anthropic (off).
 * Off with `directToken` set makes Claude Code use that long-lived token (CLAUDE_CODE_OAUTH_TOKEN outranks the
 * stored login), so any account with a setup-token can be the direct account without touching ~/.claude's login;
 * off with `directToken: null` returns to the stored login. On keeps whatever token is set (fail-open uses it).
 */
export function setNativeRouting(
  on: boolean,
  opts: { baseUrl: string; statusline?: boolean; directToken?: string | null },
): { backup: string | null; url: string | null } {
  const s = readSettings();
  if (on) {
    s.env = { ...(s.env ?? {}), ANTHROPIC_BASE_URL: opts.baseUrl };
    if (opts.statusline !== false && !s.statusLine) s.statusLine = { type: "command", command: "cm statusline" };
  } else {
    s.env = { ...(s.env ?? {}) };
    delete s.env.ANTHROPIC_BASE_URL;
    if (opts.directToken !== undefined) {
      if (opts.directToken) s.env.CLAUDE_CODE_OAUTH_TOKEN = opts.directToken;
      else delete s.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (!Object.keys(s.env).length) delete s.env;
  }
  const backup = writeSettings(s);
  return { backup, url: on ? opts.baseUrl : null };
}

/** The long-lived token new direct sessions use, if one is configured. */
export function directTokenFromSettings(): string | null {
  try {
    const t = readSettings()?.env?.CLAUDE_CODE_OAUTH_TOKEN;
    return typeof t === "string" && t ? t : null;
  } catch {
    return null;
  }
}

/** Which managed account a configured direct token belongs to (by exact match), or null for the stored login. */
export function directAccountFor(token: string | null, tokens: Record<string, string | null>): string | null {
  if (!token) return null;
  for (const [name, t] of Object.entries(tokens)) if (t && t === token) return name;
  return null;
}
