import type { Command } from "commander";
import { loadConfig, updateConfig } from "../../core/config.js";
import { api, daemonAlive } from "../client.js";
import { die } from "../common.js";
import { c, table, relTime } from "../render.js";

/** Commands for applications built on cm: advice, wait, webhooks. */
export function register(program: Command): void {
  program
    .command("advice")
    .description("What should a session do next? Session windows, pooled headroom per model, and continue / switch-model / pause")
    .option("--session <id>", "Claude Code session id (the account it is assigned to is used)")
    .option("--model <id>", "model the application is about to use")
    .option("--json")
    .action(async (o) => {
      if (!(await daemonAlive())) die("the daemon must be running (cm daemon start)");
      const q = new URLSearchParams();
      if (o.session) q.set("session", o.session);
      if (o.model) q.set("model", o.model);
      const r: any = await api(`/api/advice?${q}`);
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      const a = r.advice;
      const col = a.action === "pause" ? c.red : a.action === "switch-model" ? c.yellow : c.green;
      console.log(
        col(
          c.bold(
            a.action === "switch-model"
              ? `switch model → ${a.switchTo}`
              : a.action === "pause"
                ? `pause until ${a.pauseUntil ? relTime(a.pauseUntil) : "?"}`
                : "continue",
          ),
        ) + c.dim(`  ${a.reasons.join("; ")}`),
      );
      if (r.session.account)
        console.log(
          c.dim(
            `session ${r.session.id?.slice(0, 8) ?? ""} on ${r.session.account}: 5h ${r.session.sessionHeadroom}% left (resets ${relTime(r.session.sessionResetsAt)}), weekly ${r.session.weeklyHeadroom}% left${r.family ? `, ${r.family} ${r.session.modelHeadroom}% left` : ""}`,
          ),
        );
      console.log(
        table([
          ["pool", "headroom (account-%)", "eligible accounts", "next reset"],
          [
            "session (5h)",
            `${Math.round(r.pool.session.headroom)}%`,
            "",
            r.pool.session.nextResetAt ? `${relTime(r.pool.session.nextResetAt)} (+${Math.round(r.pool.session.nextResetFrees)}%)` : "–",
          ],
          [
            "weekly",
            `${Math.round(r.pool.weekly.headroom)}%`,
            "",
            r.pool.weekly.nextResetAt ? `${relTime(r.pool.weekly.nextResetAt)} (+${Math.round(r.pool.weekly.nextResetFrees)}%)` : "–",
          ],
          ...r.pool.families.map((f: any) => [
            f.family,
            `${Math.round(f.headroom)}%`,
            String(f.eligibleAccounts),
            f.nextResetAt ? `${relTime(f.nextResetAt)} (+${Math.round(f.nextResetFrees)}%)` : "–",
          ]),
        ]),
      );
    });

  program
    .command("wait")
    .description("Block until the pool has headroom (exit 0), or the timeout passes (exit 2). For shell loops: cm wait --model fable && claude -p ...")
    .option("--model <id>", "model family to wait for (default: the session pool)")
    .option("--min-headroom <n>", "pooled account-% required", "15")
    .option("--timeout <seconds>", "give up after this long", "3600")
    .option("--quiet")
    .action(async (o) => {
      if (!(await daemonAlive())) die("the daemon must be running (cm daemon start)");
      const deadline = Date.now() + Number(o.timeout) * 1000;
      for (;;) {
        const remaining = Math.max(1, Math.round((deadline - Date.now()) / 1000));
        const q = new URLSearchParams({ "min-headroom": String(o.minHeadroom), timeout: String(Math.min(remaining, 600)) });
        if (o.model) q.set("model", o.model);
        const r: any = await api(`/api/wait?${q}`);
        if (r.satisfied) {
          if (!o.quiet) console.log(`ok: ${Math.round(r.headroom)}% pooled headroom${o.model ? ` for ${o.model}` : ""}`);
          process.exit(0);
        }
        if (Date.now() >= deadline) {
          if (!o.quiet)
            console.error(
              `timeout: ${Math.round(r.headroom)}% pooled headroom${r.advice?.pool?.families?.[0]?.nextResetAt ? `, next reset ${relTime(r.advice.advice.pauseUntil ?? r.advice.pool.session.nextResetAt)}` : ""}`,
            );
          process.exit(2);
        }
      }
    });

  const wh = program.command("webhooks").description("Deliver limit, reset, routing and account events to HTTP endpoints");
  wh.command("list").action(() => {
    const cfg = loadConfig();
    if (!cfg.webhooks.length) return console.log(c.dim("no webhooks. add one: cm webhooks add <url> [--events limit.*,pool.dry] [--secret s]"));
    console.log(
      table([["url", "events", "signed"], ...cfg.webhooks.map((w) => [w.url, w.events.length ? w.events.join(",") : "all", w.secret ? "yes" : "no"])]),
    );
  });
  wh.command("add <url>")
    .option("--events <list>", "comma-separated names or prefixes (limit.*, pool.dry, routing.switch, routing.fallback, model.fallback, account.needs_login)")
    .option("--secret <secret>", "HMAC-SHA256 secret for x-cm-signature")
    .action(async (url: string, o) => {
      try {
        new URL(url);
      } catch {
        die("not a valid URL");
      }
      updateConfig((cfg) => {
        cfg.webhooks = cfg.webhooks.filter((w) => w.url !== url);
        cfg.webhooks.push({
          url,
          events: o.events
            ? String(o.events)
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean)
            : [],
          secret: o.secret,
        });
      });
      if (await daemonAlive()) await api("/api/reload", { method: "POST" });
      console.log(`added ${url}`);
    });
  wh.command("remove <url>").action(async (url: string) => {
    updateConfig((cfg) => {
      cfg.webhooks = cfg.webhooks.filter((w) => w.url !== url);
    });
    if (await daemonAlive()) await api("/api/reload", { method: "POST" });
    console.log(`removed ${url}`);
  });
  wh.command("test <url>")
    .description("Send a signed ping event to a URL")
    .option("--secret <secret>")
    .action(async (url: string, o) => {
      if (!(await daemonAlive())) die("the daemon must be running (cm daemon start)");
      const r: any = await api("/api/webhooks/test", { method: "POST", body: { url, secret: o.secret } });
      console.log(r.delivered ? `${c.green("✓")} delivered (HTTP ${r.status})` : `${c.red("✗")} not delivered${r.status ? ` (HTTP ${r.status})` : ""}`);
    });
}
