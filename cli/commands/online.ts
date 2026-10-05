import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, type Ctx, exec, loadConfig, num, print, runSteps, target, which } from "../lib";
import { buildNative, type NativeTarget } from "../native";
import { startRelay } from "../relay";

interface Probe {
  frame: number;
  confirmed: number;
  status: string;
  sums: Record<string, number>;
}

// Two browsers play one online match through a local relay, each with a scripted masher, and their checksums at
// every 30th confirmed frame must agree. The game's web entry honors ?room=, ?relay= and ?mash=, and publishes
// globalThis.__dotframe = { frame, confirmed, status, sums } (the templates do; see the netplay skill).
export async function playOnline(ctx: Ctx, room: string | undefined, args: { frames?: string; out?: string; seeds?: string; native?: boolean }): Promise<void> {
  const skill = "netplay";
  const config = loadConfig();
  const t = target(config, "web");
  if (!t.out) throw new CliError("NO_OUT", "the web target needs an out dir", "", "export-web");
  if (!which("agent-browser")) throw new CliError("TOOL_MISSING", "agent-browser not found (play drives two browsers)", "npm i -g agent-browser && agent-browser install", skill);
  const frames = num("frames", args.frames, 600, 60);
  // One mash seed per peer; different seeds make the peers press different inputs, which is what exercises rollback.
  const seedParts = (args.seeds ?? "1,2").split(",");
  if (seedParts.length !== 2) throw new CliError("BAD_ARG", `--seeds needs two comma-separated seeds, got "${args.seeds}"`, "--seeds 7,42", skill);
  const seeds = seedParts.map((part: string): number => num("seeds", part.trim(), 1));
  const name = room ?? `play-${Date.now().toString(36)}`;
  const outDir = resolve(process.cwd(), args.out ?? ".dotframe/play");
  await runSteps({ ...ctx, json: true }, config.root, t.steps ?? [], "export-web");
  // --native: peer 1 is the macOS build, launched with DOTFRAME_ROOM, DOTFRAME_RELAY, DOTFRAME_MASH and DOTFRAME_PROBE.
  let nativeBinary = "";
  if (args.native) {
    const entry = Object.entries(config.targets).find(([, target]) => target.native?.platform === "macos");
    if (!entry) throw new CliError("UNKNOWN_TARGET", "play --native needs a target with native.platform macos", "add \"macos\": {\"native\": {\"platform\": \"macos\", \"entry\": \"main.native.ts\"}}", skill);
    const [nativeName, nativeTarget] = entry;
    const built = await buildNative({ ...ctx, json: true }, config.root, config.name, nativeName, nativeTarget.native as NativeTarget);
    nativeBinary = built.binary;
  }
  const web = resolve(config.root, t.out);
  const relay = startRelay(0);
  const server = Bun.serve({
    port: 0,
    fetch: (req: Request): Response => {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const file = join(web, path === "/" ? "index.html" : path);
      return existsSync(file) ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
    },
  });
  const sessions = args.native ? ["dotframe-play-0"] : ["dotframe-play-0", "dotframe-play-1"];
  const probeFile = join(outDir, "native-probe.json");
  let nativeProcess: ReturnType<typeof Bun.spawn> | null = null;
  const ab = (session: string, ...a: string[]) => exec({ ...ctx, json: true }, config.root, { label: `agent-browser ${a[0]}`, argv: ["agent-browser", "--session", session, ...a] });
  const read = async (session: string): Promise<Probe | null> => {
    const r = await ab(session, "eval", "JSON.stringify(globalThis.__dotframe ?? null)");
    try {
      const text = JSON.parse(r.tail.trim()) as string;
      return JSON.parse(text) as Probe | null;
    } catch {
      return null;
    }
  };
  try {
    for (const [i, session] of sessions.entries()) {
      const url = `http://localhost:${server.port}/?room=${encodeURIComponent(name)}&relay=${encodeURIComponent(`ws://localhost:${relay.port}`)}&mash=${seeds[i]}`;
      const opened = await ab(session, "open", url);
      if (opened.code !== 0) throw new CliError("BROWSER_FAILED", opened.tail, "agent-browser install", skill);
    }
    if (args.native) {
      mkdirSync(outDir, { recursive: true });
      rmSync(probeFile, { force: true });
      nativeProcess = Bun.spawn([nativeBinary], {
        cwd: config.root,
        env: { ...process.env, DOTFRAME_ROOM: name, DOTFRAME_RELAY: `ws://localhost:${relay.port}`, DOTFRAME_MASH: String(seeds[1]), DOTFRAME_PROBE: probeFile },
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    const readNative = (): Probe | null => {
      try {
        return JSON.parse(readFileSync(probeFile, "utf8")) as Probe;
      } catch {
        return null;
      }
    };
    let probes: (Probe | null)[] = [null, null];
    const started = Date.now();
    // Wait until both peers confirm `frames` frames, or stop making progress.
    let last = -1;
    let lastChange = Date.now();
    for (;;) {
      probes = [await read(sessions[0]), args.native ? readNative() : await read(sessions[1])];
      const confirmed = Math.min(...probes.map((p) => p?.confirmed ?? 0));
      if (confirmed >= frames) break;
      if (confirmed !== last) {
        last = confirmed;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange > 20000) {
        throw new CliError("PLAY_STALLED", `no progress for 20 s: peers at ${probes.map((p) => (p ? `${p.status} ${p.confirmed}` : "no __dotframe")).join(" / ")}`, "the web entry must honor ?room=, ?relay=, ?mash= and publish globalThis.__dotframe (see the netplay skill)", skill);
      }
      await Bun.sleep(500);
    }
    const [a, b] = probes as Probe[];
    const compared = Object.keys(a.sums).filter((f: string): boolean => b.sums[f] !== undefined).map(Number).sort((x, y) => x - y);
    const mismatch = compared.find((f: number): boolean => a.sums[f] !== b.sums[f]);
    const shots = sessions.map((_s, i) => join(outDir, `peer-${i}.png`));
    // The native peer's window is not captured; its checksums are the comparison.
    mkdirSync(outDir, { recursive: true });
    for (const [i, session] of sessions.entries()) {
      const shot = await ab(session, "screenshot", shots[i]);
      if (shot.code !== 0 || !existsSync(shots[i])) throw new CliError("BROWSER_FAILED", `screenshot of peer ${i} failed: ${shot.tail}`, "", skill);
    }
    const ok = mismatch === undefined && compared.length > 0;
    print(ctx, { ok, room: name, seeds, peers: args.native ? ["web", "native macOS"] : ["web", "web"], frames: Math.min(a.confirmed, b.confirmed), compared: compared.length, firstMismatch: mismatch ?? null, seconds: Math.round((Date.now() - started) / 1000), screenshots: shots }, (): string =>
      [
        ok ? `in sync${args.native ? " (web vs native macOS)" : ""}: ${compared.length} checksums compared over ${Math.min(a.confirmed, b.confirmed)} confirmed frames` : mismatch !== undefined ? `DESYNC at frame ${mismatch}` : "no checksums to compare",
        `screenshots: ${shots.join(", ")} (open them and look)`,
      ].join("\n"),
    );
    if (!ok) process.exit(1);
  } finally {
    nativeProcess?.kill();
    for (const session of sessions) await ab(session, "close");
    server.stop(true);
    relay.stop(true);
  }
}
