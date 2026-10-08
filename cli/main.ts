#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { build, deploy, device, deviceLogs, relay, vendor } from "./commands/ship";
import { doctor } from "./commands/doctor";
import { deployInit } from "./commands/docker";
import { configCmd } from "./commands/config";
import { desync, rebase, record, sim, verify } from "./commands/play";
import { compare } from "./commands/compare";
import { snap } from "./commands/snap";
import { playOnline } from "./commands/online";
import { skills } from "./commands/skills";
import { assetsFont, assetsSlim } from "./commands/assets";
import { create, dev } from "./commands/new";
import { CliError, type Ctx, fail, num, print, useXcode } from "./lib";
import { startRelay } from "./relay";

const HELP = `dotframe ${pkg.version}: build, test, and export dotframe games

Agents: run \`dotframe skills get core\` before anything else.

Play (headless, deterministic)
  sim      [--inputs f.jsonl | --mash <seed>] [--frames 600] [--seed 1] [--options json] [--every n]
  compare  --frame <n> (--ref <png> | reference.command) [--camera ...] [--out dir]
  snap     --frame <n>[,<n>...] [--camera ex,ey,ez,tx,ty,tz[,fov]] [--out frame.png] [--inputs f | --mash <seed>] [--seed 1] [--options json]
  replay   record <file> | verify <file...> | rebase <file...>
  play     --online [room] [--frames 600] [--seeds 1,2]   two browsers, local relay, scripted match
  desync   [--latency 100ms] [--jitter 0ms] [--delay 2] [--frames 1800] [--renders 3]

Build and ship
  build    <target> [--release]         targets come from dotframe.json
  deploy   <target> [--prod]            gated: --yes, preview with --dry-run
  deploy   init <target> --provider dokploy [--compose id]   Dockerfiles, nginx, compose
  relay    serve [--port 8787]          local netplay relay (same protocol as production)
  relay    deploy [--region eze]        gated
  device   install <target>             gated
  device   logs <target>                newest crash report from the device, summarized
  assets   slim <src> <out> [--no-jpeg]  ship-size copy: GLBs keep what loadGlb reads, opaque PNG textures become JPEG
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
  compare: `dotframe compare --frame <n> [--ref <png>] [--camera ex,ey,ez,tx,ty,tz[,fov]] [--inputs f.jsonl | --mash <seed>] [--seed 1] [--options json] [--out <dir>] [--dry-run] [--json]

Puts the port's frame next to the original game's picture of the same shot and measures how far apart they are:
compare.png (port | reference | difference x4), the mean absolute difference, each side's mean luminance, and the
luminance difference per cell of a 3x3 grid (negative: the port is darker there). The reference is --ref, or
what dotframe.json's reference.command writes: argv with {shot} (a JSON file with frame, seconds, seed, options,
camera, inputs) and {out} (the PNG to write), for example a Godot script that loads the original at that moment.

  dotframe compare --frame 600 --ref captures/godot-600.png --out /tmp/cmp-600
  dotframe compare --frame 2108 --camera -2.5,1.7,-4.5,-2.5,1.4,-9.5,60 --inputs replays/inputs/night2-survive.jsonl`,
  snap: `dotframe snap --frame <n>[,<n>...] [--camera ex,ey,ez,tx,ty,tz[,fov]] [--out snap-{frame}.png] [--mash <seed> | --inputs f.jsonl] [--seed 1] [--options json] [--json]

Steps the sim to frame n in a real browser (WebGPU, through agent-browser) and screenshots it. Open the PNG and look.
${INPUTS}

  dotframe snap --frame 300 --mash 7 --out /tmp/f300.png
  dotframe snap --frame 60,240,600 --out /tmp/walk-{frame}.png   several frames of one run, one browser
  dotframe snap --frame 300 --camera 0,1.6,-3,0,1.2,0,35   a 3D game seen from another camera (eye, target, fov)`,
  replay: `dotframe replay record <file> [--mash <seed> | --inputs f.jsonl] [--frames 1800] [--seed 1] [--options json] [--through-over]
dotframe replay verify <file...>
dotframe replay rebase <file...> [--from HEAD] [--ignore state.a,state.b] [--dry-run]

record stores seed, options, inputs, and a checksum every 60 frames. verify replays them and exits 1 with the
first divergent frame.

  dotframe replay record replays/smoke.json --mash 7
  dotframe replay verify replays/*.json
  dotframe replay rebase replays/*.json --ignore state.kuro

rebase re-records replays after a change that must not move the simulation, once it shows that it did not: each
replay runs on the sim at --from (a git ref, HEAD by default) and on the working tree, and the final state() must
match, except paths under --ignore and paths only the new state has. Moved replays are reported (exit 1) and
left alone. The old tree reuses the game's node_modules, so it isolates the game's change, not the engine's.`,
  desync: `dotframe desync [--latency 100ms] [--jitter 0ms] [--delay 2] [--frames 1800] [--renders 3] [--every 30] [--mash <seed> | --inputs f]

Runs a reference sim and two rollback peers over a simulated link. Peer 1 renders --renders times per step.
Compares checksums every frame and the full inspect() state every --every frames; exits 1 on any difference.
Warns when rollbacks exceed the sim's rollbackWindow.

  dotframe desync --latency 474ms --jitter 40ms --mash 42 --json`,
  play: `dotframe play --online [room] [--frames 600] [--seeds 1,2] [--native] [--out .dotframe/play] [--json]

Builds the web target, starts a local relay, and opens two agent-browser sessions on ?room=<room>&relay=...&mash=<seed>
(one seed per peer from --seeds).
Waits until both confirm --frames frames, compares their checksums every 30 frames, and saves a screenshot of each.
The web entry must honor ?room=, ?relay=, ?mash= and publish globalThis.__dotframe: createProbe() and createMasher()
from dotframe/src/probe do both (templates show it). --native makes peer 1 the macOS build, which reads DOTFRAME_ROOM,
DOTFRAME_RELAY, DOTFRAME_MASH and writes its probe to DOTFRAME_PROBE (templates' main.native.ts does).`,
  build: `dotframe build <target> [--release] [--dry-run] [--json]

Runs targets.<target>.steps from dotframe.json, or for a native target ({"native": {"platform": "macos",
"entry": "main.native.ts"}}) stages the engine and game in .dotframe/native/<target> and writes dist/<target>/<name>.
Failures keep the full output in .dotframe/logs and return its path. --release refuses assets.localOnly.

  dotframe build web
  dotframe build ios --release`,
  deploy: `dotframe deploy <target> [--prod] [--dry-run] [--yes] [--json]
dotframe deploy init <target> --provider dokploy [--compose <id>] [--site <dir>] [--path /play/] [--yes]

provider vercel: uploads targets.<target>.out. provider dokploy: redeploys the compose stack (it builds from the
pushed branch), waits for the result, and on failure returns the build log. Without --yes it stops with
APPROVAL_REQUIRED (exit 2); show the --dry-run plan to a human first.

init writes deploy/Dockerfile.web (installs "requires" tools, builds with dotframe), deploy/Dockerfile.relay
(dotframe relay serve), deploy/nginx.conf (no-cache HTML) and deploy/compose.yaml (web at /, relay at /relay).
--site serves a static folder (a landing page) at / with the game at --path (default /play/ with a site).

  dotframe deploy web --prod --dry-run
  dotframe deploy init web --provider dokploy`,
  relay: `dotframe relay serve [--port 8787]
dotframe relay deploy [--region eze] [--dry-run] [--yes]

serve runs the netplay relay locally (PORT env or --port): it pairs two clients per ?room= and forwards their
messages, the protocol connectRelay in dotframe/src/netplay speaks. deploy redeploys the production relay
(dokploy) or deploys it to a region (fly), gated like deploy.`,
  device: `dotframe device install <target> [--dry-run] [--yes]
dotframe device logs <target> [--json]

install puts the built app on targets.<target>.device with devicectl (gated like deploy). logs copies the newest
crash report of the app's process from the device into .dotframe/logs and prints the exception, termination and
the crashed thread's frames (read-only on the device).`,
  assets: `dotframe assets slim <src> <out> [--no-jpeg] [--clips a,b,...] [--rename a=b,...] [--json]
dotframe assets font <font.ttf> <out> [--size 48] [--chars-from <dir>] [--dry-run] [--json]

Copies src to out. Every .glb keeps only what loadGlb reads: POSITION, NORMAL, TEXCOORD_0, JOINTS_0 and WEIGHTS_0,
indices (narrowed to 16 bits when they fit), skins, animations and base color images. Normal, roughness and other
maps go, and opaque PNG base colors become JPEG through ffmpeg. Sources stay untouched. A GLB with something the
rewrite does not understand is copied as it is and noted. iOS builds slim their bundle the same way.
--clips keeps only the named animations (exact, or after "Armature|") in each GLB that has any of them, to import
a model whose library ships far more clips than the game plays; GLBs with none of them keep theirs.

  dotframe assets slim assets dist/web/assets
  dotframe assets slim tools/dog assets/models --clips walk_fwd_01,run_fwd_01
  dotframe assets slim tools/dog/dog.glb assets/models/dog.glb --clips walk_fwd_01 --rename walk_fwd_01=walk

src and out may be two .glb files instead of folders, to import one model. --rename gives the kept animations the
names the game plays them by. font bakes a TTF into the SDF atlas Draw2D.addFont reads (out.png and out.json):
printable ASCII and Latin-1, plus every other character in the text files under --chars-from, so a caption cannot
miss a glyph. It builds tools/bake-font.c with the machine's C compiler the first time.

  dotframe assets font tools/fonts/KleeOne-SemiBold.ttf assets/fonts/klee-one --chars-from src`,
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
objects and arrays on one line. vendor is per machine: dotframe config set vendor <dir> writes ~/.dotframe/config.json.

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
    camera: { type: "string" },
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
    "no-jpeg": { type: "boolean" },
    clips: { type: "string" },
    rename: { type: "string" },
    size: { type: "string" },
    "chars-from": { type: "string" },
    from: { type: "string" },
    ignore: { type: "string" },
    ref: { type: "string" },
    "through-over": { type: "boolean" },
    docker: { type: "boolean" },
    online: { type: "boolean" },
    seeds: { type: "string" },
    site: { type: "string" },
    native: { type: "boolean" },
    path: { type: "string" },
    provider: { type: "string" },
    compose: { type: "string" },
  },
});

const ctx: Ctx = { json: values.json === true, yes: values.yes === true, dryRun: values["dry-run"] === true };
const v = { ...(values as Record<string, string | undefined>), throughOver: values["through-over"] === true } as Record<string, string | undefined> & { throughOver: boolean };
const [command, ...rest] = positionals;
if (command === "build" || command === "device" || command === "doctor") useXcode();

try {
  if (values.version) console.log(pkg.version);
  else if (command && values.help && COMMAND_HELP[command]) console.log(COMMAND_HELP[command]);
  else if (!command || values.help) console.log(HELP);
  else if (command === "play" && values.online === true) await playOnline(ctx, rest[0], { frames: v.frames, out: v.out, seeds: v.seeds, native: values.native === true });
  else if (command === "sim") await sim(ctx, v);
  else if (command === "snap") await snap(ctx, v);
  else if (command === "replay" && rest[0] === "record") await record(ctx, rest[1], v);
  else if (command === "replay" && rest[0] === "verify") await verify(ctx, rest.slice(1));
  else if (command === "compare") await compare(ctx, v);
  else if (command === "replay" && rest[0] === "rebase") await rebase(ctx, rest.slice(1), typeof values.from === "string" ? values.from : undefined, typeof values.ignore === "string" ? values.ignore : undefined);
  else if (command === "desync") await desync(ctx, v);
  else if (command === "build") await build(ctx, rest[0], values.release === true);
  else if (command === "deploy" && rest[0] === "init") await deployInit(ctx, rest[1], v.provider, v.compose, v.site, v.path);
  else if (command === "deploy") await deploy(ctx, rest[0], values.prod === true);
  else if (command === "relay" && rest[0] === "deploy") await relay(ctx, v.region);
  else if (command === "relay" && rest[0] === "serve") {
    const port = num("port", v.port, Number(process.env.PORT ?? "8787"), 1);
    const server = startRelay(port, (line: string): void => console.error(line));
    print(ctx, { relay: `ws://localhost:${server.port}`, port: server.port }, (): string => `relay listening on ws://localhost:${server.port} (Ctrl+C to stop)`);
    await new Promise((): void => {});
  }
  else if (command === "device" && rest[0] === "install") await device(ctx, rest[1] ?? "ios");
  else if (command === "device" && rest[0] === "logs") await deviceLogs(ctx, rest[1] ?? "ios");
  else if (command === "vendor") await vendor(ctx, rest[0]);
  else if (command === "assets" && rest[0] === "slim")
    assetsSlim(
      ctx,
      rest[1],
      rest[2],
      values["no-jpeg"] !== true,
      typeof values.clips === "string" ? values.clips.split(",").map((c: string): string => c.trim()).filter(Boolean) : undefined,
      typeof values.rename === "string" ? Object.fromEntries(values.rename.split(",").map((p: string): string[] => p.split("=").map((x: string): string => x.trim())).filter((p: string[]): boolean => p.length === 2 && p[0] !== "" && p[1] !== "")) : undefined,
    );
  else if (command === "assets" && rest[0] === "font") assetsFont(ctx, rest[1], rest[2], typeof values.size === "string" ? values.size : undefined, typeof values["chars-from"] === "string" ? values["chars-from"] : undefined);
  else if (command === "doctor") await doctor(ctx, values.fix === true, values.docker === true);
  else if (command === "config") await configCmd(ctx, rest);
  else if (command === "skills") await skills(ctx, rest, values.full === true, values.all === true);
  else if (command === "new") await create(ctx, rest[0], v.template ?? "blank", values["no-install"] !== true);
  else if (command === "dev") await dev(ctx, num("port", v.port, 5173, 1));
  else throw new CliError("UNKNOWN_COMMAND", `unknown command: ${positionals.join(" ")}`, "dotframe --help");
} catch (error) {
  fail(ctx, error);
}
