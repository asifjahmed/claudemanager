import type { Command } from "commander";
import { spawn } from "node:child_process";
import { daemonBase } from "../client.js";
import { die, ensureDaemon, openBrowser } from "../common.js";

export function register(program: Command): void {
  program
    .command("run")
    .description("Run claude (or any command) through the proxy: cm run -- claude -p 'hi'")
    .allowUnknownOption()
    .argument("[args...]")
    .action(async (args: string[]) => {
      await ensureDaemon();
      const cmd = args.length ? args : ["claude"];
      const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: { ...process.env, ANTHROPIC_BASE_URL: daemonBase() } });
      child.on("error", (err: NodeJS.ErrnoException) =>
        die(err.code === "ENOENT" ? `command not found: ${cmd[0]}${cmd[0] === "claude" ? " (install Claude Code first)" : ""}` : err.message),
      );
      child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
    });

  program
    .command("env")
    .description("Print the export needed to route a shell's claude sessions through the proxy")
    .action(() => console.log(`export ANTHROPIC_BASE_URL=${daemonBase()}`));

  program
    .command("web")
    .description("Open the web dashboard")
    .action(async () => {
      await ensureDaemon();
      openBrowser(`${daemonBase()}/`);
      console.log(`${daemonBase()}/`);
    });
}
