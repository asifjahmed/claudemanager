import type { Command } from "commander";
import { loadConfig, updateConfig } from "../../core/config.js";
import { api, daemonAlive } from "../client.js";
import { die } from "../common.js";
import { c, table, relTime } from "../render.js";

/** Promotions such as Anthropic's free session reset: definitions from offers.json / the feed, plans per account. */
export function register(program: Command): void {
  const offers = program
    .command("offers")
    .alias("free-reset")
    .description("Promotions (e.g. a free session reset per account): what is active and when to use each one for the most extra quota");

  offers
    .command("plan", { isDefault: true })
    .description("Show every active offer's recommendation per account")
    .option("--json")
    .action(async (o) => {
      if (!(await daemonAlive())) die("the daemon must be running (cm daemon start)");
      const r: any = await api("/api/offers");
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      if (!r.active.length) {
        console.log(
          c.dim(
            `no active offers${r.all.length ? ` (${r.all.length} known: ${r.all.map((x: any) => x.id).join(", ")})` : ""}${r.lastFeedError ? ` · feed: ${r.lastFeedError}` : ""}`,
          ),
        );
        return;
      }
      for (const x of r.active) {
        const p = x.plan;
        console.log(
          c.bold(x.title) +
            c.dim(
              `  [${x.id}] · until ${x.deadline.slice(0, 10)} · ${p.summary} · concentrate ${p.concentrate ? "on" + (p.drainTarget ? ` (filling ${p.drainTarget})` : "") : "off"}`,
            ),
        );
        if (x.description) console.log(c.dim(x.description));
        console.log(
          table([
            ["account", "status", "window", "now", "natural reset", "gain now", "best moment", "gain then", "why"],
            ...p.plans.map((q: any) => [
              q.account,
              q.status === "reset-now"
                ? c.magenta(c.bold("RESET NOW"))
                : q.status === "used"
                  ? c.green("used")
                  : q.status === "scheduled"
                    ? c.cyan("scheduled")
                    : c.dim(q.status),
              q.bindingWindow,
              q.weeklyUtil == null ? "–" : `${Math.round(q.weeklyUtil)}%`,
              q.weeklyResetsAt ? relTime(q.weeklyResetsAt) : "–",
              q.gainNow == null ? "–" : `${Math.round(q.gainNow)}%`,
              q.bestAt && q.status !== "used" ? `${q.bestAt.slice(5, 16).replace("T", " ")}Z @ ${Math.round(q.utilAtBest)}%` : "–",
              q.gainAtBest == null ? "–" : `${Math.round(q.gainAtBest)}%`,
              q.reason.length > 90 ? q.reason.slice(0, 87) + "…" : q.reason,
            ]),
          ]),
        );
        console.log();
      }
      console.log(
        c.dim(
          "gain = extra quota you can use before the natural reset (account-% of a week). Use the reset in the Claude app when a row says RESET NOW; the daemon detects it and marks it used.",
        ),
      );
    });

  offers
    .command("list")
    .description("All known offer definitions (bundled, feed, local) and whether each is active")
    .action(async () => {
      if (!(await daemonAlive())) die("the daemon must be running (cm daemon start)");
      const r: any = await api("/api/offers");
      const activeIds = new Set(r.active.map((x: any) => x.id));
      console.log(
        table([
          ["id", "kind", "title", "starts", "deadline", "state"],
          ...r.all.map((x: any) => [
            x.id,
            x.kind,
            x.title,
            x.startsAt?.slice(0, 10) ?? "–",
            x.deadline.slice(0, 10),
            r.disabled.includes(x.id)
              ? c.dim("disabled")
              : activeIds.has(x.id)
                ? c.green("active")
                : c.dim(Date.parse(x.deadline) < Date.now() ? "ended" : "not started / complete"),
          ]),
        ]),
      );
      console.log(c.dim(`feed: ${r.feedUrl ?? "off"}${r.lastFeedError ? ` (last fetch failed: ${r.lastFeedError})` : ""}`));
    });

  offers
    .command("refresh")
    .description("Fetch the offers feed now")
    .action(async () => {
      if (!(await daemonAlive())) die("the daemon must be running (cm daemon start)");
      const r: any = await api("/api/offers/refresh", { method: "POST" });
      console.log(
        r.error
          ? c.yellow(`feed fetch failed: ${r.error}`)
          : r.changed
            ? `feed updated · active: ${r.active.join(", ") || "none"}`
            : `no change · active: ${r.active.join(", ") || "none"}`,
      );
    });

  for (const verb of ["enable", "disable"] as const) {
    offers
      .command(`${verb} <offer-id>`)
      .description(`${verb} an offer`)
      .action(async (id: string) => {
        if (await daemonAlive()) await api(`/api/offers/${encodeURIComponent(id)}/${verb}`, { method: "POST" });
        else
          updateConfig((cfg) => {
            cfg.offers.disabled = cfg.offers.disabled.filter((x) => x !== id);
            if (verb === "disable") cfg.offers.disabled.push(id);
          });
        console.log(`${id} ${verb}d`);
      });
  }

  offers
    .command("concentrate <on|off>")
    .description("Fill one unused account at a time so its reset is worth a full window")
    .action(async (v: string) => {
      updateConfig((cfg) => void (cfg.offers.concentrate = v === "on"));
      if (await daemonAlive()) await api("/api/reload", { method: "POST" });
      console.log(`concentrate ${v === "on" ? "on" : "off"}`);
    });

  const oneActive = async (): Promise<string> => {
    const r: any = await api("/api/offers");
    if (r.active.length !== 1)
      die(r.active.length ? `several active offers; pass --offer <id>: ${r.active.map((x: any) => x.id).join(", ")}` : "no active offer");
    return r.active[0].id;
  };
  offers
    .command("used <account>")
    .description("Record that you used the reset on an account (auto-detected when the daemon sees the drop)")
    .option("--offer <id>")
    .action(async (name: string, o) => {
      if (!loadConfig().accounts.some((a) => a.name === name)) die(`no account "${name}"`);
      if (!(await daemonAlive())) die("the daemon must be running (cm daemon start)");
      const id = o.offer ?? (await oneActive());
      await api(`/api/offers/${encodeURIComponent(id)}/${encodeURIComponent(name)}/used`, { method: "POST" });
      console.log(`${name}: marked used for ${id}`);
    });
  offers
    .command("unused <account>")
    .description("Clear the used mark")
    .option("--offer <id>")
    .action(async (name: string, o) => {
      if (!(await daemonAlive())) die("the daemon must be running (cm daemon start)");
      const id = o.offer ?? (await oneActive());
      await api(`/api/offers/${encodeURIComponent(id)}/${encodeURIComponent(name)}/unused`, { method: "POST" });
      console.log(`${name}: marked unused for ${id}`);
    });
}
