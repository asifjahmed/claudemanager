import type { Command } from "commander";
import { join } from "node:path";
import { CM_HOME, getConfigValue, loadConfig, setConfigValue, updateConfig } from "../../core/config.js";
import { api, daemonAlive } from "../client.js";

export function register(program: Command): void {
  const config = program.command("config").description("Get or set configuration");
  config.command("get [key]").action((key?: string) => {
    const cfg = loadConfig();
    console.log(JSON.stringify(key ? getConfigValue(cfg, key) : cfg, null, 2));
  });
  config
    .command("set <key> <value>")
    .description("e.g. cm config set threshold 85")
    .action(async (key: string, value: string) => {
      updateConfig((cfg) => setConfigValue(cfg, key, value));
      if (await daemonAlive()) await api("/api/reload", { method: "POST" });
      console.log(`${key} = ${JSON.stringify(getConfigValue(loadConfig(), key))}`);
    });
  config.command("path").action(() => console.log(join(CM_HOME, "config.json")));
}
