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
import { CliError, type Ctx, fail } from "./lib";

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
  else if (command === "dev") await dev(ctx, Number(v.port ?? "5173"));
  else throw new CliError("UNKNOWN_COMMAND", `unknown command: ${positionals.join(" ")}`, "dotframe --help");
} catch (error) {
  fail(ctx, error);
}
