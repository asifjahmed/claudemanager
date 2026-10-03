import { createServer, type Server } from "node:http";

export interface FakeAccount {
  fiveHour: number;
  sevenDay?: number;
  /** per-model weekly windows as fractions, e.g. { fable: 0.4 } */
  models?: Record<string, number>;
  exhausted?: boolean;
  transient429?: boolean;
  /** demo: fraction of the 5h/7d/model windows consumed per request (advances state on every hit) */
  perRequest?: { fiveHour: number; sevenDay: number; models?: Record<string, number> };
  resetsAt?: { fiveHour: number; sevenDay: number };
}

export interface UpstreamOptions {
  /** per-token state; token -> account */
  accounts: Record<string, FakeAccount>;
  /** demo: reply text and latency */
  replyText?: (token: string, body: any) => string;
  latencyMs?: number;
  /** keep every request in `seen` for assertions (tests); off for load tests, which would otherwise retain every body */
  retain?: boolean;
}

export interface Seen {
  path: string;
  auth: string | undefined;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

const token0 = (auth: string | undefined) => (auth ?? "").replace("Bearer ", "");

export async function startFakeUpstream(opts: UpstreamOptions): Promise<{ server: Server; url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: any;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      const auth = req.headers.authorization;
      if (opts.retain !== false) seen.push({ path: req.url ?? "", auth, body, headers: req.headers });
      if ((req.url ?? "").startsWith("/api/oauth/usage")) {
        const acctU = opts.accounts[token0(auth)];
        if (!acctU) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad token" }));
          return;
        }
        const now = Date.now();
        const r5 = new Date(acctU.resetsAt?.fiveHour ?? now + 3600_000).toISOString();
        const r7 = new Date(acctU.resetsAt?.sevenDay ?? now + 5 * 86400_000).toISOString();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            five_hour: { utilization: Math.round(acctU.fiveHour * 100), resets_at: r5 },
            seven_day: { utilization: Math.round((acctU.sevenDay ?? 0) * 100), resets_at: r7 },
            limits: Object.entries(acctU.models ?? {}).map(([k, v]) => ({
              kind: "weekly_scoped",
              group: "weekly",
              percent: Math.round(v * 100),
              resets_at: r7,
              scope: { model: { id: null, display_name: k[0].toUpperCase() + k.slice(1) } },
            })),
          }),
        );
        return;
      }
      if (!(req.url ?? "").startsWith("/v1/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ passthrough: true, auth }));
        return;
      }
      const token = (auth ?? "").replace("Bearer ", "");
      const acct = opts.accounts[token];
      const now = Date.now();
      if (acct) {
        // demo: roll windows that have passed their reset and advance consumption per request
        if (acct.resetsAt) {
          if (now >= acct.resetsAt.fiveHour) {
            acct.fiveHour = 0;
            acct.resetsAt.fiveHour = now + 5 * 3600_000;
          }
          if (now >= acct.resetsAt.sevenDay) {
            acct.sevenDay = 0;
            for (const k of Object.keys(acct.models ?? {})) acct.models![k] = 0;
            acct.resetsAt.sevenDay = now + 7 * 86400_000;
          }
        }
        if (acct.perRequest) {
          const fam = /fable|mythos/.test(body?.model ?? "")
            ? "fable"
            : /opus/.test(body?.model ?? "")
              ? "opus"
              : /sonnet/.test(body?.model ?? "")
                ? "sonnet"
                : null;
          acct.fiveHour = Math.min(1, acct.fiveHour + acct.perRequest.fiveHour);
          acct.sevenDay = Math.min(1, (acct.sevenDay ?? 0) + acct.perRequest.sevenDay);
          if (fam && acct.models && acct.models[fam] !== undefined) acct.models[fam] = Math.min(1, acct.models[fam] + (acct.perRequest.models?.[fam] ?? 0));
          acct.exhausted = acct.fiveHour >= 1 || (fam && acct.models?.[fam] !== undefined ? acct.models[fam] >= 1 : false);
        }
      }
      if (!acct) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad token" } }));
        return;
      }
      if (acct.transient429) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "2" });
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Error" } }));
        return;
      }
      const reset = acct.resetsAt ? Math.floor(acct.resetsAt.fiveHour / 1000) : Math.floor(Date.now() / 1000) + 3600;
      const reset7 = acct.resetsAt ? Math.floor(acct.resetsAt.sevenDay / 1000) : reset + 86400;
      const rl = {
        "anthropic-ratelimit-unified-5h-utilization": String(acct.fiveHour),
        "anthropic-ratelimit-unified-5h-reset": String(reset),
        "anthropic-ratelimit-unified-7d-utilization": String(acct.sevenDay ?? 0.1),
        "anthropic-ratelimit-unified-7d-reset": String(reset7),
        "anthropic-ratelimit-unified-status": acct.exhausted ? "rate_limited" : "allowed",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      };
      if (acct.exhausted) {
        res.writeHead(429, { "content-type": "application/json", ...rl });
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limit" } }));
        return;
      }
      if (body?.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", ...rl });
        const ev = (e: object) => res.write(`event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`);
        ev({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } });
        ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } });
        setTimeout(() => {
          ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `from ${token}` } });
          ev({ type: "content_block_stop", index: 0 });
          ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
          ev({ type: "message_stop" });
          res.end();
        }, 20);
        return;
      }
      res.writeHead(200, { "content-type": "application/json", ...rl });
      res.end(
        JSON.stringify({ content: [{ type: "text", text: `hello from ${token}` }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}
