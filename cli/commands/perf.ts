import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError, type Ctx, exec, loadConfig, num, print, which } from "../lib";
import { inputSource, loadSim, parseOptions, simPath } from "../simkit";
import type { PlayArgs } from "./play";

const ENGINE = resolve(import.meta.dir, "../../src");

export interface PerfReport {
  // Milliseconds from navigation to the sim's ready promise, and to the first rendered frame after it.
  load: { readyMs: number; firstFrameMs: number; bytes: number; files: number };
  frames: number;
  // Per rendered frame: requestAnimationFrame interval (what the player feels, GPU included when it is the
  // bottleneck), and the CPU time of step and of render plus submit.
  interval: Stats;
  step: Stats;
  render: Stats;
  // Frames whose interval passed 50 ms (three missed vsyncs): their index after --frame and the interval.
  hitches: { frame: number; ms: number }[];
}

export interface Stats {
  p50: number;
  p95: number;
  max: number;
}

export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a: number, b: number): number => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (x: number): number => Math.round(x * 100) / 100;
  return { p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1] ?? 0) };
}

// Load time and frame time in a real browser: the game served from its root like snap, stepped to --frame, then
// --frames frames rendered one sim step each, timed. Numbers are this machine's; a phone needs its own run.
export async function perf(ctx: Ctx, args: PlayArgs & { frame?: string; camera?: string }): Promise<void> {
  const config = loadConfig();
  const sim = await loadSim(config);
  const from = num("frame", args.frame ?? "0", 0);
  const count = num("frames", args.frames ?? "300", 1);
  const seed = num("seed", args.seed, 1);
  const options = parseOptions(sim, args.options);
  const source = inputSource(sim, config.root, args.inputs, args.mash);
  let camera: number[] | null = null;
  if (args.camera !== undefined) {
    camera = args.camera.split(",").map((v: string): number => Number(v.trim()));
    if ((camera.length !== 6 && camera.length !== 7) || camera.some((v: number): boolean => !Number.isFinite(v))) throw new CliError("BAD_ARG", `--camera wants ex,ey,ez,tx,ty,tz[,fov], got ${args.camera}`);
  }
  const inputs = Array.from({ length: from + count }, (_: unknown, f: number): number[] => source.at(f));
  if (!which("agent-browser")) throw new CliError("TOOL_MISSING", "agent-browser not found (perf drives a real browser)", "npm i -g agent-browser && agent-browser install");

  const work = mkdtempSync(join(tmpdir(), "dotframe-perf-"));
  const entry = join(work, "entry.ts");
  writeFileSync(
    entry,
    `import sim from ${JSON.stringify(simPath(config))};
import { createDraw2D } from ${JSON.stringify(join(ENGINE, "draw2d"))};
import { gpuErrors, loadBytes, run } from ${JSON.stringify(join(ENGINE, "web/run"))};
import { cameraOverride } from ${JSON.stringify(join(ENGINE, "render"))};
const plan = ${JSON.stringify({ seed, options, inputs, from, count, camera })};
if (plan.camera) { const c = plan.camera; cameraOverride.camera = { eye: { x: c[0], y: c[1], z: c[2] }, target: { x: c[3], y: c[4], z: c[5] }, fovY: ((c[6] ?? 60) * Math.PI) / 180 }; }
const done = (data) => { const el = document.createElement("pre"); el.id = data.error ? "dotframe-error" : "dotframe-ready"; el.style.display = "none"; el.textContent = JSON.stringify(data); document.body.appendChild(el); };
run(sim.window, (p) => {
  const draw = createDraw2D(p.gpu, sim.window.width, sim.window.height);
  const r = sim.create({ gpu: p.gpu, load: loadBytes, headless: false, draw, image: p.gpu.createImage });
  let readyMs = -1;
  let firstFrameMs = -1;
  let stepped = 0;
  let last = -1;
  const interval = [], step = [], render = [];
  r.ready.then(() => {
    readyMs = performance.now();
    r.start(plan.seed, plan.options);
    while (stepped < plan.from) r.step(plan.inputs[stepped++]);
  }).catch((e) => done({ error: String(e) }));
  return () => {
    if (readyMs < 0) return true;
    const now = performance.now();
    let s = 0;
    if (firstFrameMs >= 0) {
      const t = performance.now();
      r.step(plan.inputs[stepped++]);
      s = performance.now() - t;
    }
    const t = performance.now();
    draw.begin();
    if (r.render) r.render(draw);
    draw.end(sim.clear ?? { r: 0, g: 0, b: 0 });
    const d = performance.now() - t;
    if (firstFrameMs < 0) { firstFrameMs = performance.now(); last = now; return true; }
    interval.push(now - last);
    last = now;
    step.push(s);
    render.push(d);
    if (interval.length < plan.count) return true;
    const files = performance.getEntriesByType("resource");
    const bytes = files.reduce((n, e) => n + (e.encodedBodySize || 0), 0);
    done(gpuErrors.length > 0 ? { error: gpuErrors.join("\\n") } : { readyMs, firstFrameMs, bytes, files: files.length, interval, step, render });
    return false;
  };
}).catch((e) => done({ error: String(e) }));
`,
  );
  const built = await Bun.build({ entrypoints: [entry], target: "browser" });
  if (!built.success) throw new CliError("PERF_BUILD_FAILED", built.logs.map(String).join("\n"));
  const bundle = await built.outputs[0].text();
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}</style><body><script type="module" src="/__dotframe/perf.js"></script>`;
  const server = Bun.serve({
    port: 0,
    fetch: (req: Request): Response => {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
      if (path === "/__dotframe/perf.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      const file = Bun.file(join(config.root, path));
      return new Response(file);
    },
    error: (): Response => new Response("not found", { status: 404 }),
  });
  const session = `dotframe-perf-${process.pid}`;
  const ab = (...a: string[]) => exec({ ...ctx, json: true }, config.root, { label: `agent-browser ${a[0]}`, argv: ["agent-browser", "--session", session, ...a] });
  try {
    const opened = await ab("open", `http://localhost:${server.port}/`);
    if (opened.code !== 0) throw new CliError("BROWSER_FAILED", opened.tail, "agent-browser install");
    await ab("set", "viewport", String(sim.window.width), String(sim.window.height));
    let result: { error?: string; readyMs: number; firstFrameMs: number; bytes: number; files: number; interval: number[]; step: number[]; render: number[] } | null = null;
    for (let i = 0; i < 240 && !result; i++) {
      const r = await ab("eval", `(document.getElementById("dotframe-ready") || document.getElementById("dotframe-error") || {}).textContent || ""`);
      const raw = r.tail.trim();
      let text = raw;
      try {
        if (raw.startsWith('"')) text = JSON.parse(raw) as string;
      } catch {}
      if (text.startsWith("{")) result = JSON.parse(text);
      else await Bun.sleep(500);
    }
    if (!result) throw new CliError("PERF_TIMEOUT", "the page never finished after 120 s", "open the page with agent-browser --headed and read the console");
    if (result.error) throw new CliError("PERF_PAGE_ERROR", result.error);
    const report: PerfReport = {
      load: { readyMs: Math.round(result.readyMs), firstFrameMs: Math.round(result.firstFrameMs), bytes: result.bytes, files: result.files },
      frames: result.interval.length,
      interval: stats(result.interval),
      step: stats(result.step),
      render: stats(result.render),
      hitches: result.interval.flatMap((ms: number, i: number): { frame: number; ms: number }[] => (ms > 50 ? [{ frame: i, ms: Math.round(ms) }] : [])),
    };
    print(ctx, report, (): string => {
      const line = (name: string, s: Stats): string => `${name.padEnd(9)} p50 ${s.p50} ms  p95 ${s.p95} ms  max ${s.max} ms`;
      return [
        `load      ready ${report.load.readyMs} ms, first frame ${report.load.firstFrameMs} ms, ${(report.load.bytes / 1e6).toFixed(1)} MB in ${report.load.files} files (local server)`,
        line("interval", report.interval),
        line("step", report.step),
        line("render", report.render),
        `${report.frames} frames from frame ${from}${report.hitches.length ? `; hitches over 50 ms: ${report.hitches.map((h) => `#${h.frame} ${h.ms} ms`).join(", ")}` : ""}`,
      ].join("\n");
    });
  } finally {
    await ab("close");
    server.stop(true);
    rmSync(work, { recursive: true, force: true });
  }
}
