import type { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { DAEMON_INFO_PATH, DAEMON_LOG_PATH } from "../../core/config.js";
import { api, daemonAlive, daemonBase, readDaemonInfo } from "../client.js";
import { daemonEntry, die, ensureDaemon, waitAlive } from "../common.js";
import { c, relMs } from "../render.js";
import { service } from "../service/index.js";

export function register(program: Command): void {
  const daemon = program.command("daemon").description("Manage the background daemon");
  const svc = service();

  daemon
    .command("start")
    .description("Start the daemon in the background")
    .action(async () => {
      if (await daemonAlive()) return console.log(`already running on ${daemonBase()}`);
      await ensureDaemon();
      console.log(`running on ${daemonBase()}  ·  web UI: ${daemonBase()}/`);
    });

  daemon
    .command("run")
    .description("Run the daemon in the foreground (logs to the terminal)")
    .action(async () => {
      const { cmd, args } = daemonEntry();
      const child = spawn(cmd, args, { stdio: "inherit" });
      child.on("error", (err) => die(`could not start the daemon: ${err.message}`));
      child.on("exit", (code) => process.exit(code ?? 0));
    });

  daemon
    .command("stop")
    .description("Stop the daemon (also stops the service so it stays stopped)")
    .action(async () => {
      if (svc?.installed()) {
        svc.stop();
        await waitAlive(false);
        console.log(`stopped (${svc.name} service stopped; \`cm daemon start\` starts it again)`);
        return;
      }
      const info = readDaemonInfo();
      if (!info) return console.log("not running");
      try {
        process.kill(info.pid, "SIGTERM");
        await waitAlive(false, 5000);
        console.log(`stopped pid ${info.pid}`);
      } catch (err: any) {
        console.log(`could not signal pid ${info.pid}: ${err.message}`);
        if (existsSync(DAEMON_INFO_PATH)) unlinkSync(DAEMON_INFO_PATH);
      }
    });

  daemon
    .command("restart")
    .description("Restart the daemon (picks up a rebuilt dist/)")
    .action(async () => {
      if (svc?.installed()) {
        svc.restart();
        if (!(await waitAlive(true))) die(`daemon did not come back; see ${DAEMON_LOG_PATH}`);
        console.log(`restarted via ${svc.name} on ${daemonBase()}`);
        return;
      }
      const info = readDaemonInfo();
      if (info) {
        try {
          process.kill(info.pid, "SIGTERM");
        } catch {
          /* ignore */
        }
        await waitAlive(false, 5000);
      }
      await ensureDaemon();
      console.log(`running on ${daemonBase()}`);
    });

  daemon
    .command("status")
    .description("Show daemon status and proxy performance")
    .action(async () => {
      const info = await daemonAlive();
      if (!info) return console.log(c.yellow("daemon not running") + c.dim("  (cm daemon start)"));
      const s = await api("/api/state");
      const managed = svc?.installed() ? svc.statusHint() : "manual (no service installed; `cm daemon install-service` keeps it running)";
      console.log(
        `running  pid ${info.pid}  ${daemonBase()}  v${s.version}  up ${relMs(s.startedAt).replace(" ago", "")}  active: ${s.current ?? "–"}  requests logged: ${s.db?.requests ?? "n/a"}`,
      );
      console.log(c.dim(managed));
      if (s.perf) {
        const p = s.perf.lastMinute ?? s.perf.current;
        console.log(
          c.dim(
            `perf (${s.perf.lastMinute ? "last minute" : `last ${s.perf.current.windowSec}s`}): event-loop lag p50 ${p.loopP50Ms}ms p99 ${p.loopP99Ms}ms max ${p.loopMaxMs}ms · proxy overhead p50 ${p.overheadP50Ms ?? "–"}ms p99 ${p.overheadP99Ms ?? "–"}ms · upstream first byte p50 ${p.ttfbP50Ms ?? "–"}ms · ${p.requests} req · db writer: ${s.writerMode ?? "off"}`,
          ),
        );
      }
    });

  daemon
    .command("logs")
    .description("Tail the daemon log")
    .option("-n <lines>", "lines", "50")
    .action((o) => {
      if (!existsSync(DAEMON_LOG_PATH)) return console.log("no log yet");
      const lines = readFileSync(DAEMON_LOG_PATH, "utf8").trimEnd().split("\n");
      console.log(lines.slice(-Number(o.n)).join("\n"));
    });

  daemon
    .command("install-service")
    .alias("install-launchd")
    .description("Install a user service (launchd on macOS, systemd on Linux) so the daemon starts at login and stays up")
    .action(() => {
      if (!svc) die(`no service manager support on ${process.platform}; run \`cm daemon start\` after login instead`);
      for (const line of svc.install()) console.log(line);
    });

  daemon
    .command("uninstall-service")
    .alias("uninstall-launchd")
    .description("Remove the user service")
    .action(() => {
      if (!svc) return console.log("nothing installed");
      for (const line of svc.uninstall()) console.log(line);
    });
}
