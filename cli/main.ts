#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { build, deploy, device, relay, vendor } from "./commands/ship";
import { doctor } from "./commands/doctor";
import { deployInit } from "./commands/docker";
import { configCmd } from "./commands/config";
import { desync, record, sim, verify } from "./commands/play";
import { snap } from "./commands/snap";
import { playOnline } from "./commands/online";
import { skills } from "./commands/skills";
import { create, dev } from "./commands/new";
import { CliError, type Ctx, fail, num, print } from "./lib";
import { startRelay } from "./relay";

const HELP = `dotframe ${pkg.version}: build, test, and export dotframe games

Agents: run \`dotframe skills get core\` before anything else.

Play (headless, deterministic)
  sim      [--inputs f.jsonl | --mash <seed>] [--frames 600] [--seed 1] [--options json] [--every n]
  snap     --frame <n> [--out frame.png] [--inputs f | --mash <seed>] [--seed 1] [--options json]
  replay   record <file> | verify <file...>
  play     --online [room] [--frames 600] [--seeds 1,2]   two browsers, local relay, scripted match
  desync   [--latency 100ms] [--jitter 0ms] [--delay 2] [--frames 1800] [--renders 3]

Build and ship
  build    <target> [--release]         targets come from dotframe.json
  deploy   <target> [--prod]            gated: --yes, preview with --dry-run
  deploy   init <target> --provider dokploy [--compose id]   Dockerfiles, nginx, compose
  relay    serve [--port 8787]          local netplay relay (same protocol as production)
  relay    deploy [--region eze]        gated
  device   install <target>             gated
  vendor   <macos|windows>              SDL3 + wgpu-native for native builds (~/.dotframe/vendor)
  doctor   [--fix] [--docker]           toolchain, vendor, links, config, sim render and math
  config   get [key] | set <key> <json>

Project
  new      <name> [--template fighter|platformer|blank] [--no-install]
  dev      [--port 5173]                build web, serve it, rebuild on change
  skills   list | get <name...> [--full] | get --all | path [name]

Global: --json  --yes  --dry-run  --help  --version`;

const INPUTS = `Inputs: --mash <seed> (random players) or --inputs f.jsonl (one [p0, p1] per frame, or {"frame": n, "inputs": [...]} held until the next line). --seed <n> seeds the sim, --options '<json>' overrides match options.`;

const COMMAND_HELP: Record<string, string> = {
  sim: `dotframe sim [--mash <seed> | --inputs f.jsonl] [--frames 600] [--seed 1] [--options json] [--every n] [--through-over] [--json]

Runs the game headless and prints the final state and checksum. It stops when the match is over unless
--through-over (rematch and results flows). --every n adds a checksum trace.
${INPUTS}

  dotframe sim --mash 7 --frames 600 --json
  dotframe sim --inputs combo.jsonl --options '{"stocks": 1}'`,
  snap: `dotframe snap --frame <n> [--out snap-<n>.png] [--mash <seed> | --inputs f.jsonl] [--seed 1] [--options json] [--json]

Steps the sim to frame n in a real browser (WebGPU, through agent-browser) and screenshots it. Open the PNG and look.
${INPUTS}

  dotframe snap --frame 300 --mash 7 --out /tmp/f300.png`,
  replay: `dotframe replay record <file> [--mash <seed> | --inputs f.jsonl] [--frames 1800] [--seed 1] [--options json] [--through-over]
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
  play: `dotframe play --online [room] [--frames 600] [--seeds 1,2] [--out .dotframe/play] [--json]

Builds the web target, starts a local relay, and opens two agent-browser sessions on ?room=<room>&relay=...&mash=<seed>
(one seed per peer from --seeds).
Waits until both confirm --frames frames, compares their checksums every 30 frames, and saves a screenshot of each.
The web entry must honor ?room=, ?relay=, ?mash= and publish globalThis.__dotframe: createProbe() and createMasher()
from dotframe/src/probe do both (templates show it).`,
  build: `dotframe build <target> [--release] [--dry-run] [--json]

Runs targets.<target>.steps from dotframe.json, or for a native target ({"native": {"platform": "macos",
"entry": "main.native.ts"}}) stages the engine and game in .dotframe/native/<target> and writes dist/<target>/<name>.
Failures keep the full output in .dotframe/logs and return its path. --release refuses assets.localOnly.

  dotframe build web
  dotframe build ios --release`,
  deploy: `dotframe deploy <target> [--prod] [--dry-run] [--yes] [--json]
dotframe deploy init <target> --provider dokploy [--compose <id>] [--yes]

provider vercel: uploads targets.<target>.out. provider dokploy: redeploys the compose stack (it builds from the
pushed branch), waits for the result, and on failure returns the build log. Without --yes it stops with
APPROVAL_REQUIRED (exit 2); show the --dry-run plan to a human first.

init writes deploy/Dockerfile.web (installs "requires" tools, builds with dotframe), deploy/Dockerfile.relay
(dotframe relay serve), deploy/nginx.conf (no-cache index.html) and deploy/compose.yaml (web at /, relay at /relay).

  dotframe deploy web --prod --dry-run
  dotframe deploy init web --provider dokploy`,
  relay: `dotframe relay serve [--port 8787]
dotframe relay deploy [--region eze] [--dry-run] [--yes]

serve runs the netplay relay locally (PORT env or --port): it pairs two clients per ?room= and forwards their
messages, the protocol connectRelay in dotframe/src/netplay speaks. deploy redeploys the production relay
(dokploy) or deploys it to a region (fly), gated like deploy.`,
  device: `dotframe device install <target> [--dry-run] [--yes]

Installs targets.<target>.app on targets.<target>.device with devicectl. Gated like deploy.`,
  vendor: `dotframe vendor <macos|windows> [--dry-run]

Downloads wgpu-native and builds SDL3 for native targets into DOTFRAME_VENDOR (default ~/.dotframe/vendor), which
survives reinstalling dotframe and is shared by every game.`,
  doctor: `dotframe doctor [--fix] [--docker] [--json]

Checks tools (including "requires" in dotframe.json), vendor, links, placeholders, the sim (render with a stub
Draw2D leaves state alone) and platform-dependent math in code the sim reaches. --fix creates missing vendor
symlinks; --docker builds the dokploy web image locally, as the server would.`,
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
    "through-over": { type: "boolean" },
    docker: { type: "boolean" },
    online: { type: "boolean" },
    seeds: { type: "string" },
    provider: { type: "string" },
    compose: { type: "string" },
  },
});

const ctx: Ctx = { json: values.json === true, yes: values.yes === true, dryRun: values["dry-run"] === true };
const v = { ...(values as Record<string, string | undefined>), throughOver: values["through-over"] === true } as Record<string, string | undefined> & { throughOver: boolean };
const [command, ...rest] = positionals;

try {
  if (values.version) console.log(pkg.version);
  else if (command && values.help && COMMAND_HELP[command]) console.log(COMMAND_HELP[command]);
  else if (!command || values.help) console.log(HELP);
  else if (command === "play" && values.online === true) await playOnline(ctx, rest[0], { frames: v.frames, out: v.out, seeds: v.seeds });
  else if (command === "sim") await sim(ctx, v);
  else if (command === "snap") await snap(ctx, v);
  else if (command === "replay" && rest[0] === "record") await record(ctx, rest[1], v);
  else if (command === "replay" && rest[0] === "verify") await verify(ctx, rest.slice(1));
  else if (command === "desync") await desync(ctx, v);
  else if (command === "build") await build(ctx, rest[0], values.release === true);
  else if (command === "deploy" && rest[0] === "init") await deployInit(ctx, rest[1], v.provider, v.compose);
  else if (command === "deploy") await deploy(ctx, rest[0], values.prod === true);
  else if (command === "relay" && rest[0] === "deploy") await relay(ctx, v.region);
  else if (command === "relay" && rest[0] === "serve") {
    const port = num("port", v.port, Number(process.env.PORT ?? "8787"), 1);
    const server = startRelay(port, (line: string): void => console.error(line));
    print(ctx, { relay: `ws://localhost:${server.port}`, port: server.port }, (): string => `relay listening on ws://localhost:${server.port} (Ctrl+C to stop)`);
    await new Promise((): void => {});
  }
  else if (command === "device" && rest[0] === "install") await device(ctx, rest[1] ?? "ios");
  else if (command === "vendor") await vendor(ctx, rest[0]);
  else if (command === "doctor") await doctor(ctx, values.fix === true, values.docker === true);
  else if (command === "config") await configCmd(ctx, rest);
  else if (command === "skills") await skills(ctx, rest, values.full === true, values.all === true);
  else if (command === "new") await create(ctx, rest[0], v.template ?? "blank", values["no-install"] !== true);
  else if (command === "dev") await dev(ctx, num("port", v.port, 5173, 1));
  else throw new CliError("UNKNOWN_COMMAND", `unknown command: ${positionals.join(" ")}`, "dotframe --help");
} catch (error) {
  fail(ctx, error);
}
