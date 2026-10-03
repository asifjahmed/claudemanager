/**
 * `cm demo`: a self-contained daemon with three synthetic accounts, a fake Anthropic upstream and a traffic
 * generator, so the dashboard can be explored without a Claude account. Touches nothing under ~/.claudemanager.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigSchema } from "../core/config.js";
import { createDaemon } from "../daemon/server.js";
import { startFakeUpstream, type FakeAccount } from "./fake-upstream.js";

const MODELS = ["claude-fable-5-1", "claude-fable-5-1", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"];
const PROMPTS = [
  "Refactor the auth middleware to use the new session store",
  "Why does the nightly ETL job time out on Mondays?",
  "Write tests for the rate limiter",
  "Summarize the incident report and draft the postmortem",
  "Migrate the CLI to commander v12",
  "Explain this stack trace",
  "Add a runway view to the dashboard",
];

export async function startDemo(opts: { port: number; log?: (m: string) => void; rate?: number }): Promise<{ url: string; close(): Promise<void> }> {
  const log = opts.log ?? (() => {});
  const now = Date.now();
  const h = 3600_000;
  const accounts: Record<string, FakeAccount> = {
    "tok-work": {
      fiveHour: 0.42,
      sevenDay: 0.58,
      models: { fable: 0.71 },
      resetsAt: { fiveHour: now + 2.4 * h, sevenDay: now + 1.3 * 24 * h },
      perRequest: { fiveHour: 0.004, sevenDay: 0.0012, models: { fable: 0.003 } },
    },
    "tok-personal": {
      fiveHour: 0.12,
      sevenDay: 0.31,
      models: { fable: 0.44 },
      resetsAt: { fiveHour: now + 4.1 * h, sevenDay: now + 3.6 * 24 * h },
      perRequest: { fiveHour: 0.004, sevenDay: 0.0012, models: { fable: 0.003 } },
    },
    "tok-spare": {
      fiveHour: 0.0,
      sevenDay: 0.06,
      models: { fable: 0.09 },
      resetsAt: { fiveHour: now + 5 * h, sevenDay: now + 5.8 * 24 * h },
      perRequest: { fiveHour: 0.004, sevenDay: 0.0012, models: { fable: 0.003 } },
    },
  };
  const up = await startFakeUpstream({
    accounts,
    latencyMs: 400,
    replyText: (_t, body) =>
      `Sure. Here is a ${body?.model?.includes("fable") ? "thorough" : "quick"} answer to: ${String(body?.messages?.at?.(-1)?.content ?? "").slice(0, 60)}`,
  });
  const dir = mkdtempSync(join(tmpdir(), "cm-demo-"));
  const cfg = ConfigSchema.parse({
    port: opts.port,
    upstream: up.url,
    pollIntervalSec: 10,
    activePollIntervalSec: 10,
    accounts: [
      { name: "work", configDir: join(dir, "work"), email: "you@work.example", subscriptionType: "max" },
      { name: "personal", configDir: join(dir, "personal"), email: "you@example.com", subscriptionType: "max" },
      { name: "spare", configDir: join(dir, "spare"), email: "spare@example.com", subscriptionType: "max" },
    ],
  });
  const tokenFor = (configDir: string) => `tok-${configDir.split("/").pop()}`;
  const d = createDaemon({
    config: cfg,
    dbPath: join(dir, "demo.db"),
    affinityPath: null,
    log,
    getToken: async (configDir) => tokenFor(configDir),
    // the poller's usage fetch goes to the fake upstream with the account's token
    fetchImpl: ((input: any, init?: any) => {
      const u = String(input);
      const auth: string = init?.headers?.Authorization ?? init?.headers?.authorization ?? "";
      if (u.includes("/api/oauth/usage") || u.includes("/v1/oauth/token")) {
        return fetch(`${up.url}/api/oauth/usage`, { headers: { authorization: auth } });
      }
      if (u.includes("/api/oauth/profile")) {
        // a synthetic subscription so the cards show a renewal date; nothing here reaches the network
        const name = auth.replace(/^Bearer tok-/, "");
        const email = cfg.accounts.find((a) => a.name === name)?.email ?? null;
        const started = new Date(now - (name.length * 7 + 11) * 24 * h);
        started.setMonth(started.getMonth() - 3);
        const body = {
          account: { email },
          organization: {
            name: `${name} workspace`,
            subscription_status: "active",
            subscription_created_at: started.toISOString(),
            rate_limit_tier: "default_claude_max_20x",
          },
        };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return fetch(input, init);
    }) as typeof fetch,
  });
  for (const a of cfg.accounts) {
    const st = d.store.get(a.name)!;
    st.tier = "default_claude_max_20x";
    st.hasInferenceToken = true;
  }
  const port = await d.listen(opts.port);
  d.poller.start();
  const base = `http://127.0.0.1:${port}`;

  // traffic: a few long-lived "sessions" plus the odd new one
  const sessions = Array.from({ length: 4 }, () => ({
    id: randomUUID(),
    model: MODELS[Math.floor(Math.random() * MODELS.length)],
    prompt: PROMPTS[Math.floor(Math.random() * PROMPTS.length)],
    turns: 0,
  }));
  let running = true;
  const tick = async () => {
    if (!running) return;
    const s =
      Math.random() < 0.08
        ? { id: randomUUID(), model: MODELS[Math.floor(Math.random() * MODELS.length)], prompt: PROMPTS[Math.floor(Math.random() * PROMPTS.length)], turns: 0 }
        : sessions[Math.floor(Math.random() * sessions.length)];
    if (!sessions.includes(s)) sessions.push(s);
    s.turns++;
    const messages: any[] = [{ role: "user", content: s.prompt }];
    for (let i = 1; i < Math.min(s.turns, 12); i++)
      messages.push(
        { role: "assistant", content: `step ${i} done` },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(400 + i * 900) },
            { type: "text", text: "continue" },
          ],
        },
      );
    try {
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer demo", "x-claude-code-session-id": s.id },
        body: JSON.stringify({
          model: s.model,
          stream: true,
          max_tokens: 400,
          system: "You are a helpful engineer.",
          messages,
          tools: [{ name: "Bash", description: "run a command", input_schema: { type: "object" } }],
        }),
      }).then((r) => r.text());
    } catch {
      /* demo traffic is best effort */
    }
    setTimeout(tick, (opts.rate ?? 2500) * (0.5 + Math.random()));
  };
  setTimeout(tick, 500);
  return {
    url: base,
    async close() {
      running = false;
      await d.close();
      await up.close();
    },
  };
}
