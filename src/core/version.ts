import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Package version, read once from package.json (works from src/ via tsx and from dist/). */
function read(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const cand of [join(here, "..", "..", "package.json"), join(here, "..", "..", "..", "package.json")]) {
    try {
      const j = JSON.parse(readFileSync(cand, "utf8"));
      if (j?.name === "claudemanager" && typeof j.version === "string") return j.version;
    } catch {
      /* try next */
    }
  }
  return "0.0.0";
}
export const VERSION = read();
