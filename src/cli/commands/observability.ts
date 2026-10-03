import type { Command } from "commander";
import { api, daemonAlive, subscribe } from "../client.js";
import { c, table, fmtTokens, fmtUsd, fmtTime } from "../render.js";
import { die, ensureDaemon, withDb } from "../common.js";

export function register(program: Command): void {
  program
    .command("log")
    .description("List recent requests that went through the proxy")
    .option("--account <name>")
    .option("--model <substr>")
    .option("--session <id>")
    .option("--q <text>", "search prompt/response text")
    .option("-n, --limit <n>", "rows", "30")
    .option("--json")
    .option("-f, --follow", "stream new requests live (needs daemon)")
    .action(async (o) => {
      const filter = { account: o.account, model: o.model, session: o.session, q: o.q, limit: Number(o.limit) };
      const rows = (await daemonAlive())
        ? await api(
            `/api/requests?${new URLSearchParams(
              Object.entries(filter)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => [k, String(v)] as [string, string]),
            )}`,
          )
        : withDb((db) => db.listRequests(filter));
      const fmt = (r: any) => [
        String(r.id),
        fmtTime(r.startedAt),
        r.account ?? "–",
        (r.model ?? "–").replace("claude-", ""),
        (r.sessionId ?? "").slice(0, 8),
        fmtTokens(r.inputTokens),
        fmtTokens(r.outputTokens),
        `${fmtTokens(r.cacheReadTokens)}/${fmtTokens(r.cacheWriteTokens)}`,
        fmtUsd(r.estCostUsd),
        String(r.latencyMs ?? "–"),
        r.overheadMs == null ? "–" : `${r.overheadMs}+${r.ttfbMs ?? "?"}`,
        r.error ? c.red(String(r.statusCode ?? "err")) : r.retried ? c.yellow(`${r.statusCode} retry`) : String(r.statusCode ?? "…"),
      ];
      if (o.json) console.log(JSON.stringify(rows, null, 2));
      else
        console.log(
          table([
            ["id", "time", "account", "model", "session", "in", "out", "cache r/w", "cost", "ms", "proxy+ttfb", "status"],
            ...[...rows].reverse().map(fmt),
          ]),
        );
      if (o.follow) {
        await ensureDaemon(true);
        subscribe(
          (name, data) => {
            if (name === "request") console.log(fmt(data).join("  "));
          },
          () => process.exit(0),
        );
        await new Promise(() => {});
      }
    });

  program
    .command("show <id>")
    .description("Print the full prompt and response of a logged request")
    .option("--json")
    .action(async (id: string, o) => {
      const r = (await daemonAlive()) ? await api(`/api/requests/${Number(id)}`) : withDb((db) => db.getRequest(Number(id)));
      if (!r) die(`request ${id} not found`);
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      console.log(
        c.bold(`request #${r.id}`) +
          `  ${fmtTime(r.startedAt)}  account=${r.account}  model=${r.model}  session=${r.sessionId ?? "–"}  status=${r.statusCode}  ${r.latencyMs}ms`,
      );
      console.log(
        c.dim(
          `tokens in=${fmtTokens(r.inputTokens)} out=${fmtTokens(r.outputTokens)} cache_read=${fmtTokens(r.cacheReadTokens)} cache_write=${fmtTokens(r.cacheWriteTokens)} cost=${fmtUsd(r.estCostUsd)} stop=${r.stopReason ?? "–"}${r.retried ? " (retried)" : ""}${r.switchedFrom ? ` switched from ${r.switchedFrom}` : ""}`,
        ),
      );
      if (r.rl) console.log(c.dim(`ratelimit 5h=${r.rl.fiveHourUtil}% 7d=${r.rl.sevenDayUtil}% status=${r.rl.status} claim=${r.rl.claim}`));
      if (r.body) {
        if (r.body.system) console.log("\n" + c.cyan("── system ──") + "\n" + r.body.system);
        const msgs = Array.isArray(r.body.messages) ? r.body.messages : [];
        console.log("\n" + c.cyan(`── messages (${msgs.length}${r.body.mode === "lastTurn" ? ", last turn only" : ""}) ──`));
        for (const m of msgs) console.log(c.bold(`[${m.role}]`) + " " + (typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 1)));
        if (r.body.tools) console.log("\n" + c.dim(`tools: ${(r.body.tools as any[]).map((t) => t.name).join(", ")}`));
      } else console.log(c.dim("\n(body not stored)"));
      if (r.response) {
        console.log("\n" + c.magenta("── response ──"));
        for (const b of (r.response.content as any[]) ?? []) {
          if (b.type === "text") console.log(b.text);
          else if (b.type === "thinking") console.log(c.dim(`[thinking] ${b.thinking}`));
          else if (b.type === "tool_use") console.log(c.yellow(`[tool_use ${b.name}] `) + JSON.stringify(b.input));
          else console.log(JSON.stringify(b));
        }
        if (r.response.rawError) console.log(c.red(r.response.rawError));
      }
    });

  program
    .command("sessions")
    .description("Claude Code sessions seen by the proxy")
    .option("-n, --limit <n>", "rows", "30")
    .action(async (o) => {
      const rows = (await daemonAlive()) ? await api(`/api/sessions?limit=${Number(o.limit)}`) : withDb((db) => db.listSessions(Number(o.limit)));
      console.log(
        table([
          ["session", "first", "last", "reqs", "in", "out", "cache", "cost", "accounts", "models"],
          ...rows.map((s: any) => [
            s.sessionId.slice(0, 8),
            fmtTime(s.firstSeen),
            fmtTime(s.lastSeen),
            String(s.requests),
            fmtTokens(s.inputTokens),
            fmtTokens(s.outputTokens),
            fmtTokens(s.cacheReadTokens),
            fmtUsd(s.estCostUsd),
            s.accounts ?? "",
            (s.models ?? "").replace(/claude-/g, ""),
          ]),
        ]),
      );
    });

  program
    .command("stats")
    .description("Token and cost totals")
    .option("--by <key>", "account | model | day", "account")
    .option("--since <hours>", "only the last N hours")
    .action(async (o) => {
      const since = o.since ? Date.now() - Number(o.since) * 3600_000 : undefined;
      const rows = (await daemonAlive()) ? await api(`/api/stats?by=${o.by}${since ? `&since=${since}` : ""}`) : withDb((db) => db.stats(o.by, since));
      console.log(
        table([
          [o.by, "reqs", "errors", "retried", "in", "out", "cache read", "cache write", "est cost", "avg ms"],
          ...rows.map((r: any) => [
            String(r.key ?? "–").replace("claude-", ""),
            String(r.requests),
            String(r.errors),
            String(r.retried ?? 0),
            fmtTokens(r.inputTokens),
            fmtTokens(r.outputTokens),
            fmtTokens(r.cacheReadTokens),
            fmtTokens(r.cacheWriteTokens),
            fmtUsd(r.estCostUsd),
            String(Math.round(r.avgLatencyMs ?? 0)),
          ]),
        ]),
      );
    });

  program
    .command("purge")
    .description("Delete logged requests")
    .option("--before <date>", "only requests older than this date/ISO string")
    .option("--vacuum", "also shrink the database file (locks it for a while; the daemon keeps serving but cannot log meanwhile)")
    .action(async (o) => {
      const before = o.before ? Date.parse(o.before) : undefined;
      if (o.before && !Number.isFinite(before)) die("bad date");
      const r = (await daemonAlive()) ? await api("/api/purge", { method: "POST", body: { before } }) : withDb((db) => ({ deleted: db.purge(before) }));
      console.log(`deleted ${r.deleted} request(s)`);
      if (o.vacuum) {
        process.stderr.write("vacuuming… ");
        withDb((db) => db.vacuum());
        console.log("done");
      }
    });

  program
    .command("runway")
    .alias("capacity")
    .description("Will the pool run out before the next reset? Pooled headroom, burn rate and reset schedule per window")
    .option("--json")
    .action(async (o) => {
      if (!(await daemonAlive())) die("the daemon must be running for runway (cm daemon start)");
      const r: any = await api("/api/runway");
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      const hrs = (h: number | null) => (h == null ? "–" : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} d`);
      const col = r.verdict === "tight" ? c.red : r.verdict === "close" ? c.yellow : r.verdict === "comfortable" ? c.green : c.dim;
      console.log(col(c.bold(r.headline)));
      console.log(c.dim(r.detail));
      console.log();
      console.log(
        table([
          ["window", "headroom", "burn/h (24h)", "burn/h (7d)", "empty in (24h pace)", "empty in (7d pace)", "next reset", "status"],
          ...r.windows.map((w: any) => [
            w.label,
            `${Math.round(w.headroom)}% of ${w.capacity}%`,
            w.burnPerHour24h == null ? "–" : `${w.burnPerHour24h.toFixed(1)}%`,
            w.burnPerHour7d == null ? "–" : `${w.burnPerHour7d.toFixed(1)}%`,
            w.emptyInHours24h == null ? (w.burnPerHour24h == null ? "–" : "> 7 d") : hrs(w.emptyInHours24h),
            w.emptyInHours7d == null ? (w.burnPerHour7d == null ? "–" : "> 7 d") : hrs(w.emptyInHours7d),
            w.nextReset ? `${w.nextReset.account} +${Math.round(w.nextReset.frees)}% in ${hrs((w.nextReset.at - r.now) / 3600_000)}` : "–",
            w.status === "critical" ? c.red(w.status) : w.status === "tight" ? c.yellow(w.status) : w.status === "ok" ? c.green(w.status) : c.dim(w.status),
          ]),
        ]),
      );
      if (r.models?.length) {
        console.log();
        console.log(c.bold("by model") + c.dim("  (share of consumption by estimated cost; burn attributed on each model's binding window)"));
        console.log(
          table([
            [
              "model",
              "req 24h/7d",
              "share 24h",
              "share 7d",
              "burn/h 24h",
              "binding window",
              "headroom",
              "eligible",
              "at own pace (24h)",
              "at own pace (7d)",
              "next reset",
            ],
            ...r.models.map((m: any) => [
              m.model.replace(/^claude-/, ""),
              `${m.requests24h}/${m.requests7d}`,
              m.share24h == null ? "–" : `${Math.round(m.share24h * 100)}%`,
              m.share7d == null ? "–" : `${Math.round(m.share7d * 100)}%`,
              m.burnPerHour24h == null ? "–" : `${m.burnPerHour24h.toFixed(2)}%`,
              m.bindingWindow,
              `${Math.round(m.headroom)}%`,
              String(m.eligibleAccounts),
              m.hoursAtOwnPace24h == null ? "–" : m.hoursAtOwnPace24h > 168 ? "> 7 d" : hrs(m.hoursAtOwnPace24h),
              m.hoursAtOwnPace7d == null ? "–" : m.hoursAtOwnPace7d > 168 ? "> 7 d" : hrs(m.hoursAtOwnPace7d),
              m.nextReset ? `${m.nextReset.account} +${Math.round(m.nextReset.frees)}% in ${hrs((m.nextReset.at - r.now) / 3600_000)}` : "–",
            ]),
          ]),
        );
      }
      console.log();
      console.log(c.bold("resets in the next 7 days"));
      const all = r.windows
        .flatMap((w: any) => w.resets.map((x: any) => ({ ...x, label: w.label })))
        .sort((a: any, b: any) => a.at - b.at)
        .slice(0, 12);
      for (const x of all)
        console.log(
          `  ${c.dim(hrs((x.at - r.now) / 3600_000).padStart(7))}  ${x.account.padEnd(10)} ${x.label.padEnd(22)} ${c.dim(`frees ${Math.round(x.frees)}%`)}`,
        );
      if (!all.length) console.log(c.dim("  none pending"));
      console.log(
        c.dim(
          `\n${Math.round(r.coverageHours)} h of history · last 7 days: ${r.signals.relaxedEvents} over-threshold assignments, ${r.signals.fallbackEvents} fail-open requests, ${r.signals.dryEvents} pool-dry events`,
        ),
      );
    });

  program
    .command("attribution")
    .description("Which sessions consumed the pool's quota (share by estimated cost, attributed account-%)")
    .option("--hours <n>", "window", "24")
    .option("-n, --limit <n>", "rows", "20")
    .option("--json")
    .action(async (o) => {
      if (!(await daemonAlive())) die("the daemon must be running (cm daemon start)");
      const r: any = await api(`/api/attribution?hours=${Number(o.hours)}&limit=${Number(o.limit)}`);
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      console.log(
        c.dim(
          `last ${r.hours} h · pool consumed ${r.weeklyConsumed == null ? "?" : Math.round(r.weeklyConsumed) + "% weekly"} · ${r.sessionConsumed == null ? "?" : Math.round(r.sessionConsumed) + "% of 5-hour windows"} · est. ${fmtUsd(r.totalCostUsd)} at API prices`,
        ),
      );
      console.log(
        table([
          ["session", "share", "weekly %", "5h %", "reqs", "cache read", "peak ctx", "models", "first prompt"],
          ...r.sessions.map((s: any) => [
            s.sessionId.slice(0, 8),
            `${Math.round(s.share * 100)}%`,
            s.weeklyPct == null ? "–" : s.weeklyPct.toFixed(1),
            s.sessionPct == null ? "–" : s.sessionPct.toFixed(1),
            String(s.requests),
            fmtTokens(s.cacheReadTokens),
            fmtTokens(s.maxContext),
            Object.entries(s.familyShare)
              .sort((a: any, b: any) => b[1] - a[1])
              .map(([k, v]: any) => `${k} ${Math.round(v * 100)}%`)
              .join(" "),
            (s.firstPrompt ?? "").replace(/\s+/g, " ").slice(0, 50),
          ]),
        ]),
      );
    });

  program
    .command("context <session>")
    .description("How a session's context grew turn by turn, the biggest jumps, and the largest tool results in its latest prompt")
    .option("--json")
    .action(async (session: string, o) => {
      if (!(await daemonAlive())) die("the daemon must be running (cm daemon start)");
      // allow a prefix
      let sid = session;
      if (session.length < 36) {
        const all: any[] = await api("/api/sessions?limit=500");
        const hit = all.find((x) => x.sessionId.startsWith(session));
        if (!hit) die(`no session starting with ${session}`);
        sid = hit.sessionId;
      }
      const r: any = await api(`/api/sessions/${encodeURIComponent(sid)}/context`);
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      console.log(
        c.bold(`session ${sid.slice(0, 8)}`) +
          c.dim(
            `  ${r.turns.length} turns · context ${fmtTokens(r.firstContext)} → ${fmtTokens(r.lastContext)} (peak ${fmtTokens(r.peakContext)}) · cache read ${fmtTokens(r.cacheReadTotal)} · cache write ${fmtTokens(r.cacheWriteTotal)}`,
          ),
      );
      const W = 40;
      const peak = Math.max(1, r.peakContext);
      console.log(c.dim("context per turn"));
      for (const t of r.turns.slice(-30)) {
        const n = Math.round((t.context / peak) * W);
        console.log(
          `  ${c.dim(fmtTime(t.startedAt).slice(-11))} ${"█".repeat(n)}${c.dim("░".repeat(W - n))} ${fmtTokens(t.context).padStart(7)} ${t.delta > 0 ? c.yellow(`+${fmtTokens(t.delta)}`) : c.dim(String(t.delta))}${t.cacheWriteTokens ? c.dim(` w${fmtTokens(t.cacheWriteTokens)}`) : ""}`,
        );
      }
      if (r.biggestJumps.length) console.log(c.dim("biggest jumps: ") + r.biggestJumps.map((t: any) => `#${t.id} +${fmtTokens(t.delta)}`).join(", "));
      if (r.latest) {
        console.log(
          c.dim(
            `latest prompt: system ${fmtTokens(r.latest.systemChars)} chars · ${r.latest.toolsCount} tools (${fmtTokens(r.latest.toolsChars)} chars) · ${r.latest.messages} messages · tool results ${fmtTokens(r.latest.totalToolResultChars)} chars`,
          ),
        );
        if (r.latest.largestToolResults.length) {
          console.log(c.bold("largest tool results"));
          for (const x of r.latest.largestToolResults)
            console.log(`  ${fmtTokens(x.chars).padStart(7)} chars  ${(x.tool ?? "?").padEnd(14)} ${c.dim(x.preview.replace(/\s+/g, " ").slice(0, 70))}`);
        }
      } else console.log(c.dim("no stored prompt for this session (log.bodies is none?)"));
    });
}
