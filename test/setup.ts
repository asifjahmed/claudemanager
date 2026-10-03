// Loaded via `node --import` before every test file: keep tests away from the real ~/.claudemanager.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.CLAUDEMANAGER_HOME = mkdtempSync(join(tmpdir(), "cm-test-home-"));
// promotions would steer routing in fixtures and fetch the feed from the network
process.env.CLAUDEMANAGER_OFFERS = "off";
