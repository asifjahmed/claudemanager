import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_LOG_PATH } from "../../core/config.js";
import type { ServiceManager } from "./index.js";
import { writeWrapper } from "./wrapper.js";

const LABEL = "com.claudemanager.daemon";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const target = () => `gui/${process.getuid?.() ?? ""}/${LABEL}`;
const domain = () => `gui/${process.getuid?.() ?? ""}`;

function launchctl(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

export const launchd: ServiceManager = {
  name: "launchd",
  installed: () => existsSync(PLIST),
  install() {
    const wrapper = writeWrapper();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${wrapper}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${DAEMON_LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${DAEMON_LOG_PATH}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${homedir()}</string></dict>
</dict></plist>
`;
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    if (existsSync(PLIST)) launchctl("bootout", target());
    writeFileSync(PLIST, xml);
    const r = launchctl("bootstrap", domain(), PLIST);
    return [`wrote ${PLIST}`, `launcher ${wrapper}`, r.ok ? "loaded via launchctl" : `launchctl bootstrap: ${r.out}`];
  },
  uninstall() {
    launchctl("bootout", target());
    if (existsSync(PLIST)) unlinkSync(PLIST);
    return [`removed ${PLIST}`];
  },
  start() {
    const r = launchctl("kickstart", target());
    if (!r.ok) launchctl("bootstrap", domain(), PLIST);
  },
  stop() {
    launchctl("bootout", target());
  },
  restart() {
    const r = launchctl("kickstart", "-k", target());
    if (!r.ok) launchctl("bootstrap", domain(), PLIST);
  },
  statusHint() {
    const r = launchctl("print", target());
    const pid = /^\s*pid = (\d+)/m.exec(r.out)?.[1];
    return r.ok ? `launchd: loaded${pid ? `, pid ${pid}` : ""}` : "launchd: not loaded (cm daemon start reloads it)";
  },
};
