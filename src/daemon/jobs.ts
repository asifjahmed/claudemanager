/** Long-running interactive account operations started from the dashboard, with streamed output. */
import { randomUUID } from "node:crypto";
import { loginAccount, setupToken, AccountOpError } from "../core/account-ops.js";
import type { EventBus } from "../core/events.js";

export interface Job {
  id: string;
  kind: "login" | "setup-token";
  account: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  /** last ~4 KB of CLI output */
  output: string;
  /** a URL seen in the output (the login page), for when the browser did not open */
  url: string | null;
  result: string | null;
  error: string | null;
}

export class JobRunner {
  private jobs = new Map<string, Job>();
  private aborts = new Map<string, AbortController>();
  constructor(
    private readonly bus: EventBus,
    private readonly log: (m: string) => void,
    private readonly onDone: () => void,
  ) {}

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  running(kind: Job["kind"], account: string): Job | undefined {
    return [...this.jobs.values()].find((j) => j.kind === kind && j.account === account && j.status === "running");
  }

  cancel(id: string): boolean {
    const ac = this.aborts.get(id);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  start(kind: Job["kind"], account: string, opts: { email?: string; configDir?: string } = {}): Job {
    const existing = this.running(kind, account);
    if (existing) return existing;
    const job: Job = {
      id: randomUUID(),
      kind,
      account,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      output: "",
      url: null,
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    const ac = new AbortController();
    this.aborts.set(job.id, ac);
    const onOutput = (chunk: string) => {
      job.output = (job.output + chunk).slice(-4096);
      const m = /(https?:\/\/[^\s"'<>]+)/.exec(chunk);
      if (m && !job.url) job.url = m[1];
      this.bus.publish({ type: "state", at: Date.now() });
    };
    this.log(`job ${job.kind} ${account} started`);
    const p =
      kind === "login"
        ? loginAccount(account, { email: opts.email, configDir: opts.configDir, onOutput, signal: ac.signal }).then((r) => `signed in as ${r.email ?? "?"}`)
        : setupToken(account, { onOutput, signal: ac.signal }).then((r) => `long-lived token stored (${r.where})`);
    p.then(
      (result) => {
        job.status = "done";
        job.result = result;
      },
      (err: any) => {
        job.status = "failed";
        job.error = err instanceof AccountOpError ? err.message : (err?.message ?? String(err));
      },
    ).finally(() => {
      job.finishedAt = Date.now();
      this.aborts.delete(job.id);
      this.log(`job ${job.kind} ${account} ${job.status}${job.error ? `: ${job.error}` : ""}`);
      this.onDone();
      this.bus.publish({ type: "state", at: Date.now() });
    });
    return job;
  }
}
