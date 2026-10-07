import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError, type Ctx, exec, loadConfig, num, print, which } from "../lib";
import { inputSource, loadSim, parseOptions, simPath } from "../simkit";
import type { PlayArgs } from "./play";

const ENGINE = resolve(import.meta.dir, "../../src");

// Renders frames with the real WebGPU renderer: bundles a page that steps the sim to each --frame with the given
// inputs, serves the game root, and screenshots it with agent-browser. --frame 90,330,900 shoots several frames of
// one run in one browser session (animation checks), writing --out with {frame} replaced, or -<frame> added.
export async function snap(ctx: Ctx, args: PlayArgs & { frame?: string; out?: string; camera?: string }): Promise<void> {
  const config = loadConfig();
  const sim = await loadSim(config);
  if (args.frame === undefined) throw new CliError("MISSING_ARG", "snap needs --frame <n>", "dotframe snap --frame 300 --mash 7");
  const frames = [...new Set(args.frame.split(",").map((f: string): number => num("frame", f.trim(), 0)))].sort((a: number, b: number): number => a - b);
  const frame = frames[frames.length - 1];
  const outFor = (f: number): string => {
    const pattern = args.out ?? "snap-{frame}.png";
    if (pattern.includes("{frame}")) return resolve(process.cwd(), pattern.replaceAll("{frame}", String(f)));
    if (frames.length === 1) return resolve(process.cwd(), pattern);
    return resolve(process.cwd(), pattern.replace(/(\.png)?$/, `-${f}.png`));
  };
  const seed = num("seed", args.seed, 1);
  const options = parseOptions(sim, args.options);
  const source = inputSource(sim, config.root, args.inputs, args.mash);
  // --camera ex,ey,ez,tx,ty,tz[,fov degrees]: a 3D game's camera for this snap (cameraOverride in src/render).
  let camera: { eye: number[]; target: number[]; fovY: number } | null = null;
  if (args.camera !== undefined) {
    const c = args.camera.split(",").map((v: string): number => Number(v.trim()));
    if ((c.length !== 6 && c.length !== 7) || c.some((v: number): boolean => !Number.isFinite(v))) throw new CliError("BAD_ARG", `--camera wants ex,ey,ez,tx,ty,tz[,fov], got ${args.camera}`, "dotframe snap --frame 300 --camera -2.5,1.6,-7.6,-2.5,1.3,-6.2,40");
    camera = { eye: c.slice(0, 3), target: c.slice(3, 6), fovY: ((c[6] ?? 60) * Math.PI) / 180 };
  }
  const inputs = Array.from({ length: frame }, (_: unknown, f: number): number[] => source.at(f));
  if (!which("agent-browser")) throw new CliError("TOOL_MISSING", "agent-browser not found (snap drives a real browser)", "npm i -g agent-browser && agent-browser install");

  // Outside the repo, so a snap never leaves files to commit.
  const work = mkdtempSync(join(tmpdir(), "dotframe-snap-"));
  const entry = join(work, "entry.ts");
  writeFileSync(
    entry,
    `import sim from ${JSON.stringify(simPath(config))};
import { createDraw2D } from ${JSON.stringify(join(ENGINE, "draw2d"))};
import { gpuErrors, loadBytes, run } from ${JSON.stringify(join(ENGINE, "web/run"))};
import { cameraOverride } from ${JSON.stringify(join(ENGINE, "render"))};
const plan = ${JSON.stringify({ seed, options, inputs, frames, camera })};
if (plan.camera) cameraOverride.camera = { eye: { x: plan.camera.eye[0], y: plan.camera.eye[1], z: plan.camera.eye[2] }, target: { x: plan.camera.target[0], y: plan.camera.target[1], z: plan.camera.target[2] }, fovY: plan.camera.fovY };
const done = (data) => { const el = document.createElement("pre"); el.id = data.error ? "dotframe-error" : "dotframe-ready"; el.style.display = "none"; el.textContent = JSON.stringify(data); document.body.appendChild(el); };
run(sim.window, (p) => {
  const draw = createDraw2D(p.gpu, sim.window.width, sim.window.height);
  const r = sim.create({ gpu: p.gpu, load: loadBytes, headless: false, draw, image: p.gpu.createImage });
  let ready = false;
  let shown = 0;
  let index = 0;
  let stepped = 0;
  const advance = () => {
    while (stepped < plan.frames[index]) r.step(plan.inputs[stepped++]);
    shown = 0;
    ready = true;
  };
  // The CLI calls this after each screenshot: drop the marker and step on to the next frame.
  window.__dotframeNext = () => {
    document.getElementById("dotframe-ready")?.remove();
    index++;
    advance();
  };
  r.ready.then(() => {
    r.start(plan.seed, plan.options);
    advance();
  }).catch((e) => done({ error: String(e) }));
  return () => {
    draw.begin();
    if (ready && r.render) r.render(draw);
    draw.end(sim.clear ?? { r: 0, g: 0, b: 0 });
    if (ready && ++shown === 3) done(gpuErrors.length > 0 ? { error: gpuErrors.join("\\n") } : { index, frame: stepped, checksum: r.checksum(), state: r.state() });
    return true;
  };
}).catch((e) => done({ error: String(e) }));
`,
  );
  const built = await Bun.build({ entrypoints: [entry], target: "browser" });
  if (!built.success) throw new CliError("SNAP_BUILD_FAILED", built.logs.map(String).join("\n"), "the sim module must bundle for the browser");
  const bundle = await built.outputs[0].text();
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}</style><body><script type="module" src="/__dotframe/snap.js"></script>`;
  const server = Bun.serve({
    port: 0,
    fetch: (req: Request): Response => {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
      if (path === "/__dotframe/snap.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      const file = join(config.root, path);
      return existsSync(file) ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
    },
  });
  // One session per run: reusing a fixed name raced the previous run's close, and the next snap never loaded (F-012).
  const session = `dotframe-snap-${process.pid}`;
  const ab = (...a: string[]) => exec({ ...ctx, json: true }, config.root, { label: `agent-browser ${a[0]}`, argv: ["agent-browser", "--session", session, ...a] });
  try {
    const opened = await ab("open", `http://localhost:${server.port}/`);
    if (opened.code !== 0) throw new CliError("BROWSER_FAILED", opened.tail, "agent-browser install");
    // After open: agent-browser's daemon is shared, and a viewport set before open can be lost to another session.
    await ab("set", "viewport", String(sim.window.width), String(sim.window.height));
    const shots: { out: string; frame?: number; checksum?: number; state?: unknown }[] = [];
    for (let k = 0; k < frames.length; k++) {
      if (k > 0) await ab("eval", "window.__dotframeNext()");
      const out = outFor(frames[k]);
      // Loading plus stepping can take a while for long inputs; poll for the marker of this frame.
      let result: { index?: number; frame?: number; checksum?: number; state?: unknown; error?: string } | null = null;
      for (let i = 0; i < 120 && !result; i++) {
        const r = await ab("eval", `(document.getElementById("dotframe-ready") || document.getElementById("dotframe-error") || {}).textContent || ""`);
        // eval prints the string JSON-quoted; decode it whole, since the payload can hold quotes and newlines.
        const raw = r.tail.trim();
        let text = raw;
        try {
          if (raw.startsWith('"')) text = JSON.parse(raw) as string;
        } catch {}
        const parsed = text.startsWith("{") ? JSON.parse(text) : null;
        if (parsed && (parsed.error || parsed.index === k)) result = parsed;
        else await Bun.sleep(500);
      }
      if (!result) {
        const logs = [(await ab("errors")).tail, (await ab("console")).tail].filter(Boolean).join("\n").slice(-1500);
        throw new CliError("SNAP_TIMEOUT", `the page never reported frame ${frames[k]} after 60 s${logs ? `\n${logs}` : ""}`, "open the page with agent-browser --headed and read the console; WebGPU may be unavailable", "core");
      }
      if (result.error) throw new CliError("SNAP_PAGE_ERROR", result.error, /WGSL|WebGPU:/.test(result.error) ? "fix the shader named in the message; the frame would render black" : "WebGPU unavailable? try AGENT_BROWSER_ARGS=--enable-unsafe-webgpu", "core");
      let shot = await ab("screenshot", out);
      if (shot.code !== 0) throw new CliError("BROWSER_FAILED", shot.tail);
      let size = pngSize(out);
      if (!matches(size, sim.window)) {
        await ab("set", "viewport", String(sim.window.width), String(sim.window.height));
        shot = await ab("screenshot", out);
        size = pngSize(out);
      }
      if (!matches(size, sim.window)) {
        throw new CliError("SNAP_SIZE", `screenshot is ${size.width}x${size.height}, expected ${sim.window.width}x${sim.window.height} (or a device-pixel multiple)`, "close other agent-browser sessions and retry; check agent-browser session list", "core");
      }
      shots.push({ out, frame: result.frame, checksum: result.checksum, state: result.state });
    }
    const last = shots[shots.length - 1];
    // One frame keeps the original shape; several add a shots list.
    const data = frames.length === 1 ? last : { ...last, shots };
    print(ctx, data, (): string => shots.map((x) => `frame ${x.frame} -> ${x.out} (checksum ${x.checksum})`).join("\n"));
  } finally {
    await ab("close");
    server.stop(true);
    rmSync(work, { recursive: true, force: true });
  }
}

// Width and height from a PNG's IHDR chunk.
function pngSize(path: string): { width: number; height: number } {
  const head = readFileSync(path).subarray(16, 24);
  return { width: head.readUInt32BE(0), height: head.readUInt32BE(4) };
}

function matches(size: { width: number; height: number }, window: { width: number; height: number }): boolean {
  const scale = size.width / window.width;
  return Number.isInteger(scale) && scale >= 1 && size.height === window.height * scale;
}
