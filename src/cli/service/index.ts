import { launchd } from "./launchd.js";
import { systemd } from "./systemd.js";

/** A user-level service manager that keeps the daemon running across logins. */
export interface ServiceManager {
  readonly name: string;
  installed(): boolean;
  /** write the unit/plist and start it */
  install(): string[];
  uninstall(): string[];
  start(): void;
  stop(): void;
  restart(): void;
  /** one line for `cm daemon status` */
  statusHint(): string;
}

export function service(): ServiceManager | null {
  if (process.platform === "darwin") return launchd;
  if (process.platform === "linux") return systemd;
  return null;
}
