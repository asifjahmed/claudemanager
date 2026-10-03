import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CM_HOME, DB_PATH, loadConfig } from "../../core/config.js";
import { readCredentials, getFreshToken, CredentialError } from "../../core/credentials.js";
import { getInferenceToken } from "../../core/inference-token.js";
import { fetchUsage } from "../../core/usage.js";
import { keychainService, VERIFIED_CLAUDE_CODE_VERSION, USAGE_URL, OAUTH_TOKEN_URL } from "../../core/claude-internals.js";
import { Db } from "../../core/db.js";
import { api, daemonAlive, daemonBase } from "../client.js";
import { c, relMs } from "../render.js";
import { claudeVersion } from "../common.js";
import { routeStatus } from "./route.js";
import { service } from "../service/index.js";

export function register(program: Command): void {
  program
    .command("doctor")
    .description("Check every assumption about Claude Code internals and report which one broke")
    .action(async () => {
      const ok = (s: string) => console.log(`${c.green("✓")} ${s}`);
      const bad = (s: string) => console.log(`${c.red("✗")} ${s}`);
      const warn = (s: string) => console.log(`${c.yellow("!")} ${s}`);
      ok(`claudemanager on ${process.platform} ${process.arch}, node ${process.version}`);
      const ver = claudeVersion();
      if (!ver) bad("claude CLI not found on PATH (install Claude Code first)");
      else if (ver === VERIFIED_CLAUDE_CODE_VERSION) ok(`claude ${ver} (verified version)`);
      else warn(`claude ${ver} — internals verified against ${VERIFIED_CLAUDE_CODE_VERSION}; watch for breakage below`);
      if (process.env.ANTHROPIC_BASE_URL) warn(`ANTHROPIC_BASE_URL is set in this shell to ${process.env.ANTHROPIC_BASE_URL}`);
      const cfg = loadConfig();
      ok(`config ${join(CM_HOME, "config.json")}: ${cfg.accounts.length} account(s), threshold ${cfg.threshold}%/${cfg.weeklyThreshold}%`);
      const info = await daemonAlive();
      if (info) {
        ok(`daemon running pid ${info.pid} on ${daemonBase()}`);
        try {
          const st = await api("/api/state");
          ok(
            `request log: ${st.db ? `${st.db.requests} requests, ${st.db.sizeMb} MB file (${st.db.liveMb} MB live)` : "disabled"} · writer: ${st.writerMode ?? "off"} · bodies: ${st.log?.bodies}`,
          );
          if (String(st.writerMode).includes("crashed")) warn("the DB worker crashed; recording is running on the main thread — cm daemon restart");
        } catch (err: any) {
          warn(`daemon state unavailable: ${err.message}`);
        }
      } else warn("daemon not running (cm daemon start)");
      const svc = service();
      if (svc)
        (svc.installed() ? ok : warn)(
          svc.installed() ? `service: ${svc.statusHint()}` : `no ${svc.name} service installed (cm daemon install-service keeps the daemon running)`,
        );
      const url = routeStatus();
      if (url) ok(`native routing on: ~/.claude/settings.json → ${url}`);
      else warn("native routing is off (~/.claude/settings.json has no env.ANTHROPIC_BASE_URL) — `cm route on`, or `cm run -- claude` for one session");
      try {
        const lines = readFileSync(join(CM_HOME, "daemon.log"), "utf8").trimEnd().split("\n");
        const errs = lines.filter((l) => /WARNING|error|failed|crash/i.test(l)).slice(-3);
        if (errs.length) warn(`recent daemon log problems:\n    ${errs.map((l) => l.slice(0, 160)).join("\n    ")}`);
      } catch {
        /* no log yet */
      }
      if (existsSync(DB_PATH)) {
        try {
          const db = new Db(DB_PATH);
          ok(`database ${DB_PATH}: ${db.counts().requests} requests, ${db.counts().sizeMb} MB`);
          db.close();
        } catch (err: any) {
          bad(`database open failed: ${err.message}`);
        }
      }
      if (!cfg.accounts.length) warn("no accounts registered — cm accounts add <name>");
      for (const a of cfg.accounts) {
        const svc = keychainService(a.configDir);
        let read;
        try {
          read = await readCredentials(a.configDir);
        } catch (err: any) {
          bad(`${a.name}: credential read failed (${svc}): ${err.message}`);
          continue;
        }
        if (!read) {
          bad(`${a.name}: no credentials in keychain "${svc}" or ${a.configDir}/.credentials.json`);
          continue;
        }
        ok(
          `${a.name}: credentials from ${read.from} (${svc}), token ${read.creds.expiresAt > Date.now() ? "valid " + relMs(read.creds.expiresAt) : "EXPIRED " + relMs(read.creds.expiresAt)}, refresh token ${read.creds.refreshToken ? "present" : "MISSING"}`,
        );
        if (await getInferenceToken(a.name, false)) ok(`${a.name}: long-lived inference token stored (traffic does not depend on refresh)`);
        try {
          const fresh = await getFreshToken(a.configDir);
          if (fresh.accessToken !== read.creds.accessToken) ok(`${a.name}: token refreshed via ${OAUTH_TOKEN_URL} and written back`);
          const { usage, raw } = await fetchUsage(fresh.accessToken);
          const keys = Object.keys(raw as object);
          ok(
            `${a.name}: ${USAGE_URL} → 5h ${usage.fiveHour.utilization ?? "?"}% 7d ${usage.sevenDay.utilization ?? "?"}% models [${Object.keys(usage.models).join(", ") || "none"}] (raw keys: ${keys.join(", ")})`,
          );
          if (usage.fiveHour.utilization === null) warn(`${a.name}: five_hour.utilization missing — response shape may have changed`);
        } catch (err: any) {
          if (err instanceof CredentialError && err.needsLogin) bad(`${a.name}: ${err.message} → run: cm accounts login ${a.name}`);
          else bad(`${a.name}: ${err.message}`);
        }
      }
    });
}
