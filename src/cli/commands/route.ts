import type { Command } from "commander";
import { nativeRoutingUrl, setNativeRouting, directTokenFromSettings, directAccountFor } from "../../core/settings.js";
import { getInferenceToken } from "../../core/inference-token.js";
import { loadConfig } from "../../core/config.js";
import { daemonAlive, daemonBase } from "../client.js";
import { die } from "../common.js";
import { c } from "../render.js";

export { SETTINGS_PATH, readSettings, writeSettings } from "../../core/settings.js";
export const routeStatus = nativeRoutingUrl;

export function register(program: Command): void {
  const route = program
    .command("route")
    .description("Turn native routing on/off: whether every Claude Code session goes through the proxy (edits ~/.claude/settings.json)");
  route
    .command("status")
    .description("Show whether new Claude Code sessions use the proxy, and which account direct sessions use")
    .action(async () => {
      const url = routeStatus();
      if (url) return console.log(`on  → ${url}`);
      const tokens: Record<string, string | null> = {};
      for (const a of loadConfig().accounts) tokens[a.name] = await getInferenceToken(a.name);
      const acct = directAccountFor(directTokenFromSettings(), tokens);
      console.log(
        `off (new sessions talk to Anthropic directly as ${acct ? `account ${acct}` : "the stored ~/.claude login"}; use \`cm run -- claude\` for one-off routing)`,
      );
    });
  route
    .command("on")
    .description("Route every new Claude Code session through the proxy")
    .option("--no-statusline", "do not set the `cm statusline` status line")
    .option("--force", "enable even if the daemon is not running")
    .action(async (o) => {
      if (!o.force && !(await daemonAlive())) die("daemon is not running; start it first (cm daemon start) or pass --force");
      try {
        const { backup } = setNativeRouting(true, { baseUrl: daemonBase(), statusline: o.statusline });
        console.log(`on  → ${daemonBase()}  (new Claude Code sessions and loop iterations pick this up; running sessions keep their current route)`);
        if (backup) console.log(c.dim(`previous settings backed up to ${backup}`));
      } catch (err: any) {
        die(err.message);
      }
    });
  route
    .command("off [account]")
    .alias("direct")
    .description(
      "Send new sessions straight to Anthropic, optionally as a managed account (uses its long-lived token); no account = keep the current direct account, 'stock' = the stored ~/.claude login",
    )
    .action(async (account?: string) => {
      try {
        let directToken: string | null | undefined = undefined;
        if (account) {
          if (account === "stock") directToken = null;
          else {
            if (!loadConfig().accounts.some((a) => a.name === account)) die(`no account "${account}"`);
            const tok = await getInferenceToken(account, false);
            if (!tok) die(`${account} has no long-lived token; run: cm accounts set-token ${account}`);
            directToken = tok;
          }
        }
        const { backup } = setNativeRouting(false, { baseUrl: daemonBase(), directToken });
        console.log(
          `off (new sessions talk to Anthropic directly${account ? (account === "stock" ? " as the stored ~/.claude login" : ` as ${account}`) : ""})`,
        );
        if (backup) console.log(c.dim(`previous settings backed up to ${backup}`));
      } catch (err: any) {
        die(err.message);
      }
    });
}
