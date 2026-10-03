import { existsSync, readFileSync } from "node:fs";
import { DAEMON_INFO_PATH, loadConfig } from "../core/config.js";

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: number;
  version: string;
}

export function readDaemonInfo(): DaemonInfo | null {
  if (!existsSync(DAEMON_INFO_PATH)) return null;
  try {
    return JSON.parse(readFileSync(DAEMON_INFO_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function daemonBase(): string {
  const info = readDaemonInfo();
  const port = info?.port ?? loadConfig().port;
  return `http://127.0.0.1:${port}`;
}

export async function daemonAlive(): Promise<DaemonInfo | null> {
  const info = readDaemonInfo();
  if (!info) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const j = (await res.json()) as { pid: number; version: string };
    return { ...info, pid: j.pid ?? info.pid, version: j.version ?? info.version };
  } catch {
    return null;
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${daemonBase()}${path}`, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Subscribe to the daemon's SSE stream. Calls onEvent(name, data). Returns an abort function. */
export function subscribe(onEvent: (name: string, data: any) => void, onClose: (err?: Error) => void): () => void {
  const ctl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${daemonBase()}/api/events`, { signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let name = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (data) {
            try {
              onEvent(name, JSON.parse(data));
            } catch {
              /* ignore */
            }
          }
        }
      }
      onClose();
    } catch (err: any) {
      if (!ctl.signal.aborted) onClose(err);
    }
  })();
  return () => ctl.abort();
}
