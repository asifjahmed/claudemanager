const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  magenta: (s: string) => (useColor ? `\x1b[35m${s}\x1b[0m` : s),
};

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "–";
  let d = Math.round((t - now) / 1000);
  const past = d < 0;
  d = Math.abs(d);
  const days = Math.floor(d / 86400);
  const h = Math.floor((d % 86400) / 3600);
  const m = Math.floor((d % 3600) / 60);
  const s = d % 60;
  let out: string;
  if (days > 0) out = `${days} day${days === 1 ? "" : "s"} ${h} hr`;
  else if (h > 0) out = `${h} hr ${m} min`;
  else if (m > 0) out = `${m} min`;
  else out = `${s} sec`;
  return past ? `${out} ago` : out;
}

/** Compact form for the status line: 3h34m, 13h54m, 6d21h */
export function relShort(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "–";
  let d = Math.round((t - now) / 1000);
  const past = d < 0;
  d = Math.abs(d);
  const days = Math.floor(d / 86400);
  const h = Math.floor((d % 86400) / 3600);
  const m = Math.floor((d % 3600) / 60);
  const out = days > 0 ? `${days}d${h}h` : h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : m > 0 ? `${m}m` : `${d}s`;
  return past ? `${out} ago` : out;
}

/** "just now", "2 min ago", "1 hr 5 min ago" */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const d = Math.round((now - ms) / 1000);
  if (d < 10) return "just now";
  if (d < 60) return `${d} sec ago`;
  return relTime(new Date(ms).toISOString(), now);
}

export function relMs(ms: number | null | undefined, now = Date.now()): string {
  return ms ? relTime(new Date(ms).toISOString(), now) : "–";
}

export function bar(util: number | null, width = 12, threshold = 90): string {
  if (util === null) return c.dim("░".repeat(width)) + c.dim("    ? used");
  const u = Math.max(0, Math.min(100, util));
  const filled = Math.round((u / 100) * width);
  const s = c.dim("░".repeat(width - filled));
  const pct = `${String(Math.round(util)).padStart(3)}% used`;
  const col = util >= threshold ? c.red : util >= threshold * 0.75 ? c.yellow : c.green;
  return col("█".repeat(filled)) + s + " " + col(pct);
}

export function pad(s: string, n: number): string {
  const len = stripAnsi(s).length;
  return len >= n ? s : s + " ".repeat(n - len);
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function table(rows: string[][], opts: { header?: boolean } = { header: true }): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const r of rows) r.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length)));
  const lines = rows.map((r) =>
    r
      .map((cell, i) => pad(cell, widths[i]))
      .join("  ")
      .trimEnd(),
  );
  if (opts.header) lines.splice(1, 0, c.dim(widths.map((w) => "─".repeat(w)).join("  ")));
  return lines.join("\n");
}

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

export function fmtTime(ms: number | null): string {
  if (!ms) return "–";
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
