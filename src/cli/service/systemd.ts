import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_LOG_PATH } from "../../core/config.js";
import type { ServiceManager } from "./index.js";
import { writeWrapper } from "./wrapper.js";

const UNIT = "claudemanager.service";
const UNIT_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", UNIT);

function systemctl(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

export const systemd: ServiceManager = {
  name: "systemd (user)",
  installed: () => existsSync(UNIT_PATH),
  install() {
    const wrapper = writeWrapper();
    const unit = `[Unit]
Description=claudemanager daemon (Claude Code multi-account proxy)
After=network-online.target

[Service]
ExecStart=${wrapper}
Restart=always
RestartSec=5
StandardOutput=append:${DAEMON_LOG_PATH}
StandardError=append:${DAEMON_LOG_PATH}

[Install]
WantedBy=default.target
`;
    mkdirSync(join(UNIT_PATH, ".."), { recursive: true });
    writeFileSync(UNIT_PATH, unit);
    const out = [`wrote ${UNIT_PATH}`, `launcher ${wrapper}`];
    const r1 = systemctl("daemon-reload");
    const r2 = systemctl("enable", "--now", UNIT);
    out.push(r1.ok && r2.ok ? "enabled and started via systemctl --user" : `systemctl: ${r1.out} ${r2.out}`.trim());
    out.push("tip: `loginctl enable-linger $USER` keeps the daemon running when you are logged out");
    return out;
  },
  uninstall() {
    systemctl("disable", "--now", UNIT);
    if (existsSync(UNIT_PATH)) unlinkSync(UNIT_PATH);
    systemctl("daemon-reload");
    return [`removed ${UNIT_PATH}`];
  },
  start() {
    systemctl("start", UNIT);
  },
  stop() {
    systemctl("stop", UNIT);
  },
  restart() {
    systemctl("restart", UNIT);
  },
  statusHint() {
    const r = systemctl("is-active", UNIT);
    return `systemd: ${r.out || (r.ok ? "active" : "inactive")}`;
  },
};
