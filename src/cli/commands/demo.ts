import type { Command } from "commander";
import { openBrowser } from "../common.js";
import { c } from "../render.js";

export function register(program: Command): void {
  program
    .command("demo")
    .description(
      "Run a self-contained demo (three synthetic accounts, fake upstream, generated traffic) to explore the dashboard; touches nothing in ~/.claudemanager",
    )
    .option("--port <n>", "port for the demo daemon", "4242")
    .option("--no-open", "do not open the browser")
    .action(async (o) => {
      const { startDemo } = await import("../../dev/demo.js");
      const demo = await startDemo({ port: Number(o.port), log: (m) => process.stderr.write(c.dim(`${m}\n`)) });
      console.log(`demo dashboard: ${demo.url}/   ${c.dim("(synthetic accounts; ctrl-c to stop)")}`);
      if (o.open) openBrowser(`${demo.url}/`);
      // a second signal (npx forwards the parent's) must not close twice
      let closing = false;
      const stop = async () => {
        if (closing) return;
        closing = true;
        await demo.close();
        process.exit(0);
      };
      process.on("SIGINT", () => void stop());
      process.on("SIGTERM", () => void stop());
      await new Promise(() => {});
    });
}
