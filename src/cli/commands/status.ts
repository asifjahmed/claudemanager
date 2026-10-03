import type { Command } from "commander";
import { subscribe } from "../client.js";
import { getState, renderStatus, renderEvents } from "../status.js";
import { c, table, fmtTokens } from "../render.js";
import { die, ensureDaemon } from "../common.js";

export function register(program: Command): void {
  program
    .command("status")
    .description("Show every account's session/weekly usage and reset times")
    .option("--json", "machine-readable output")
    .option("--direct", "poll accounts directly even if the daemon is running")
    .action(async (o) => {
      const s = await getState({ direct: o.direct });
      if (o.json) return console.log(JSON.stringify(s, null, 2));
      console.log(renderStatus(s));
      if (s.events?.length) console.log("\n" + renderEvents(s.events, 5));
    });

  program
    .command("watch")
    .description("Live-updating status view (needs the daemon)")
    .action(async () => {
      await ensureDaemon();
      let state: any = null;
      const requests: any[] = [];
      const draw = () => {
        if (!state) return;
        const lines = [
          c.bold(`claudemanager  ${new Date().toLocaleTimeString()}`),
          "",
          renderStatus(state),
          "",
          c.bold("events"),
          renderEvents(state.events ?? [], 6),
        ];
        if (requests.length) {
          lines.push("", c.bold("recent requests"));
          lines.push(
            table([
              ["time", "account", "model", "in", "out", "cache", "ms", "status"],
              ...requests
                .slice(-6)
                .map((r) => [
                  new Date(r.finishedAt ?? r.startedAt).toLocaleTimeString(),
                  r.account ?? "–",
                  (r.model ?? "–").replace("claude-", ""),
                  fmtTokens(r.inputTokens),
                  fmtTokens(r.outputTokens),
                  fmtTokens(r.cacheReadTokens),
                  String(r.latencyMs ?? "–"),
                  r.error ? c.red(String(r.statusCode ?? "err")) : String(r.statusCode ?? "–"),
                ]),
            ]),
          );
        }
        process.stdout.write("\x1b[H\x1b[2J" + lines.join("\n") + "\n" + c.dim("\nctrl-c to exit"));
      };
      const stop = subscribe(
        (name, data) => {
          if (name === "state") state = { ...data, daemon: true };
          if (name === "request") requests.push(data);
          draw();
        },
        (err) => die(`connection to daemon closed${err ? `: ${err.message}` : ""}`),
      );
      const t = setInterval(draw, 1000);
      process.on("SIGINT", () => {
        clearInterval(t);
        stop();
        process.stdout.write("\n");
        process.exit(0);
      });
    });
}
