import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, type Ctx, exec, loadConfig, print, which } from "../lib";
import { inputSource, loadSim, parseOptions, simPath } from "../simkit";
import type { PlayArgs } from "./play";

const ENGINE = resolve(import.meta.dir, "../../src");

// Renders one frame with the real WebGPU renderer: bundles a page that steps the sim to --frame with the given
// inputs, serves the game root, and screenshots it with agent-browser.
export async function snap(ctx: Ctx, args: PlayArgs & { frame?: string; out?: string }): Promise<void> {
  const config = loadConfig();
  const sim = await loadSim(config);
  const frame = Number(args.frame ?? "0");
  const out = resolve(process.cwd(), args.out ?? `snap-${frame}.png`);
  const seed = Number(args.seed ?? "1");
  const options = parseOptions(sim, args.options);
  const source = inputSource(sim, config.root, args.inputs, args.mash);
  const inputs = Array.from({ length: frame }, (_: unknown, f: number): number[] => source.at(f));
  if (!which("agent-browser")) throw new CliError("TOOL_MISSING", "agent-browser not found (snap drives a real browser)", "npm i -g agent-browser && agent-browser install");

  const work = join(config.root, ".dotframe", "snap");
  mkdirSync(work, { recursive: true });
  const entry = join(work, "entry.ts");
  writeFileSync(
    entry,
    `import sim from ${JSON.stringify(simPath(config))};
import { createDraw2D } from ${JSON.stringify(join(ENGINE, "draw2d"))};
import { loadBytes, run } from ${JSON.stringify(join(ENGINE, "web/run"))};
const plan = ${JSON.stringify({ seed, options, inputs })};
const done = (data) => { const el = document.createElement("pre"); el.id = data.error ? "dotframe-error" : "dotframe-ready"; el.style.display = "none"; el.textContent = JSON.stringify(data); document.body.appendChild(el); };
run(sim.window, (p) => {
  const draw = createDraw2D(p.gpu, sim.window.width, sim.window.height);
  const r = sim.create({ gpu: p.gpu, load: loadBytes, headless: false, draw });
  let ready = false;
  let shown = 0;
  r.ready.then(() => {
    r.start(plan.seed, plan.options);
    for (const i of plan.inputs) r.step(i);
    ready = true;
  }).catch((e) => done({ error: String(e) }));
  return () => {
    draw.begin();
    if (ready && r.render) r.render(draw);
    draw.end({ r: 0, g: 0, b: 0 });
    if (ready && ++shown === 3) done({ frame: plan.inputs.length, checksum: r.checksum(), state: r.state() });
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
  const ab = (...a: string[]) => exec({ ...ctx, json: true }, config.root, { label: `agent-browser ${a[0]}`, argv: ["agent-browser", "--session", "dotframe-snap", ...a] });
  try {
    await ab("set", "viewport", String(sim.window.width), String(sim.window.height));
    const opened = await ab("open", `http://localhost:${server.port}/`);
    if (opened.code !== 0) throw new CliError("BROWSER_FAILED", opened.tail, "agent-browser install");
    // Loading plus stepping can take a while for long inputs; poll for the marker.
    let result: { frame?: number; checksum?: number; state?: unknown; error?: string } | null = null;
    for (let i = 0; i < 120 && !result; i++) {
      const r = await ab("eval", `(document.getElementById("dotframe-ready") || document.getElementById("dotframe-error") || {}).textContent || ""`);
      const text = r.tail.trim().replace(/^"|"$/g, "").replace(/\\"/g, '"');
      if (text.startsWith("{")) result = JSON.parse(text);
      else await Bun.sleep(500);
    }
    if (!result) throw new CliError("SNAP_TIMEOUT", "the page never reported ready after 60 s", "open the page with agent-browser --headed and read the console; WebGPU may be unavailable", "core");
    if (result.error) throw new CliError("SNAP_PAGE_ERROR", result.error, "WebGPU unavailable? try AGENT_BROWSER_ARGS=--enable-unsafe-webgpu", "core");
    const shot = await ab("screenshot", out);
    if (shot.code !== 0) throw new CliError("BROWSER_FAILED", shot.tail);
    print(ctx, { out, ...result }, (): string => `frame ${result?.frame} -> ${out} (checksum ${result?.checksum})`);
  } finally {
    await ab("close");
    server.stop(true);
  }
}
