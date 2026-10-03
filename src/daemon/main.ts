import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { createDaemon, VERSION } from "./server.js";
import { DAEMON_INFO_PATH, ensureHome } from "../core/config.js";

async function main(): Promise<void> {
  ensureHome();
  const d = createDaemon();
  const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
  const port = await d.listen();
  writeFileSync(DAEMON_INFO_PATH, JSON.stringify({ pid: process.pid, port, startedAt: Date.now(), version: VERSION }, null, 2), { mode: 0o600 });
  log(`claudemanager daemon ${VERSION} listening on http://127.0.0.1:${port} (pid ${process.pid})`);
  log(
    `accounts: ${
      d
        .config()
        .accounts.map((a) => a.name)
        .join(", ") || "(none — run `cm accounts add <name>`)"
    }`,
  );
  d.poller.start();

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    log(`received ${sig}, shutting down`);
    const hard = setTimeout(() => {
      log("shutdown timed out; exiting");
      process.exit(0);
    }, 3000);
    hard.unref();
    try {
      await d.close();
    } finally {
      if (existsSync(DAEMON_INFO_PATH)) {
        try {
          const info = JSON.parse(readFileSync(DAEMON_INFO_PATH, "utf8"));
          if (info.pid === process.pid) unlinkSync(DAEMON_INFO_PATH);
        } catch {
          /* ignore */
        }
      }
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => {
    log("SIGHUP: reloading config");
    d.reload();
  });
  process.on("uncaughtException", (err) => log(`uncaughtException: ${err.stack ?? err}`));
  process.on("unhandledRejection", (err: any) => log(`unhandledRejection: ${err?.stack ?? err}`));
}

main().catch((err) => {
  process.stderr.write(`daemon failed to start: ${err?.message ?? err}\n`);
  // under launchd/systemd KeepAlive an immediate exit would hot-loop; give the operator a chance to read the log
  setTimeout(() => process.exit(1), 5000);
});
