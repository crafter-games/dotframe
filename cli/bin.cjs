#!/usr/bin/env node
// npm runs this with Node; the CLI itself needs Bun. Say so in one line instead of "env: bun: not found".
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const main = join(__dirname, "main.ts");
if (typeof Bun !== "undefined") {
  import(main);
} else {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.error("dotframe needs Bun: curl -fsSL https://bun.sh/install | bash   (then open a new shell)");
    process.exit(1);
  }
  const run = spawnSync("bun", [main, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}
