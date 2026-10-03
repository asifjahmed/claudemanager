import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { UPSTREAM_DEFAULT } from "./claude-internals.js";

export const CM_HOME = process.env.CLAUDEMANAGER_HOME || join(homedir(), ".claudemanager");
export const CONFIG_PATH = join(CM_HOME, "config.json");
export const ACCOUNTS_DIR = join(CM_HOME, "accounts");
export const DAEMON_INFO_PATH = join(CM_HOME, "daemon.json");
export const DAEMON_LOG_PATH = join(CM_HOME, "daemon.log");
export const DB_PATH = join(CM_HOME, "claudemanager.db");

const AccountSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  configDir: z.string(),
  email: z.string().optional(),
  orgName: z.string().optional(),
  subscriptionType: z.string().optional(),
  disabled: z.boolean().optional(),
});

const PriceSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheWrite: z.number(),
  cacheRead: z.number(),
});

export const ConfigSchema = z.object({
  port: z.number().int().positive().default(4141),
  /** switch away from an account when its 5-hour window reaches this percent (50–100) */
  threshold: z.number().min(50).max(100).default(90),
  /** treat an account as over its weekly / per-model weekly window at this percent (50–100) */
  weeklyThreshold: z.number().min(50).max(100).default(97),
  pollIntervalSec: z.number().positive().default(150),
  activePollIntervalSec: z.number().positive().default(150),
  accounts: z.array(AccountSchema).default([]),
  pinned: z.string().nullable().default(null),
  /** rank eligible accounts by soonest weekly reset first, so quota about to expire is spent before quota that keeps */
  preferSoonerReset: z.boolean().default(true),
  /** proactively switch (at most every 30 min) to an eligible account whose weekly window resets within this many hours */
  perishableHours: z.number().min(0).default(24),
  /** model-aware allocation: route models that only use the shared windows (Sonnet, Opus, Haiku) to accounts whose scarce per-model windows (e.g. Fable) are most spent, preserving that headroom elsewhere */
  modelAwareAllocation: z.boolean().default(true),
  /** existing sessions are moved off an account only when its 5-hour window reaches this (null = threshold + 10); new sessions stop landing there at `threshold` */
  ejectThreshold: z.number().min(50).max(100).nullable().default(null),
  /** at most this many session moves per minute across the pool, plus 2% of active sessions; exhaustion and auth moves are exempt */
  maxMovesPerMinute: z.number().min(0).default(10),
  /** concurrent upstream connections (streams) the proxy may hold open */
  upstreamConnections: z.number().int().min(16).default(1024),
  /** distribute: assign each new session to a random within-threshold account instead of the ranked first (spreads load; ignores soonest-reset and model-aware ranking) */
  distribute: z.boolean().default(false),
  upstream: z.string().url().default(UPSTREAM_DEFAULT),
  retryOn429: z.boolean().default(true),
  maxBodyBytes: z
    .number()
    .int()
    .positive()
    .default(32 * 1024 * 1024),
  log: z
    .object({
      retentionDays: z.number().min(0).default(30),
      bodies: z.enum(["full", "lastTurn", "none"]).default("full"),
      maxDbMb: z.number().positive().default(2048),
    })
    .prefault({}),
  /** For applications built on cm: advice thresholds, model fallback, webhooks. */
  advice: z
    .object({
      /** pooled account-% below which a model family is "almost gone" (advice: switch-model, event: limit.approaching) */
      approachingHeadroom: z.number().min(0).max(500).default(15),
    })
    .prefault({}),
  /** Promotions: definitions come from the bundled offers.json, a daily feed, and `local`; state lives in `used`. */
  offers: z
    .object({
      /** feed of offer definitions checked daily; null disables the network fetch */
      feedUrl: z.string().url().nullable().default("https://raw.githubusercontent.com/asifjahmed/claudemanager/main/offers.json"),
      refreshHours: z.number().positive().default(24),
      /** extra or overriding definitions (same shape as offers.json entries) */
      local: z.array(z.any()).default([]),
      /** offer ids to ignore */
      disabled: z.array(z.string()).default([]),
      /** free-reset planning: route new sessions to one unused account at a time so it fills early */
      concentrate: z.boolean().default(true),
      /** recommend "reset now" when the binding weekly window is at least this full … */
      minUtil: z.number().min(50).max(100).default(85),
      /** … and at least this many hours remain before its natural reset */
      minHoursBeforeNaturalReset: z.number().min(0).default(48),
      /** offer id → account → ISO times used (detected automatically or marked by hand) */
      used: z.record(z.string(), z.record(z.string(), z.array(z.string()))).default({}),
    })
    .prefault({}),
  /** rewrite the model when the requested family has no pooled headroom left, e.g. {"fable": "claude-opus-5"}; empty = off */
  modelFallback: z.record(z.string(), z.string()).default({}),
  /** pooled account-% at or below which the fallback applies (0 = only when nothing is left) */
  modelFallbackHeadroom: z.number().min(0).max(500).default(0),
  webhooks: z
    .array(
      z.object({
        url: z.string().url(),
        /** event names to deliver; empty = all */
        events: z.array(z.string()).default([]),
        /** HMAC-SHA256 secret for the x-cm-signature header */
        secret: z.string().optional(),
      }),
    )
    .default([]),
  /** USD per million tokens, keyed by model family substring. */
  prices: z.record(z.string(), PriceSchema).default({
    fable: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
    opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function ensureHome(): void {
  mkdirSync(CM_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
}

export class ConfigError extends Error {}

/** In-place upgrades of older config files. */
export function migrateConfig(raw: any): void {
  if (!raw || typeof raw !== "object") return;
  // 0.1 pre-release: freeReset.{used: {account: iso}} → offers.used[offer][account] = [iso]
  if (raw.freeReset && typeof raw.freeReset === "object") {
    const fr = raw.freeReset;
    raw.offers ??= {};
    const id = "anthropic-free-session-reset-2026-10";
    if (fr.used && typeof fr.used === "object") {
      raw.offers.used ??= {};
      raw.offers.used[id] ??= {};
      for (const [acct, iso] of Object.entries(fr.used)) if (typeof iso === "string") raw.offers.used[id][acct] = [iso];
    }
    for (const k of ["concentrate", "minUtil", "minHoursBeforeNaturalReset"]) if (fr[k] !== undefined && raw.offers[k] === undefined) raw.offers[k] = fr[k];
    if (fr.enabled === false) {
      raw.offers.disabled ??= [];
      if (!raw.offers.disabled.includes(id)) raw.offers.disabled.push(id);
    }
    delete raw.freeReset;
  }
}

export function loadConfig(): Config {
  ensureHome();
  if (!existsSync(CONFIG_PATH)) {
    const cfg = ConfigSchema.parse({});
    saveConfig(cfg);
    return cfg;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err: any) {
    throw new ConfigError(`${CONFIG_PATH} is not valid JSON (${err.message}). Fix it or move it aside to start fresh.`);
  }
  migrateConfig(raw);
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`${CONFIG_PATH} has invalid values:\n${issues}`);
  }
  return parsed.data;
}

/** The routing policy the router and the API both need, built in one place. */
export function policyFromConfig(
  cfg: Config,
  drainAccount: string | null = null,
): {
  threshold: number;
  weeklyThreshold: number;
  pinned: string | null;
  preferSoonerReset: boolean;
  perishableHours: number;
  modelAware: boolean;
  drainAccount: string | null;
  distribute: boolean;
  ejectThreshold: number;
} {
  return {
    threshold: cfg.threshold,
    weeklyThreshold: cfg.weeklyThreshold,
    pinned: cfg.pinned,
    preferSoonerReset: cfg.preferSoonerReset,
    perishableHours: cfg.perishableHours,
    modelAware: cfg.modelAwareAllocation,
    drainAccount,
    distribute: cfg.distribute,
    ejectThreshold: cfg.ejectThreshold ?? Math.min(100, cfg.threshold + 10),
  };
}

/** Top-level and nested keys `cm config set` accepts. */
export function knownConfigKeys(): string[] {
  const shape = ConfigSchema.shape as Record<string, any>;
  const out: string[] = [];
  for (const [k, v] of Object.entries(shape)) {
    out.push(k);
    const inner = v?.def?.innerType?.shape ?? v?.shape;
    if (inner && typeof inner === "object") for (const sub of Object.keys(inner)) out.push(`${k}.${sub}`);
  }
  return out;
}

export function saveConfig(cfg: Config): void {
  ensureHome();
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

export function updateConfig(mutate: (cfg: Config) => void): Config {
  const cfg = loadConfig();
  mutate(cfg);
  const parsed = ConfigSchema.parse(cfg);
  saveConfig(parsed);
  return parsed;
}

/** Set a dotted key from a string value (CLI `cm config set`). */
export function setConfigValue(cfg: Config, key: string, value: string): void {
  const parts = key.split(".");
  const known = knownConfigKeys();
  if (!known.includes(key) && !known.includes(parts[0])) {
    throw new ConfigError(`unknown config key "${key}". Known keys: ${known.join(", ")}`);
  }
  let obj: any = cfg;
  for (const p of parts.slice(0, -1)) {
    if (obj[p] === undefined || typeof obj[p] !== "object") obj[p] = {};
    obj = obj[p];
  }
  const last = parts[parts.length - 1];
  let v: unknown = value;
  if (value === "null") v = null;
  else if (value === "true") v = true;
  else if (value === "false") v = false;
  else if (value !== "" && !Number.isNaN(Number(value))) v = Number(value);
  obj[last] = v;
}

export function getConfigValue(cfg: Config, key: string): unknown {
  return key.split(".").reduce<any>((o, p) => (o == null ? undefined : o[p]), cfg);
}

/** test hook */
export const migrateForTest = migrateConfig;
