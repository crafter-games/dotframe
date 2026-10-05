import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, type Ctx, exec, loadConfig, num, print, runSteps, target, which } from "../lib";
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
export async function playOnline(ctx: Ctx, room: string | undefined, args: { frames?: string; out?: string }): Promise<void> {
  const skill = "netplay";
  const config = loadConfig();
  const t = target(config, "web");
  if (!t.out) throw new CliError("NO_OUT", "the web target needs an out dir", "", "export-web");
  if (!which("agent-browser")) throw new CliError("TOOL_MISSING", "agent-browser not found (play drives two browsers)", "npm i -g agent-browser && agent-browser install", skill);
  const frames = num("frames", args.frames, 600, 60);
  const name = room ?? `play-${Date.now().toString(36)}`;
  const outDir = resolve(process.cwd(), args.out ?? ".dotframe/play");
  await runSteps({ ...ctx, json: true }, config.root, t.steps ?? [], "export-web");
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
  const sessions = ["dotframe-play-0", "dotframe-play-1"];
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
      const url = `http://localhost:${server.port}/?room=${encodeURIComponent(name)}&relay=${encodeURIComponent(`ws://localhost:${relay.port}`)}&mash=${i + 1}`;
      const opened = await ab(session, "open", url);
      if (opened.code !== 0) throw new CliError("BROWSER_FAILED", opened.tail, "agent-browser install", skill);
    }
    let probes: (Probe | null)[] = [null, null];
    const started = Date.now();
    // Wait until both peers confirm `frames` frames, or stop making progress.
    let last = -1;
    let lastChange = Date.now();
    for (;;) {
      probes = [await read(sessions[0]), await read(sessions[1])];
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
    mkdirSync(outDir, { recursive: true });
    for (const [i, session] of sessions.entries()) {
      const shot = await ab(session, "screenshot", shots[i]);
      if (shot.code !== 0 || !existsSync(shots[i])) throw new CliError("BROWSER_FAILED", `screenshot of peer ${i} failed: ${shot.tail}`, "", skill);
    }
    const ok = mismatch === undefined && compared.length > 0;
    print(ctx, { ok, room: name, frames: Math.min(a.confirmed, b.confirmed), compared: compared.length, firstMismatch: mismatch ?? null, seconds: Math.round((Date.now() - started) / 1000), screenshots: shots }, (): string =>
      [
        ok ? `in sync: ${compared.length} checksums compared over ${Math.min(a.confirmed, b.confirmed)} confirmed frames` : mismatch !== undefined ? `DESYNC at frame ${mismatch}` : "no checksums to compare",
        `screenshots: ${shots.join(", ")} (open them and look)`,
      ].join("\n"),
    );
    if (!ok) process.exit(1);
  } finally {
    for (const session of sessions) await ab(session, "close");
    server.stop(true);
    relay.stop(true);
  }
}
