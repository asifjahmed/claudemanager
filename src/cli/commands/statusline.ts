import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { api, daemonAlive } from "../client.js";
import { relShort } from "../render.js";

export function register(program: Command): void {
  program
    .command("statusline")
    .description("Claude Code statusLine command: reads Claude's JSON on stdin, prints one line")
    .action(async () => {
      let input: any = {};
      try {
        const raw = readFileSync(0, "utf8");
        input = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        /* ignore */
      }
      const model = input?.model?.display_name ?? input?.model?.id ?? "";
      const modelId = input?.model?.id ?? null;
      const sessionId = typeof input?.session_id === "string" ? input.session_id : null;
      const pct = (u: number | null | undefined) => (u == null ? "?" : `${Math.round(u)}%`);
      let line = "";
      try {
        if (await daemonAlive()) {
          const q = new URLSearchParams();
          if (sessionId) q.set("session", sessionId);
          if (modelId) q.set("model", modelId);
          const r: any = await api(`/api/advice?${q}`);
          const parts: string[] = [];
          if (r.session.account) {
            // this session's own account: 5h used + reset, weekly used, and the model's own window when it has one
            const own = [`5h ${pct(100 - r.session.sessionHeadroom)} ↻${relShort(r.session.sessionResetsAt)}`, `week ${pct(100 - r.session.weeklyHeadroom)}`];
            if (r.family && r.session.modelHeadroom !== null && r.session.modelHeadroom !== r.session.weeklyHeadroom)
              own.push(`${r.family} ${pct(100 - r.session.modelHeadroom)}`);
            parts.push(`⚡ ${r.session.account} · ${own.join(" · ")}`);
          } else {
            parts.push("⚡ unassigned");
          }
          const fam = r.family ? r.pool.families.find((f: any) => f.family === r.family) : null;
          if (fam) parts.push(`pool: ${fam.family} ${Math.round(fam.headroom)}% across ${fam.eligibleAccounts}`);
          else parts.push(`pool: 5h ${Math.round(r.pool.session.headroom)}% left`);
          const a = r.advice;
          if (a.action === "switch-model") parts.push(`→ switch to ${a.switchTo}`);
          else if (a.action === "pause") parts.push(`→ pause ${a.pauseUntil ? "until " + relShort(a.pauseUntil) : ""}`.trim());
          line = parts.join(" · ");
        }
      } catch {
        /* fall through */
      }
      if (!line) {
        const rl = input?.rate_limits;
        line = rl?.five_hour
          ? `5h ${Math.round(rl.five_hour.used_percentage)}% ↻${relShort(new Date(rl.five_hour.resets_at * 1000).toISOString())}${rl.seven_day ? ` · week ${Math.round(rl.seven_day.used_percentage)}%` : ""} · cm daemon off`
          : "cm: daemon off";
      }
      process.stdout.write(`${model ? model + " · " : ""}${line}\n`);
    });
}
