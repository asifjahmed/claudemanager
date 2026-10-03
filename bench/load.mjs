// Load generator: spawns bench/daemon.mjs in its own process and drives N sessions against it.
// usage: node bench/load.mjs [sessions=1000] [requestsPerSession=3] [bodyKB=300] [accounts=10] [concurrency=200]
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const [S = 1000, R = 3, KB = 300, A = 10, C = 200] = process.argv.slice(2).map(Number);
const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [`--max-old-space-size=${process.env.BENCH_HEAP ?? 4096}`, join(here, "daemon.mjs")], { env: { ...process.env, BENCH_ACCOUNTS: String(A) }, stdio: ["ignore", "pipe", "inherit"] });
let buf = "";
const ready = new Promise((resolve) => child.stdout.on("data", (d) => { buf += d; const line = buf.split("\n").find((l) => l.includes('"port"')); if (line) resolve(JSON.parse(line)); }));
const { port, pid } = await ready;
const base = `http://127.0.0.1:${port}`;
const sse = await fetch(`${base}/api/events`);
let sseBytes = 0; (async () => { for await (const c of sse.body) sseBytes += c.length; })().catch(() => {});
const filler = "y".repeat(Math.floor((KB * 1024) / 8));
const body = (sid, turn) => JSON.stringify({ model: turn % 3 ? "claude-fable-5-1" : "claude-sonnet-5", stream: true, max_tokens: 400, system: "You are helpful.", messages: [{ role: "user", content: "start" }, ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: filler }))], metadata: { user_id: `user_x_account_${randomUUID()}_session_${sid}` } });
const sessions = Array.from({ length: S }, () => randomUUID());
const jobs = []; for (const sid of sessions) for (let r = 0; r < R; r++) jobs.push({ sid, r });
const lat = []; let errors = 0, next = 0;
const rssSamples = [];
const sampler = setInterval(() => { try { const out = spawn("ps", ["-o", "rss=", "-p", String(pid)]); let o = ""; out.stdout.on("data", (d) => (o += d)); out.on("close", () => { const kb = Number(o.trim()); if (kb) rssSamples.push(Math.round(kb / 1024)); }); } catch {} }, 500);
const t0 = performance.now();
async function worker() {
  for (;;) {
    const j = jobs[next++]; if (!j) return;
    const s = performance.now();
    try {
      const res = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer c", "x-claude-code-session-id": j.sid }, body: body(j.sid, j.r) });
      await res.text();
      if (res.status !== 200) errors++;
    } catch { errors++; }
    lat.push(performance.now() - s);
  }
}
await Promise.all(Array.from({ length: C }, worker));
const wall = (performance.now() - t0) / 1000;
clearInterval(sampler);
const st = await (await fetch(`${base}/api/state`)).json();
lat.sort((a, b) => a - b);
const p = (q) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * q))]);
const doneP = new Promise((resolve) => child.stdout.on("data", (d) => { buf += d; const line = buf.split("\n").find((l) => l.includes('"done"')); if (line) resolve(JSON.parse(line)); }));
child.kill("SIGTERM");
const done = await Promise.race([doneP, new Promise((r) => setTimeout(() => r({ timeout: true }), 15000))]);
sse.body?.cancel?.().catch(() => {});
console.log(JSON.stringify({ sessions: S, requests: lat.length, concurrency: C, bodyKB: KB, accounts: A, wallSec: +wall.toFixed(1), reqPerSec: Math.round(lat.length / wall), latencyMs: { p50: p(0.5), p90: p(0.9), p99: p(0.99), max: Math.round(lat[lat.length - 1]) }, errors, daemonLoopLag: st.perf?.current ?? st.perf?.lastMinute, daemonRssMB: { peak: Math.max(0, ...rssSamples), atEnd: done.rssMB }, recorderBacklogAtEnd: done.backlog, dbRows: done.rows, sseKB: Math.round(sseBytes / 1024), activePerAccount: st.sessions }, null, 1));
process.exit(0);
