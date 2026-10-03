import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  p = normalize(p).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, p);
  if (!file.startsWith(root)) return false;
  let st;
  try {
    st = statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": st.size,
    "cache-control": "no-cache",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  createReadStream(file).pipe(res);
  return true;
}
