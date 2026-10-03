// Throwaway daemon + fake upstream in its own process; prints {port} as JSON on stdout when ready.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.CLAUDEMANAGER_HOME = mkdtempSync(join(tmpdir(), "cm-bench-home-"));
process.env.CLAUDEMANAGER_OFFERS = "off";
const { createDaemon } = await import("../dist/daemon/server.js");
const { ConfigSchema } = await import("../dist/core/config.js");
const { startFakeUpstream } = await import("../dist/dev/fake-upstream.js");
const A = Number(process.env.BENCH_ACCOUNTS ?? 10);
const accounts = Object.fromEntries(Array.from({ length: A }, (_, i) => [`tok-a${i}`, { fiveHour: 0.05 * (i % 4), sevenDay: 0.1, models: { fable: 0.1 * (i % 5) } }]));
const up = await startFakeUpstream({ accounts, latencyMs: Number(process.env.BENCH_LATENCY ?? 30), replyText: () => "x".repeat(2000), retain: false });
const dir = mkdtempSync(join(tmpdir(), "cm-bench-"));
const cfg = ConfigSchema.parse({ upstream: up.url, accounts: Object.keys(accounts).map((t) => ({ name: t.slice(4), configDir: `/tmp/bench/${t.slice(4)}` })), log: { bodies: process.env.BENCH_BODIES ?? "full" } });
const d = createDaemon({ config: cfg, dbPath: join(dir, "bench.db"), writer: "worker", affinityPath: join(dir, "aff.json"), log: () => {}, getToken: async (c) => `tok-${c.split("/").pop()}` });
for (const [t, a] of Object.entries(accounts)) {
  const st = d.store.get(t.slice(4));
  st.usage = { fiveHour: { utilization: a.fiveHour * 100, resetsAt: new Date(Date.now() + 3600e3).toISOString() }, sevenDay: { utilization: 10, resetsAt: new Date(Date.now() + 5 * 86400e3).toISOString() }, models: { fable: { utilization: a.models.fable * 100, resetsAt: new Date(Date.now() + 5 * 86400e3).toISOString() } }, extra: {}, fetchedAt: Date.now(), source: "poll" };
  st.hasInferenceToken = true;
}
const port = await d.listen(0);
process.stdout.write(JSON.stringify({ port, pid: process.pid }) + "\n");
process.on("SIGTERM", async () => { await d.flush(); const rss = process.memoryUsage().rss; process.stdout.write(JSON.stringify({ done: true, rssMB: Math.round(rss / 1048576), backlog: d.recorder.writer.backlog(), rows: d.db.counts().requests, affinity: d.proxy.affinity.size() }) + "\n"); await d.close(); await up.close(); process.exit(0); });
