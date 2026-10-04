#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { build, deploy, device, relay } from "./commands/ship";
import { doctor } from "./commands/doctor";
import { configCmd } from "./commands/config";
import { desync, record, sim, verify } from "./commands/play";
import { snap } from "./commands/snap";
import { skills } from "./commands/skills";
import { create, dev } from "./commands/new";
import { CliError, type Ctx, fail, num } from "./lib";

const HELP = `dotframe ${pkg.version}: build, test, and export dotframe games

Agents: run \`dotframe skills get core\` before anything else.

Play (headless, deterministic)
  sim      [--inputs f.jsonl | --mash <seed>] [--frames 600] [--seed 1] [--options json] [--every n]
  snap     --frame <n> [--out frame.png] [--inputs f | --mash <seed>] [--seed 1] [--options json]
  replay   record <file> | verify <file...>
  desync   [--latency 100ms] [--jitter 0ms] [--delay 2] [--frames 1800] [--renders 3]

Build and ship
  build    <target> [--release]         targets come from dotframe.json
  deploy   <target> [--prod]            gated: --yes, preview with --dry-run
  relay    deploy [--region eze]        gated
  device   install <target>             gated
  doctor   [--fix]                      toolchain, links, config, signing
  config   get [key] | set <key> <json>

Project
  new      <name> [--template fighter|platformer|blank] [--no-install]
  dev      [--port 5173]                build web, serve it, rebuild on change
  skills   list | get <name...> [--full] | get --all | path [name]

Global: --json  --yes  --dry-run  --help  --version`;

const INPUTS = `Inputs: --mash <seed> (random players) or --inputs f.jsonl (one [p0, p1] per frame, or {"frame": n, "inputs": [...]} held until the next line). --seed <n> seeds the sim, --options '<json>' overrides match options.`;

const COMMAND_HELP: Record<string, string> = {
  sim: `dotframe sim [--mash <seed> | --inputs f.jsonl] [--frames 600] [--seed 1] [--options json] [--every n] [--json]

Runs the game headless and prints the final state and checksum. --every n adds a checksum trace.
${INPUTS}

  dotframe sim --mash 7 --frames 600 --json
  dotframe sim --inputs combo.jsonl --options '{"stocks": 1}'`,
  snap: `dotframe snap --frame <n> [--out snap-<n>.png] [--mash <seed> | --inputs f.jsonl] [--seed 1] [--options json] [--json]

Steps the sim to frame n in a real browser (WebGPU, through agent-browser) and screenshots it. Open the PNG and look.
${INPUTS}

  dotframe snap --frame 300 --mash 7 --out /tmp/f300.png`,
  replay: `dotframe replay record <file> [--mash <seed> | --inputs f.jsonl] [--frames 1800] [--seed 1] [--options json]
dotframe replay verify <file...>

record stores seed, options, inputs, and a checksum every 60 frames. verify replays them and exits 1 with the
first divergent frame.

  dotframe replay record replays/smoke.json --mash 7
  dotframe replay verify replays/*.json`,
  desync: `dotframe desync [--latency 100ms] [--jitter 0ms] [--delay 2] [--frames 1800] [--renders 3] [--every 30] [--mash <seed> | --inputs f]

Runs a reference sim and two rollback peers over a simulated link. Peer 1 renders --renders times per step.
Compares checksums every frame and the full inspect() state every --every frames; exits 1 on any difference.
Warns when rollbacks exceed the sim's rollbackWindow.

  dotframe desync --latency 474ms --jitter 40ms --mash 42 --json`,
  build: `dotframe build <target> [--release] [--dry-run] [--json]

Runs targets.<target>.steps from dotframe.json. --release refuses assets listed in assets.localOnly.

  dotframe build web
  dotframe build ios --release`,
  deploy: `dotframe deploy <target> [--prod] [--dry-run] [--yes] [--json]

Deploys targets.<target>.out with its deploy provider. Without --yes it stops with APPROVAL_REQUIRED (exit 2).
Show the --dry-run plan to a human first.

  dotframe deploy web --prod --dry-run`,
  relay: `dotframe relay deploy [--region eze] [--dry-run] [--yes]

Redeploys the netplay relay (dokploy) or deploys it to a region (fly). Gated like deploy.`,
  device: `dotframe device install <target> [--dry-run] [--yes]

Installs targets.<target>.app on targets.<target>.device with devicectl. Gated like deploy.`,
  doctor: `dotframe doctor [--fix] [--json]

Checks tools, dotframe.json, the sim (loads, renders with a stub Draw2D), placeholders, and vendor links.
--fix creates missing vendor symlinks.`,
  config: `dotframe config get [key]
dotframe config set <key> <json> [--dry-run]

Dotted keys. Values are JSON (strings need inner quotes). set rewrites dotframe.json with 2-space indent and short
objects and arrays on one line.

  dotframe config set targets.web.deploy.scope '"my-team"'`,
  new: `dotframe new <name> [--template fighter|platformer|blank] [--no-install] [--json]

Scaffolds a game. Inside an existing git repo it does not run git init.`,
  dev: `dotframe dev [--port 5173]

Builds the web target, serves it (index.html with no-cache, as in production), and rebuilds on change.`,
  skills: `dotframe skills list | get <name...> [--full] | get --all | path [name]

Guides bundled with this CLI version. Start with: dotframe skills get core`,
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean" },
    full: { type: "boolean" },
    all: { type: "boolean" },
    fix: { type: "boolean" },
    prod: { type: "boolean" },
    release: { type: "boolean" },
    inputs: { type: "string" },
    mash: { type: "string" },
    frames: { type: "string" },
    frame: { type: "string" },
    seed: { type: "string" },
    options: { type: "string" },
    every: { type: "string" },
    out: { type: "string" },
    latency: { type: "string" },
    jitter: { type: "string" },
    delay: { type: "string" },
    renders: { type: "string" },
    region: { type: "string" },
    template: { type: "string" },
    port: { type: "string" },
    "no-install": { type: "boolean" },
  },
});

const ctx: Ctx = { json: values.json === true, yes: values.yes === true, dryRun: values["dry-run"] === true };
const v = values as Record<string, string | undefined>;
const [command, ...rest] = positionals;

try {
  if (values.version) console.log(pkg.version);
  else if (command && values.help && COMMAND_HELP[command]) console.log(COMMAND_HELP[command]);
  else if (!command || values.help) console.log(HELP);
  else if (command === "sim") await sim(ctx, v);
  else if (command === "snap") await snap(ctx, v);
  else if (command === "replay" && rest[0] === "record") await record(ctx, rest[1], v);
  else if (command === "replay" && rest[0] === "verify") await verify(ctx, rest.slice(1));
  else if (command === "desync") await desync(ctx, v);
  else if (command === "build") await build(ctx, rest[0], values.release === true);
  else if (command === "deploy") await deploy(ctx, rest[0], values.prod === true);
  else if (command === "relay" && rest[0] === "deploy") await relay(ctx, v.region);
  else if (command === "device" && rest[0] === "install") await device(ctx, rest[1] ?? "ios");
  else if (command === "doctor") await doctor(ctx, values.fix === true);
  else if (command === "config") await configCmd(ctx, rest);
  else if (command === "skills") await skills(ctx, rest, values.full === true, values.all === true);
  else if (command === "new") await create(ctx, rest[0], v.template ?? "blank", values["no-install"] !== true);
  else if (command === "dev") await dev(ctx, num("port", v.port, 5173, 1));
  else throw new CliError("UNKNOWN_COMMAND", `unknown command: ${positionals.join(" ")}`, "dotframe --help");
} catch (error) {
  fail(ctx, error);
}
