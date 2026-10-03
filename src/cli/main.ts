#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "../core/version.js";
import { ConfigError } from "../core/config.js";
import { die } from "./common.js";
import * as status from "./commands/status.js";
import * as accounts from "./commands/accounts.js";
import * as run from "./commands/run.js";
import * as route from "./commands/route.js";
import * as daemon from "./commands/daemon.js";
import * as config from "./commands/config.js";
import * as statusline from "./commands/statusline.js";
import * as doctor from "./commands/doctor.js";
import * as observability from "./commands/observability.js";
import * as apps from "./commands/apps.js";
import * as demo from "./commands/demo.js";
import * as offers from "./commands/offers.js";

const program = new Command();
program.name("cm").description("Monitor several Claude Max accounts and route Claude Code traffic to the one with the most headroom").version(VERSION);

for (const m of [status, accounts, run, route, daemon, config, statusline, doctor, observability, apps, demo, offers]) m.register(program);

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof ConfigError) die(err.message);
  die(err?.message ?? String(err));
});
