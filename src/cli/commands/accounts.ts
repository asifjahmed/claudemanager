import type { Command } from "commander";
import { loginAccount, renameAccount, setupToken, storeToken } from "../../core/account-ops.js";
import { deleteInferenceToken } from "../../core/inference-token.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { ensureHome, loadConfig, updateConfig } from "../../core/config.js";
import { api, daemonAlive } from "../client.js";
import { getState, renderStatus } from "../status.js";
import { c, table } from "../render.js";
import { die, requireClaudeCli } from "../common.js";

export function register(program: Command): void {
  const accounts = program.command("accounts").description("Manage Claude Max accounts");

  accounts
    .command("add <name>")
    .description("Log a Claude account in under its own config dir and register it")
    .option("--config-dir <dir>", "use an existing Claude config dir (e.g. ~/.claude) instead of logging in")
    .option("--email <email>", "pre-fill the login email")
    .option("--force", "register even if another account has the same email")
    .action(async (name: string, o) => {
      ensureHome();
      if (!o.configDir) requireClaudeCli();
      if (loadConfig().accounts.some((a) => a.name === name)) die(`account "${name}" already exists`);
      const configDir = o.configDir ? resolve(String(o.configDir).replace(/^~/, homedir())) : undefined;
      if (!configDir) process.stderr.write(`Logging in (a browser window will open)...\n`);
      try {
        const r = await loginAccount(name, { email: o.email, configDir, force: o.force, interactive: true });
        console.log(`${c.green("✓")} added ${c.bold(name)} (${r.email ?? "?"}, ${r.subscriptionType ?? "?"})`);
      } catch (err: any) {
        die(err.message);
      }
      if (await daemonAlive()) await api("/api/reload", { method: "POST" });
    });

  accounts
    .command("login <name>")
    .description("Log an existing account in again (fixes 'needs re-login' after its refresh token died)")
    .action(async (name: string) => {
      const acct = loadConfig().accounts.find((a) => a.name === name);
      if (!acct) die(`no account "${name}"`);
      requireClaudeCli();
      process.stderr.write(`Re-login for ${c.bold(name)}${acct.email ? ` — sign in as ${c.bold(acct.email)}` : ""} (a browser window will open)...\n`);
      try {
        const r = await loginAccount(name, { email: acct.email, interactive: true });
        console.log(`${c.green("✓")} ${name} logged in as ${r.email ?? "?"}`);
      } catch (err: any) {
        die(err.message);
      }
      if (await daemonAlive()) {
        await api("/api/reload", { method: "POST" });
        console.log(c.dim("daemon notified"));
      }
    });

  accounts
    .command("rename <name> <new-name>")
    .description("Rename an account (its alias); the login and tokens stay")
    .action(async (name: string, newName: string) => {
      try {
        await renameAccount(name, newName);
      } catch (err: any) {
        die(err.message);
      }
      if (await daemonAlive())
        await api(`/api/accounts/${encodeURIComponent(name)}/rename`, { method: "POST", body: { name: newName } }).catch(() =>
          api("/api/reload", { method: "POST" }),
        );
      console.log(`renamed ${name} → ${newName}`);
    });

  accounts
    .command("set-token <name>")
    .description("Store a long-lived `claude setup-token` token for the traffic path (no refresh, immune to sleep/network hiccups)")
    .option("--no-run", "do not launch `claude setup-token`; just prompt for a token you already have")
    .action(async (name: string, o) => {
      if (!loadConfig().accounts.some((a) => a.name === name)) die(`no account "${name}"`);
      let where: "keychain" | "file";
      if (o.run) {
        requireClaudeCli();
        process.stderr.write(`Launching \`claude setup-token\` — sign in as this account in the browser; the token it prints is captured automatically.\n`);
        try {
          where = (await setupToken(name, { onOutput: (t) => process.stderr.write(t) })).where;
        } catch (err: any) {
          die(err.message);
        }
      } else {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const token = (await new Promise<string>((res) => rl.question("paste token: ", res))).trim();
        rl.close();
        if (!token) die("no token given");
        where = (await storeToken(name, token)).where;
      }
      console.log(`${c.green("✓")} stored long-lived token for ${name} (${where}). The proxy will use it for requests.`);
      console.log(c.dim(`  It cannot read usage (no user:profile scope), so keep the normal login too for the weekly and per-model numbers.`));
      if (await daemonAlive()) await api("/api/reload", { method: "POST" });
    });

  accounts
    .command("clear-token <name>")
    .description("Remove the stored long-lived token; the proxy goes back to the refreshable login")
    .action(async (name: string) => {
      console.log((await deleteInferenceToken(name)) ? `removed long-lived token for ${name}` : `no long-lived token stored for ${name}`);
      if (await daemonAlive()) await api("/api/reload", { method: "POST" });
    });

  accounts
    .command("list")
    .description("List registered accounts")
    .action(() => {
      const cfg = loadConfig();
      if (!cfg.accounts.length) return console.log(c.dim("no accounts. run: cm accounts add <name>"));
      console.log(
        table([
          ["name", "email", "plan", "config dir", "flags"],
          ...cfg.accounts.map((a) => [
            a.name,
            a.email ?? "–",
            a.subscriptionType ?? "–",
            a.configDir,
            [a.disabled ? "disabled" : "", cfg.pinned === a.name ? "pinned" : ""].filter(Boolean).join(","),
          ]),
        ]),
      );
    });

  accounts
    .command("remove <name>")
    .description("Unregister an account (does not log it out)")
    .action(async (name: string) => {
      const cfg = updateConfig((cfg) => {
        if (!cfg.accounts.some((a) => a.name === name)) die(`no account "${name}"`);
        cfg.accounts = cfg.accounts.filter((a) => a.name !== name);
        if (cfg.pinned === name) cfg.pinned = null;
      });
      console.log(`removed ${name}. ${cfg.accounts.length} account(s) remain. To log it out: CLAUDE_CONFIG_DIR=<dir> claude auth logout`);
      if (await daemonAlive()) await api("/api/reload", { method: "POST" });
    });

  for (const verb of ["enable", "disable"] as const) {
    accounts
      .command(`${verb} <name>`)
      .description(`${verb} routing to an account`)
      .action(async (name: string) => {
        updateConfig((cfg) => {
          const a = cfg.accounts.find((x) => x.name === name);
          if (!a) die(`no account "${name}"`);
          a.disabled = verb === "disable";
        });
        if (await daemonAlive()) await api("/api/reload", { method: "POST" });
        console.log(`${name} ${verb}d`);
      });
  }

  accounts
    .command("refresh")
    .description("Force a usage poll (and token refresh if needed) for all accounts")
    .action(async () => {
      if (await daemonAlive()) {
        const s = await api("/api/refresh", { method: "POST" });
        console.log(renderStatus({ ...s, daemon: true }));
      } else {
        console.log(renderStatus(await getState({ direct: true })));
      }
    });

  program
    .command("pin <name>")
    .description("Force all traffic to one account (until unpinned or it becomes ineligible)")
    .action(async (name: string) => {
      const cfg = loadConfig();
      if (!cfg.accounts.some((a) => a.name === name)) die(`no account "${name}"`);
      if (await daemonAlive()) await api(`/api/accounts/${encodeURIComponent(name)}/pin`, { method: "POST" });
      else updateConfig((c2) => void (c2.pinned = name));
      console.log(`pinned ${name}`);
    });
  program
    .command("unpin")
    .description("Return to automatic routing")
    .action(async () => {
      if (await daemonAlive()) await api("/api/unpin", { method: "POST" });
      else updateConfig((c2) => void (c2.pinned = null));
      console.log("unpinned");
    });
}
